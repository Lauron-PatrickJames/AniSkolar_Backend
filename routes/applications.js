const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Readable } = require('stream');
const { ObjectId } = require('mongodb');
const { applicationUpload } = require('../middleware/uploadConfig');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getBucket } = require('../utils/gridfs');
const Application = require('../models/Application');

const ALLOWED_STATUSES = ['Under Evaluation', 'Approved', 'Rejected', 'Needs Revision'];

// Accept up to 8 files under the same field name "documents", plus a
// parallel JSON array "documentLabels" telling us which requirement
// each file corresponds to (e.g. ["Application Letter", "Indigency", ...]).
// This matches your frontend's dynamic scholarship.requirements list
// instead of hardcoding fixed field names.
const uploadDocs = applicationUpload.array('documents', 8);

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
        scholarshipName,
        applicationFormType,
        standardInfo,
        personalInfo,
        contactSchool,
        parentsGuardian,
        siblings,
        assetsExpenses,
        agreement,
        documentLabels,
      } = req.body;

      if (!studentNumber || !scholarshipId) {
        return res.status(400).json({ error: 'Missing student number or scholarship reference.' });
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

      // Stream every file into GridFS (MongoDB Atlas) instead of disk.
      // If any single upload fails partway through, we clean up the ones
      // that already succeeded so we don't leave orphaned files in GridFS.
      const bucket = getBucket();
      const uploadedFileIds = [];
      let documents;
      try {
        documents = await Promise.all(
          req.files.map(
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
        console.error('GridFS upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
      }

      const applicationData = {
        studentNumber,
        scholarshipId,
        scholarshipName,
        applicationFormType: applicationFormType || 'standard',
        documents,
        referenceCode: `DLSU-D-SFAG-${Math.floor(Math.random() * 900000 + 100000)}`,
        // First lifecycle event. changedBy is always 'student' here since
        // this route only ever runs for the applicant's own submission.
        history: [{ status: 'Submitted', changedBy: 'student', changedAt: new Date() }],
      };

      if (applicationFormType === 'sfag') {
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

      res.status(201).json({
        message: 'Application submitted successfully.',
        application,
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
      } = req.body;

      let labels;
      try {
        labels = JSON.parse(documentLabels || '[]');
      } catch {
        return res.status(400).json({ error: 'Invalid document labels format.' });
      }

      if (req.files && labels.length !== req.files.length) {
        return res.status(400).json({ error: 'Document count does not match label count.' });
      }

      // Upload any newly-selected replacement files into GridFS, same as POST.
      const bucket = getBucket();
      const uploadedFileIds = [];
      let newDocs = [];
      try {
        newDocs = await Promise.all(
          (req.files || []).map(
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
        console.error('GridFS upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
      }

      // Keep whatever was already on file for any docType NOT re-uploaded
      // this time around; swap in the new file for anything that was.
      const replacedTypes = new Set(newDocs.map(d => d.docType));
      const mergedDocs = [
        ...existing.documents.filter(d => !replacedTypes.has(d.docType)),
        ...newDocs,
      ];
      existing.documents = mergedDocs;

      const formType = applicationFormType || existing.applicationFormType;
      existing.applicationFormType = formType;

      if (formType === 'sfag') {
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
        application: existing,
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
    const applications = await Application.find({ studentNumber: req.params.studentNumber }).sort({ createdAt: -1 });
    res.json({ applications });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications.' });
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

    const application = await Application.findById(objectId);
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
    const filter = {};
    if (req.query.status && ALLOWED_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.scholarshipId) {
      filter.scholarshipId = req.query.scholarshipId;
    }

    const applications = await Application.find(filter).sort({ createdAt: -1 });
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
    const application = await Application.findById(objectId);
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
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

    console.log('history before save:', application.history.length);
    await application.save();

    res.json({ application });
  } catch (err) {
    console.error('Admin update status error:', err);
    res.status(500).json({ error: 'Failed to update application status.' });
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