const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Readable } = require('stream');
const { ObjectId } = require('mongodb');
const { applicationUpload } = require('../middleware/uploadConfig');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getBucket } = require('../utils/gridfs');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');
const { findScholarship } = require('../data/scholarships');
const { officeFilter, scopedOffice } = require('../utils/officeScope');
const {
  isGrantFormType,
  parseGrantSections,
  checkEligibility,
  checkCertifications,
  missingDocumentSlots,
  parseDocumentMeta,
} = require('../utils/grantForms');

const ALLOWED_STATUSES = ['Under Evaluation', 'Approved', 'Rejected', 'Needs Revision'];

// Accept up to 25 files under the same field name "documents", plus a
// parallel JSON array "documentLabels" telling us which requirement
// each file corresponds to (e.g. ["Application Letter", "Indigency", ...]).
// This matches your frontend's dynamic scholarship.requirements list
// instead of hardcoding fixed field names. (Was 8 — the POLCA flow has 12
// upload slots, one of which takes several residence pictures.) Grant-form
// flows also send "documentMeta" ([{ slotKey, variant? }], same order).
const MAX_DOCUMENT_FILES = 25;
const uploadDocs = applicationUpload.array('documents', MAX_DOCUMENT_FILES);

// Office-internal fields never leave the server on student-facing routes.
const STUDENT_HIDDEN_FIELDS = '-adminFields';

function toStudentView(application) {
  const obj = application.toObject ? application.toObject() : { ...application };
  delete obj.adminFields;
  return obj;
}

// Streams every file into GridFS (MongoDB Atlas). If any single upload
// fails partway through, the ones that already succeeded are deleted so
// no orphaned files are left behind, and the error is rethrown.
async function storeFilesInGridFS(files, labels, meta = []) {
  const bucket = getBucket();
  const uploadedFileIds = [];
  try {
    return await Promise.all(
      files.map(
        (file, idx) =>
          new Promise((resolve, reject) => {
            const uploadStream = bucket.openUploadStream(file.originalname, {
              metadata: { docType: labels[idx], mimetype: file.mimetype },
            });
            uploadedFileIds.push(uploadStream.id);
            Readable.from(file.buffer)
              .pipe(uploadStream)
              .on('error', reject)
              .on('finish', () => {
                resolve({
                  docType: labels[idx],
                  slotKey: meta[idx]?.slotKey,
                  variant: meta[idx]?.variant,
                  fileId: uploadStream.id,
                  filename: file.originalname,
                  mimetype: file.mimetype,
                  size: file.size,
                });
              });
          })
      )
    );
  } catch (uploadErr) {
    await Promise.allSettled(uploadedFileIds.map(id => bucket.delete(id)));
    throw uploadErr;
  }
}

// Validates a grant-form (POLCA / Alumni) submission before anything is
// written. `presentSlotKeys` is every slot that will have a file once this
// request is applied. Returns { sections } or { error }.
function validateGrantSubmission(scholarship, body, presentSlotKeys) {
  const { sections, error } = parseGrantSections(body, scholarship.formType);
  if (error) return { error };

  const problems = [
    ...checkEligibility(scholarship, sections),
    ...checkCertifications(scholarship.formType, sections),
  ];
  if (problems.length) return { error: problems.join(' ') };

  const missing = missingDocumentSlots(scholarship, sections, presentSlotKeys);
  if (missing.length) {
    return { error: `Please upload all required documents. Missing: ${missing.join(', ')}.` };
  }
  return { sections };
}

router.post('/', (req, res) => {
  uploadDocs(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Each file must be under 10MB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const {
        studentNumber,
        scholarshipId,
        applicationFormType,
        standardInfo,
        personalInfo,
        contactSchool,
        parentsGuardian,
        siblings,
        assetsExpenses,
        agreement,
        documentLabels,
        documentMeta,
      } = req.body;

      if (!studentNumber || !scholarshipId) {
        return res.status(400).json({ error: 'Missing student number or scholarship reference.' });
      }

      // Name, office and (for grant forms) form type come from the
      // registry, never from the client.
      const scholarship = findScholarship(scholarshipId);
      if (!scholarship) {
        return res.status(400).json({ error: 'Unknown scholarship.' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Please upload all required documents.' });
      }

      let labels;
      try {
        labels = JSON.parse(documentLabels || '[]');
      } catch {
        return res.status(400).json({ error: 'Invalid document labels format.' });
      }

      if (labels.length !== req.files.length) {
        return res.status(400).json({ error: 'Document count does not match label count.' });
      }

      const isGrant = isGrantFormType(scholarship.formType);
      const formType = isGrant ? scholarship.formType : (applicationFormType || 'standard');

      // Grant forms are fully validated up front so a rejected submission
      // never leaves files behind in GridFS.
      let meta = [];
      let grantSections;
      if (isGrant) {
        const parsedMeta = parseDocumentMeta(documentMeta, req.files.length);
        if (parsedMeta.error) return res.status(400).json({ error: parsedMeta.error });
        meta = parsedMeta.meta;
        const presentSlotKeys = new Set(meta.map(m => m.slotKey).filter(Boolean));
        const result = validateGrantSubmission(scholarship, req.body, presentSlotKeys);
        if (result.error) return res.status(400).json({ error: result.error });
        grantSections = result.sections;
      }

      let documents;
      try {
        documents = await storeFilesInGridFS(req.files, labels, meta);
      } catch (uploadErr) {
        console.error('GridFS upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
      }

      const applicationData = {
        studentNumber,
        scholarshipId,
        scholarshipName: scholarship.name,
        office: scholarship.office,
        applicationFormType: formType,
        documents,
        referenceCode: `${scholarship.referencePrefix || 'DLSU-D'}-${Math.floor(Math.random() * 900000 + 100000)}`,
        // First lifecycle event. changedBy is always 'student' here since
        // this route only ever runs for the applicant's own submission.
        history: [{ status: 'Submitted', changedBy: 'student', changedAt: new Date() }],
      };

      if (isGrant) {
        Object.assign(applicationData, grantSections);
      } else if (formType === 'sfag') {
        if (!personalInfo || !contactSchool || !parentsGuardian || !assetsExpenses || !agreement) {
          return res.status(400).json({ error: 'Missing required SFAG form sections.' });
        }
        applicationData.personalInfo = JSON.parse(personalInfo);
        applicationData.contactSchool = JSON.parse(contactSchool);
        applicationData.parentsGuardian = JSON.parse(parentsGuardian);
        applicationData.siblings = siblings ? JSON.parse(siblings) : [];
        applicationData.assetsExpenses = JSON.parse(assetsExpenses);
        applicationData.agreement = JSON.parse(agreement);
      } else {
        if (!standardInfo) {
          return res.status(400).json({ error: 'Missing personal/academic profile.' });
        }
        applicationData.standardInfo = JSON.parse(standardInfo);
      }

      const application = await Application.create(applicationData);

      // The saved-for-later draft (routes/applicationDrafts.js) has done its
      // job once the real application exists.
      await ApplicationDraft.deleteOne({ studentNumber, scholarshipId }).catch(() => {});

      res.status(201).json({
        message: 'Application submitted successfully.',
        application: toStudentView(application),
      });
    } catch (err) {
      console.error('Application submit error:', err);
      res.status(500).json({ error: 'Failed to save application. Please check your submitted data.' });
    }
  });
});

// PATCH /api/applications/:id — student-facing resubmission after a
// "Needs Revision" verdict from the LSO. Unlike POST (create), this
// MERGES onto an existing document: any requirement whose docType isn't
// present in this request's uploaded files keeps its previously-stored
// file (see mergedDocs below) — the frontend only sends files for
// requirements the student chose to replace. Also resets status back to
// 'Under Evaluation' and clears any prior reviewNote/reviewedBy/reviewedAt
// so the LSO sees it as freshly awaiting review.
//
// NOTE ON AUTH: this currently checks ownership by comparing
// req.body.studentNumber against the stored studentNumber, which is
// spoofable by anyone crafting the multipart body themselves. Your POST /
// route's comment says studentNumber for creation is "taken from the
// authenticated Student record server-side, never from req.body" — this
// route should get the same treatment (pull studentNumber from whatever
// auth/session middleware you use, e.g. req.auth.studentNumber, instead
// of trusting the body) before this goes to production. Left as a
// same-shape placeholder here since I don't have your auth middleware's
// exact shape.
router.patch('/:id', (req, res) => {
  uploadDocs(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Each file must be under 10MB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      let objectId;
      try {
        objectId = new ObjectId(req.params.id);
      } catch {
        return res.status(400).json({ error: 'Invalid application id.' });
      }

      const existing = await Application.findById(objectId);
      if (!existing) {
        return res.status(404).json({ error: 'Application not found.' });
      }

      // See NOTE ON AUTH above — replace with your real auth-derived
      // studentNumber once wired up.
      if (req.body.studentNumber && existing.studentNumber !== req.body.studentNumber) {
        return res.status(403).json({ error: 'Not authorized to edit this application.' });
      }

      const {
        applicationFormType,
        standardInfo,
        personalInfo,
        contactSchool,
        parentsGuardian,
        siblings,
        assetsExpenses,
        agreement,
        documentLabels,
        documentMeta,
      } = req.body;

      let labels;
      try {
        labels = JSON.parse(documentLabels || '[]');
      } catch {
        return res.status(400).json({ error: 'Invalid document labels format.' });
      }

      const files = req.files || [];
      if (labels.length !== files.length) {
        return res.status(400).json({ error: 'Document count does not match label count.' });
      }

      // A grant-form application stays a grant-form application; its type
      // can't be switched by the resubmission body.
      const isGrant = isGrantFormType(existing.applicationFormType);
      let meta = [];
      let grantSections;
      if (isGrant) {
        const scholarship = findScholarship(existing.scholarshipId);
        if (!scholarship) {
          return res.status(400).json({ error: 'Unknown scholarship.' });
        }
        const parsedMeta = parseDocumentMeta(documentMeta, files.length);
        if (parsedMeta.error) return res.status(400).json({ error: parsedMeta.error });
        meta = parsedMeta.meta;
        const presentSlotKeys = new Set([
          ...existing.documents.map(d => d.slotKey),
          ...meta.map(m => m.slotKey),
        ].filter(Boolean));
        const result = validateGrantSubmission(scholarship, req.body, presentSlotKeys);
        if (result.error) return res.status(400).json({ error: result.error });
        grantSections = result.sections;
      }

      // Upload any newly-selected replacement files into GridFS, same as POST.
      let newDocs = [];
      try {
        newDocs = await storeFilesInGridFS(files, labels, meta);
      } catch (uploadErr) {
        console.error('GridFS upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
      }

      // Keep whatever was already on file for any requirement NOT
      // re-uploaded this time around; swap in the new file(s) for anything
      // that was. Grant-form documents are matched by slotKey (a slot can
      // hold several files), everything else by docType.
      const docKey = d => d.slotKey || d.docType;
      const replacedKeys = new Set(newDocs.map(docKey));
      const mergedDocs = [
        ...existing.documents.filter(d => !replacedKeys.has(docKey(d))),
        ...newDocs,
      ];
      existing.documents = mergedDocs;

      const formType = isGrant ? existing.applicationFormType : (applicationFormType || existing.applicationFormType);
      existing.applicationFormType = formType;

      if (isGrant) {
        Object.assign(existing, grantSections);
      } else if (formType === 'sfag') {
        if (personalInfo) existing.personalInfo = JSON.parse(personalInfo);
        if (contactSchool) existing.contactSchool = JSON.parse(contactSchool);
        if (parentsGuardian) existing.parentsGuardian = JSON.parse(parentsGuardian);
        if (siblings) existing.siblings = JSON.parse(siblings);
        if (assetsExpenses) existing.assetsExpenses = JSON.parse(assetsExpenses);
        if (agreement) existing.agreement = JSON.parse(agreement);
      } else if (standardInfo) {
        existing.standardInfo = JSON.parse(standardInfo);
      }

      existing.status = 'Under Evaluation';
      // Deliberately NOT clearing reviewNote/reviewedBy/reviewedAt here.
      // The whole point of "Needs Revision" is the student sees what was
      // flagged and fixes it — wiping the note the instant they resubmit
      // means the admin reviewing the resubmission loses the context for
      // why it came back around, and the student's own read of what they
      // fixed disappears too. It now stays on the record as the most
      // recent LSO note until the admin issues a new verdict (Approved /
      // Rejected / Needs Revision again), which naturally overwrites it
      // via the PATCH /:id/status route below.

      // Log the resubmission as its own lifecycle event, distinct from the
      // original 'Submitted' entry, so the timeline/analytics can tell
      // "first submitted" apart from "sent back and resubmitted" — and so
      // avg-processing-time / revision-cycle math elsewhere has a real
      // timestamp for when the student actually responded to the
      // Needs Revision verdict rather than only having the verdict itself.
      if (!Array.isArray(existing.history)) existing.history = [];
      existing.history.push({ status: 'Resubmitted', changedBy: 'student', changedAt: new Date() });

      await existing.save();

      res.json({
        message: 'Application resubmitted successfully.',
        application: toStudentView(existing),
      });
    } catch (err) {
      console.error('Application resubmit error:', err);
      res.status(500).json({ error: 'Failed to save resubmission. Please check your submitted data.' });
    }
  });
});

// GET a student's applications, by student number
router.get('/student/:studentNumber', async (req, res) => {
  try {
    const applications = await Application.find({ studentNumber: req.params.studentNumber })
      .select(STUDENT_HIDDEN_FIELDS)
      .sort({ createdAt: -1 });
    res.json({ applications });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications.' });
  }
});

// GET /api/applications/export/scholars — admin-only. Builds the scholar
// lifecycle CSV entirely server-side via aggregation, so exporting doesn't
// require pulling every application down to the browser first. Accepts the
// same filter/sort semantics as the AdminScholars UI (search, renewal,
// sort) so "export what I'm looking at" stays true even as the dataset
// grows into the thousands.
//
// IMPORTANT: this route must be registered BEFORE router.get('/:id') below,
// otherwise Express will match "/export/scholars" against the ":id" param
// route first and try to parse "export" as an ObjectId.
router.get('/export/scholars', requireAdmin, async (req, res) => {
  try {
    const { search = '', renewal = 'all', sort = 'recent' } = req.query;

    const pipeline = [
      // Office-scoped admins (e.g. POLCA) only export their own office.
      { $match: officeFilter(req.adminUser) },
      // Group applications by student first — everything downstream
      // (renewing/first-time, latest status, counts) is a property of the
      // student, not any single application.
      {
        $group: {
          _id: '$studentNumber',
          applications: { $push: '$$ROOT' },
          totalApplications: { $sum: 1 },
          approvedCount: { $sum: { $cond: [{ $eq: ['$status', 'Approved'] }, 1, 0] } },
          rejectedCount: { $sum: { $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0] } },
          latestCreatedAt: { $max: '$createdAt' },
          firstSubmission: { $min: '$createdAt' },
        },
      },
      {
        $addFields: {
          isRenewing: { $gt: ['$totalApplications', 1] },
          // Pull the single most recent application out of the pushed
          // array to read name/status/program off of, same as
          // buildScholarSummaries did client-side with `latest`.
          // NOTE: $sortArray requires MongoDB 5.2+. If you're on an older
          // server, replace this block — see comment further down.
          latestApplication: {
            $arrayElemAt: [
              {
                $sortArray: {
                  input: '$applications',
                  sortBy: { createdAt: -1 },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $lookup: {
          from: 'students',
          localField: '_id',
          foreignField: 'studentNumber',
          as: 'studentRecord',
        },
      },
      { $unwind: { path: '$studentRecord', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          studentNumber: '$_id',
          name: {
            $cond: [
              { $in: ['$latestApplication.applicationFormType', ['sfag', 'polca', 'alumni']] },
              {
                $concat: [
                  { $ifNull: ['$latestApplication.personalInfo.firstName', ''] },
                  ' ',
                  { $ifNull: ['$latestApplication.personalInfo.lastName', ''] },
                ],
              },
              {
                $concat: [
                  { $ifNull: ['$latestApplication.standardInfo.firstName', ''] },
                  ' ',
                  { $ifNull: ['$latestApplication.standardInfo.lastName', ''] },
                ],
              },
            ],
          },
          email: {
            $cond: [
              { $in: ['$latestApplication.applicationFormType', ['sfag', 'polca', 'alumni']] },
              // Grant forms keep email with the student data instead.
              { $ifNull: ['$latestApplication.contactSchool.email', '$latestApplication.personalInfo.email'] },
              '$latestApplication.standardInfo.email',
            ],
          },
          phone: {
            $cond: [
              { $in: ['$latestApplication.applicationFormType', ['sfag', 'polca', 'alumni']] },
              '$latestApplication.contactSchool.mobileNo',
              '$latestApplication.standardInfo.phone',
            ],
          },
          program: {
            $cond: [
              { $in: ['$latestApplication.applicationFormType', ['sfag', 'polca', 'alumni']] },
              '$latestApplication.personalInfo.course',
              '$latestApplication.standardInfo.program',
            ],
          },
          yearLevel: {
            $cond: [
              { $in: ['$latestApplication.applicationFormType', ['sfag', 'polca', 'alumni']] },
              '$latestApplication.personalInfo.yearLevel',
              '$latestApplication.standardInfo.yearLevel',
            ],
          },
          latestStatus: '$latestApplication.status',
        },
      },
    ];

    // Search filter — name, student number, or program, same fields the
    // UI's search box matches on. Applied after the $addFields above since
    // it needs `name`/`program` computed first.
    if (search && String(search).trim()) {
      const q = String(search).trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      pipeline.push({
        $match: {
          $or: [
            { name: regex },
            { studentNumber: regex },
            { program: regex },
          ],
        },
      });
    }

    if (renewal === 'renewing') pipeline.push({ $match: { isRenewing: true } });
    if (renewal === 'first_time') pipeline.push({ $match: { isRenewing: false } });

    if (sort === 'most_applications') {
      pipeline.push({ $sort: { totalApplications: -1 } });
    } else if (sort === 'name') {
      pipeline.push({ $sort: { name: 1 } });
    } else {
      pipeline.push({ $sort: { latestCreatedAt: -1 } });
    }

    pipeline.push({
      $project: {
        _id: 0,
        studentNumber: 1,
        name: 1,
        email: 1,
        phone: 1,
        program: 1,
        yearLevel: 1,
        totalApplications: 1,
        approvedCount: 1,
        rejectedCount: 1,
        latestStatus: 1,
        isRenewing: 1,
        firstSubmission: 1,
      },
    });

        const scholars = await Application.aggregate(pipeline);

    // Build the CSV the same way as before — quoted fields, UTF-8 BOM for
    // Excel, CRLF line endings — but now only include the columns the
    // admin actually picked, via a registry so both "which fields exist"
    // and "how to compute each one" live in one place.
    const csvField = (value) => {
      const str = String(value ?? '');
      return `"${str.replace(/"/g, '""')}"`;
    };
    const formatDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    };

    // Keys MUST match EXPORT_COLUMNS' keys in AdminScholars.tsx exactly,
    // since the frontend sends these as the ?columns= query param.
    const COLUMN_REGISTRY = {
      studentNumber: { label: 'Student Number', getValue: (s) => s.studentNumber },
      name: { label: 'Name', getValue: (s) => (s.name || '').trim() || 'Unknown Applicant' },
      email: { label: 'Email', getValue: (s) => s.email || '' },
      phone: { label: 'Phone', getValue: (s) => s.phone || '' },
      program: { label: 'Program', getValue: (s) => s.program || '' },
      yearLevel: { label: 'Year Level', getValue: (s) => s.yearLevel || '' },
      totalApplications: { label: 'Total Applications', getValue: (s) => s.totalApplications },
      approvedCount: { label: 'Approved', getValue: (s) => s.approvedCount },
      rejectedCount: { label: 'Rejected', getValue: (s) => s.rejectedCount },
      approvalRate: {
        label: 'Approval Rate',
        getValue: (s) => {
          const decided = s.approvedCount + s.rejectedCount;
          return decided > 0 ? `${((s.approvedCount / decided) * 100).toFixed(0)}%` : '—';
        },
      },
      latestStatus: { label: 'Current Status', getValue: (s) => s.latestStatus || '' },
      isRenewing: { label: 'Renewing', getValue: (s) => (s.isRenewing ? 'Yes' : 'No') },
      firstSubmission: { label: 'First Submission', getValue: (s) => formatDate(s.firstSubmission) },
    };
    const DEFAULT_COLUMNS = [
      'studentNumber', 'name', 'email', 'phone', 'program', 'yearLevel',
      'totalApplications', 'approvedCount', 'rejectedCount', 'latestStatus',
      'isRenewing', 'firstSubmission',
    ];

    // ?columns=studentNumber,name,program — comma-separated keys, in the
    // exact order the admin wants them. Unknown keys are silently dropped
    // rather than erroring, so a stale/bad param never breaks the export.
    // Falls back to every default column if the param is missing, empty,
    // or resolves to nothing valid.
    const requestedColumns = typeof req.query.columns === 'string' && req.query.columns.trim()
      ? req.query.columns.split(',').map((c) => c.trim()).filter((c) => COLUMN_REGISTRY[c])
      : [];
    const activeColumns = requestedColumns.length > 0 ? requestedColumns : DEFAULT_COLUMNS;

    const headers = activeColumns.map((key) => COLUMN_REGISTRY[key].label);
    const rows = scholars.map((s) =>
      activeColumns.map((key) => csvField(COLUMN_REGISTRY[key].getValue(s))).join(',')
    );

    const csv = '\uFEFF' + [headers.map(csvField).join(','), ...rows].join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scholars-export-${stamp}.csv"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error('Scholar export error:', err);
    res.status(500).json({ error: 'Failed to export scholars.' });
  }
});

// GET /api/applications/:id — fetch a single application in full. Added so
// fetchFullApplication (App.tsx) has a real endpoint to hit instead of
// 404ing and silently falling back to the list-endpoint summary.
router.get('/:id', async (req, res) => {
  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid application id.' });
    }

    const application = await Application.findById(objectId).select(STUDENT_HIDDEN_FIELDS);
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    res.json({ application });
  } catch (err) {
    console.error('Fetch single application error:', err);
    res.status(500).json({ error: 'Failed to fetch application.' });
  }
});

// GET /api/applications — admin-only. Returns every application across
// every scholarship, for the LSO admin dashboard's list/overview view.
// Supports optional ?status= and ?scholarshipId= query filters so the
// dashboard can also push filtering server-side later if the list grows
// large; for now the frontend filters client-side over this full set.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const filter = { ...officeFilter(req.adminUser) };
    if (req.query.status && ALLOWED_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.scholarshipId) {
      filter.scholarshipId = req.query.scholarshipId;
    }

    const applications = await Application.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'students',
          localField: 'studentNumber',
          foreignField: 'studentNumber',
          as: 'studentRecord',
        },
      },
      {
        $addFields: {
          avatarUrl: { $arrayElemAt: ['$studentRecord.avatarUrl', 0] },
        },
      },
      { $project: { studentRecord: 0 } },
    ]);

    res.json({ applications });
  } catch (err) {
    console.error('Admin fetch applications error:', err);
    res.status(500).json({ error: 'Failed to fetch applications.' });
  }
});

// PATCH /api/applications/:id/status — admin-only. Updates an
// application's review status and optionally records a note (e.g. reason
// for rejection or requested revision).
router.patch('/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, reviewNote } = req.body;

    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}.` });
    }

    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid application id.' });
    }

    // Switched from findByIdAndUpdate to find-then-save so we can push a
    // history entry atomically alongside the status/note fields in the
    // same document write, rather than a separate update call that could
    // race or partially fail against this one. This route doubles as
    // AdminDashboard's "Save Note" action (same status re-sent, only the
    // note changes) — we still log an entry every time it's called, since
    // a note added without a status change is itself worth a timeline
    // entry ("what did the reviewer say and when"), and downstream
    // analytics (e.g. revision-cycle counts) key off status values that
    // are only meaningful if every decision, including note-only saves,
    // shows up here consistently.
    const application = await Application.findOne({ _id: objectId, ...officeFilter(req.adminUser) });
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    // Once the LSO has overridden an office's decision, the office can no
    // longer change the status or the note the student sees — the LSO's
    // decision is final. (Office-use fields stay editable; see
    // PATCH /:id/admin-fields.)
    const office = scopedOffice(req.adminUser);
    if (office && application.decisionOffice === 'LSO') {
      return res.status(409).json({ error: 'The LSO has overridden this decision, so it can no longer be changed by your office.' });
    }

    // Only a real status change records who decided. "Save note only"
    // re-sends the current status and must not turn into (or erase) an
    // LSO override.
    if (status !== application.status) {
      application.decisionOffice = office || 'LSO';
    }
    application.status = status;
    application.reviewNote = reviewNote || undefined;
    application.reviewedBy = req.adminUser.email;
    application.reviewedAt = new Date();

    if (!Array.isArray(application.history)) application.history = [];
    application.history.push({
      status,
      note: reviewNote || undefined,
      changedBy: req.adminUser.email,
      changedAt: application.reviewedAt,
    });

    // An office (POLCA / Alumni) approving one of its applications sends it
    // to the LSO right away, instead of waiting for the next "Send to LSO".
    if (office && status === 'Approved' && !application.forwardedAt) {
      application.forwardedAt = application.reviewedAt;
      application.forwardedBy = req.adminUser.email;
      application.forwardBatchId = `${office}-approved-${application.reviewedAt.getTime()}`;
      application.history.push({
        status: 'Forwarded to LSO',
        note: `Sent automatically when approved by the ${office} office`,
        changedBy: req.adminUser.email,
        changedAt: application.reviewedAt,
      });
    }

    // Guard the write itself too: if the LSO overrides between our read
    // and this save, the office's save matches nothing and fails below
    // instead of silently replacing the LSO's decision.
    if (office) application.$where = { decisionOffice: { $ne: 'LSO' } };

    try {
      await application.save();
    } catch (saveErr) {
      if (saveErr.name === 'DocumentNotFoundError') {
        return res.status(409).json({ error: 'The LSO has overridden this decision, so it can no longer be changed by your office.' });
      }
      throw saveErr;
    }

    res.json({ application });
  } catch (err) {
    console.error('Admin update status error:', err);
    res.status(500).json({ error: 'Failed to update application status.' });
  }
});

// POST /api/applications/forward — office admins only (POLCA / ALUMNI).
// Sends every one of the office's applications that hasn't been sent yet
// to the LSO, whatever its status, as one batch. Applications submitted
// afterwards stay with the office until its next send. The office keeps
// reviewing sent applications; its decision stands unless the LSO
// overrides it (PATCH /:id/status records which office decided).
// Approving an application already sends it on its own (see
// PATCH /:id/status), so this mainly covers the other statuses.
router.post('/forward', requireAdmin, async (req, res) => {
  try {
    const office = scopedOffice(req.adminUser);
    if (!office) {
      return res.status(400).json({ error: 'Only POLCA and Alumni office admins send applications to the LSO.' });
    }

    // Mark the batch first, then count what this batch actually contains,
    // so the reported totals always match what was sent — even if a new
    // submission or an auto-forward (approval) lands at the same time.
    const forwardedAt = new Date();
    const forwardBatchId = `${office}-${forwardedAt.getTime()}`;
    const result = await Application.updateMany({ office, forwardedAt: null }, {
      $set: { forwardedAt, forwardedBy: req.adminUser.email, forwardBatchId },
      $push: {
        history: {
          status: 'Forwarded to LSO',
          note: `Sent by the ${office} office`,
          changedBy: req.adminUser.email,
          changedAt: forwardedAt,
        },
      },
    });

    if (result.modifiedCount === 0) {
      return res.status(400).json({ error: 'There are no new applications to send.' });
    }
    const byStatus = await Application.aggregate([
      { $match: { forwardBatchId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    res.json({
      forwarded: result.modifiedCount,
      byStatus: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
      forwardBatchId,
      forwardedAt,
    });
  } catch (err) {
    console.error('Forward to LSO error:', err);
    res.status(500).json({ error: 'Failed to send applications to the LSO.' });
  }
});

// PATCH /api/applications/:id/admin-fields — admin-only. Saves the POLCA
// form's office-use box (Date Received, Received By, New/Old applicant,
// GPA). Only POLCA applications have these fields. Send null/'' to clear
// a field.
router.patch('/:id/admin-fields', requireAdmin, async (req, res) => {
  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'Invalid application id.' });
    }

    const application = await Application.findOne({ _id: objectId, ...officeFilter(req.adminUser) });
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
    }
    if (application.applicationFormType !== 'polca') {
      return res.status(400).json({ error: 'Office-use fields only apply to POLCA applications.' });
    }

    const { dateReceived, receivedBy, applicantType, gpa } = req.body || {};
    const next = {};

    if (dateReceived) {
      const parsed = new Date(dateReceived);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid date received.' });
      next.dateReceived = parsed;
    }
    if (typeof receivedBy === 'string' && receivedBy.trim()) next.receivedBy = receivedBy.trim();
    if (applicantType) {
      if (!['New', 'Old'].includes(applicantType)) return res.status(400).json({ error: 'Applicant type must be New or Old.' });
      next.applicantType = applicantType;
    }
    if (gpa !== undefined && gpa !== null && gpa !== '') {
      const parsed = Number(gpa);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) return res.status(400).json({ error: 'GPA must be a number between 0 and 5.' });
      next.gpa = parsed;
    }

    application.adminFields = { ...next, updatedBy: req.adminUser.email, updatedAt: new Date() };
    await application.save();

    res.json({ application });
  } catch (err) {
    console.error('Admin update office fields error:', err);
    res.status(500).json({ error: 'Failed to save office-use fields.' });
  }
});

// GET a single stored document back out of GridFS, e.g. for SFAG staff review
// or for the student to preview what they uploaded.
router.get('/documents/:fileId', async (req, res) => {
  try {
    const bucket = getBucket();
    let fileId;
    try {
      fileId = new ObjectId(req.params.fileId);
    } catch {
      return res.status(400).json({ error: 'Invalid file id.' });
    }

    const matches = await bucket.find({ _id: fileId }).toArray();
    if (!matches.length) {
      return res.status(404).json({ error: 'File not found.' });
    }

    res.set('Content-Type', matches[0].metadata?.mimetype || 'image/jpeg');
    bucket
      .openDownloadStream(fileId)
      .pipe(res)
      .on('error', () => res.status(500).end());
  } catch (err) {
    console.error('GridFS download failed:', err);
    res.status(500).json({ error: 'Could not retrieve file.' });
  }
});

module.exports = router;