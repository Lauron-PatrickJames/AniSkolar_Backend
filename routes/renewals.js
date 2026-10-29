const express = require('express');
const { RENEWAL_DOCUMENTS } = require('../models/RenewalPeriod');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { applicationUpload } = require('../middleware/uploadConfig');
const { requireAdmin, requireAdso } = require('../middleware/requireAdmin');
const { requireScholar } = require('../middleware/requireStudent');
const { storeFilesInGridFS } = require('../utils/gridfs');
const { scopedOffice } = require('../utils/officeScope');
const { findScholarship, acceptsOnlineApplications } = require('../data/scholarships');
const { findHolders, parseEvaluationScores, previousTerm, PASSING_AVERAGE } = require('../utils/renewals');
const DutyLog = require('../models/DutyLog');
const { listOffices, norm, officesWithHeads } = require('../utils/offices');
const { summariesFor, stateOf } = require('../utils/evaluations');
const { sendMail } = require('../utils/mailer');
const { renderEmail } = require('../utils/emailTemplate');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const Student = require('../models/Student');
const { checksForPeriod } = require('../utils/renewalCheck');

// Scholarship renewals.
//
// Scholar (an approved application, else 403; identity from the Clerk
// session, never the body):
//   GET   /api/renewals/mine           open periods for scholarships they hold + their renewals
//   POST  /api/renewals                submit a renewal (multipart: documents + documentLabels)
//   PATCH /api/renewals/:id            resubmit after "Needs Revision"
//
// Admin:
//   GET   /api/renewals/admin/periods                  periods (office admins: their scholarships)
//   POST  /api/renewals/admin/periods                  AdSO: open a period
//   PATCH /api/renewals/admin/periods/:id              AdSO: edit / open / close a period
//   GET   /api/renewals/admin/periods/:id/scholars     every holder with their renewal (or none yet)
//   PATCH /api/renewals/admin/:id/evaluation           enter the department head's evaluation
//   PATCH /api/renewals/admin/:id/status               decide: Renewed / Not Renewed / Needs Revision
//   POST  /api/renewals/admin/periods/:id/renew-eligible  { renewalIds } renew those that pass every check
//
// Renewals are reviewed by the office that owns the scholarship; the AdSO
// sees and can decide every renewal. Documents are served by the existing
// GET /api/applications/documents/:fileId (same GridFS bucket).

const MAX_DOCUMENT_FILES = 10;
const uploadDocs = applicationUpload.array('documents', MAX_DOCUMENT_FILES);
const { DECISIONS, NOT_CONTINUING_REASONS } = Renewal;
const { TERMS } = RenewalPeriod;

// Runs multer and turns its errors into 400s, like routes/applications.js.
function withUploads(handler) {
  return (req, res) => uploadDocs(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 10MB.' : err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    return handler(req, res);
  });
}

function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

// Scholars see the department head's evaluation on their renewal (scores,
// remarks, who and when), without the staff email that entered it.
function toStudentView(renewal) {
  const obj = renewal.toObject ? renewal.toObject() : { ...renewal };
  if (obj.evaluation?.average) {
    const { enteredBy, source, ...shown } = obj.evaluation;
    obj.evaluation = shown;
  } else {
    delete obj.evaluation;
  }
  delete obj.reviewedBy;
  obj.history = (obj.history || []).map(({ changedBy, changedByName, ...rest }) => ({
    ...rest,
    changedBy: changedBy === 'student' ? 'student' : 'office',
  }));
  return obj;
}

function periodView(period) {
  const scholarship = findScholarship(period.scholarshipId);
  return {
    ...(period.toObject ? period.toObject() : period),
    // Grades only, for every period.
    requirements: RENEWAL_DOCUMENTS,
    scholarshipName: scholarship?.name ?? period.scholarshipId,
    office: scholarship?.office ?? 'LSO',
  };
}

// Without the staff emails of whoever opened or edited the period.
function studentPeriodView(period) {
  const { createdBy, updatedBy, ...rest } = periodView(period);
  return rest;
}

// Admins only see periods / renewals for their office's scholarships; the
// AdSO sees all.
function canSeeScholarship(adminUser, scholarshipId) {
  const office = scopedOffice(adminUser);
  return !office || findScholarship(scholarshipId)?.office === office;
}

const boolField = v => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

// Validates the scholar's answers and documents for a period. `keptDocTypes`
// are requirements already on file (resubmission). Returns { fields, labels } or { error }.
function parseSubmission(body, files, period, keptDocTypes = new Set()) {
  const continuing = boolField(body.continuing);
  if (continuing === undefined) return { error: 'Tell us whether you are continuing with the scholarship.' };

  let labels;
  try {
    labels = JSON.parse(body.documentLabels || '[]');
  } catch {
    return { error: 'Invalid document labels format.' };
  }
  if (!Array.isArray(labels) || labels.length !== files.length) {
    return { error: 'Document count does not match label count.' };
  }

  if (!continuing) {
    if (files.length) return { error: 'No documents are needed when you are not continuing.' };
    if (!NOT_CONTINUING_REASONS.includes(body.notContinuingReason)) return { error: 'Choose why you are not continuing.' };
    const details = typeof body.notContinuingDetails === 'string' ? body.notContinuingDetails.trim() : '';
    if (body.notContinuingReason === 'Other' && !details) return { error: 'Tell us why you are not continuing.' };
    return {
      fields: { continuing, notContinuingReason: body.notContinuingReason, notContinuingDetails: details || undefined, gpa: undefined, hasFailingGrade: undefined },
      labels,
    };
  }

  const gpa = Number(body.gpa);
  if (body.gpa === undefined || body.gpa === '' || !Number.isFinite(gpa) || gpa < 0 || gpa > 4) {
    return { error: 'Enter your GPA for last semester (0.00–4.00).' };
  }
  const hasFailingGrade = boolField(body.hasFailingGrade);
  if (hasFailingGrade === undefined) return { error: 'Tell us whether you had any failing grade last semester.' };

  const requirements = RENEWAL_DOCUMENTS;
  if (labels.some(l => !requirements.includes(l))) return { error: 'Only your grades are submitted for a renewal.' };
  const present = new Set([...keptDocTypes, ...labels]);
  const missing = requirements.filter(r => !present.has(r));
  if (missing.length) return { error: `Please upload all required documents. Missing: ${missing.join(', ')}.` };

  return {
    fields: { continuing, notContinuingReason: undefined, notContinuingDetails: undefined, gpa: Math.round(gpa * 100) / 100, hasFailingGrade },
    labels,
  };
}

// --- Scholar ------------------------------------------------------------------

// Renewing waits for the office head's evaluation of the term the renewal
// looks back on (AdSO, Oct 2026), when the period needs one and the
// scholar's duty office has a head in AniSkolar. With no office or no head
// there, the AdSO enters a paper evaluation after submission, so nothing
// waits. Saying "not continuing" never waits. Returns null, or
// { office, hoursComplete, message } for the scholar.
async function evaluationWait(period, studentNumber) {
  if (!period.requiresEvaluation) return null;
  const prev = previousTerm(period);
  const log = await DutyLog.findOne({ studentNumber, academicYear: prev.academicYear, term: prev.term }).lean();
  if (!log?.officeAssigned || log.evaluation?.average) return null;
  if (!(await officesWithHeads()).has(norm(log.officeAssigned))) return null;
  const hoursComplete = stateOf(log, (await summariesFor([log])).get(String(log._id))) !== 'in_progress';
  return {
    office: log.officeAssigned,
    hoursComplete,
    message: hoursComplete
      ? `You can renew once ${log.officeAssigned} evaluates your duty for the ${prev.term}. They've been notified.`
      : `You can renew once your duty hours for the ${prev.term} are complete and ${log.officeAssigned} has evaluated you.`,
  };
}

router.get('/mine', requireScholar, async (req, res) => {
  try {
    const [openPeriods, renewals] = await Promise.all([
      RenewalPeriod.find({ open: true }).sort({ academicYear: -1, term: -1 }),
      Renewal.find({ studentNumber: req.studentNumber }).sort({ createdAt: -1 }),
    ]);

    // Open periods the scholar can still submit for: they hold the
    // scholarship and haven't submitted yet.
    const submittedPeriodIds = new Set(renewals.map(r => String(r.periodId)));
    const available = [];
    for (const period of openPeriods) {
      if (submittedPeriodIds.has(String(period._id))) continue;
      const holders = await findHolders(period, req.studentNumber);
      if (holders.has(req.studentNumber)) available.push({ ...studentPeriodView(period), evaluationWait: await evaluationWait(period, req.studentNumber) });
    }

    const periodIds = renewals.map(r => r.periodId);
    const periods = await RenewalPeriod.find({ _id: { $in: periodIds } });
    const periodById = new Map(periods.map(p => [String(p._id), studentPeriodView(p)]));

    res.json({
      available,
      renewals: renewals.map(r => ({ ...toStudentView(r), period: periodById.get(String(r.periodId)) ?? null })),
    });
  } catch (err) {
    console.error('Load renewals error:', err);
    res.status(500).json({ error: 'Failed to load your renewals.' });
  }
});

router.post('/', requireScholar, withUploads(async (req, res) => {
  try {
    const { periodId } = req.body;
    if (!isObjectId(periodId)) return res.status(400).json({ error: 'Choose the renewal to submit.' });
    const period = await RenewalPeriod.findById(periodId);
    if (!period) return res.status(404).json({ error: 'Renewal period not found.' });
    if (!period.open) return res.status(400).json({ error: 'This renewal period is closed.' });

    const holders = await findHolders(period, req.studentNumber);
    if (!holders.has(req.studentNumber)) {
      return res.status(403).json({ error: 'Only current holders of this scholarship can renew it.' });
    }
    if (await Renewal.exists({ periodId: period._id, studentNumber: req.studentNumber })) {
      return res.status(409).json({ error: 'You already submitted this renewal.' });
    }
    // Continuing waits for the office's evaluation (files aren't stored yet).
    if (boolField(req.body.continuing) === true) {
      const wait = await evaluationWait(period, req.studentNumber);
      if (wait) return res.status(409).json({ code: 'evaluation_pending', error: wait.message });
    }

    const files = req.files || [];
    const parsed = parseSubmission(req.body, files, period);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let documents = [];
    try {
      documents = await storeFilesInGridFS(files, parsed.labels);
    } catch (uploadErr) {
      console.error('GridFS upload failed:', uploadErr);
      return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
    }

    const scholarship = findScholarship(period.scholarshipId);
    const now = new Date();
    const status = parsed.fields.continuing ? 'Under Evaluation' : 'Not Continuing';
    // The office head may already have evaluated the term this looks back on.
    const prev = previousTerm(period);
    const lastTermLog = parsed.fields.continuing
      ? await DutyLog.findOne({ studentNumber: req.studentNumber, academicYear: prev.academicYear, term: prev.term }).select('evaluation').lean()
      : null;
    const renewal = await Renewal.create({
      periodId: period._id,
      studentNumber: req.studentNumber,
      scholarshipId: period.scholarshipId,
      scholarshipName: scholarship?.name ?? period.scholarshipId,
      office: scholarship?.office ?? 'LSO',
      academicYear: period.academicYear,
      term: period.term,
      ...parsed.fields,
      documents,
      status,
      ...(lastTermLog?.evaluation?.average ? { evaluation: lastTermLog.evaluation } : {}),
      history: [
        { status: 'Submitted', changedBy: 'student', changedAt: now },
        ...(status === 'Not Continuing' ? [{ status, note: parsed.fields.notContinuingReason, changedBy: 'student', changedAt: now }] : []),
      ],
    });

    res.status(201).json({ renewal: { ...toStudentView(renewal), period: studentPeriodView(period) } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'You already submitted this renewal.' });
    console.error('Submit renewal error:', err);
    res.status(500).json({ error: 'Failed to submit your renewal.' });
  }
}));

// Admin routes are registered before PATCH /:id so "/admin/..." never
// matches the :id parameter.

// --- Admin: periods -----------------------------------------------------------

function parsePeriodBody(body, { partial }) {
  const out = {};
  if (!partial || body.scholarshipId !== undefined) {
    const scholarship = findScholarship(body.scholarshipId);
    if (!scholarship) return { error: 'Choose a scholarship.' };
    if (!acceptsOnlineApplications(scholarship)) return { error: 'This scholarship is awarded outside AniSkolar, so it has no online renewal.' };
    if (scholarship.noRenewal) return { error: `The ${scholarship.name} has no renewals: scholars keep it until they graduate.` };
    out.scholarshipId = scholarship.id;
  }
  if (!partial || body.academicYear !== undefined) {
    const year = Number(body.academicYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'Choose the academic year.' };
    out.academicYear = year;
  }
  if (!partial || body.term !== undefined) {
    if (!TERMS.includes(body.term)) return { error: 'Choose the term.' };
    out.term = body.term;
  }
  if (body.open !== undefined) out.open = body.open === true;
  if (body.deadline !== undefined) out.deadline = typeof body.deadline === 'string' ? body.deadline.trim().slice(0, 200) : '';
  if (body.notes !== undefined) out.notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';
  if (body.minGpa !== undefined) {
    if (body.minGpa === null || body.minGpa === '') out.minGpa = null;
    else {
      const gpa = Number(body.minGpa);
      if (!Number.isFinite(gpa) || gpa < 0 || gpa > 4) return { error: 'The minimum GPA must be between 0.00 and 4.00.' };
      out.minGpa = gpa;
    }
  }
  if (body.requiresEvaluation !== undefined) out.requiresEvaluation = body.requiresEvaluation === true;
  // The documents aren't chosen per period: renewal is grades only.
  return { period: out };
}

router.get('/admin/periods', requireAdmin, async (req, res) => {
  try {
    const periods = await RenewalPeriod.find({}).sort({ academicYear: -1, term: -1, scholarshipId: 1 });
    const visible = periods.filter(p => canSeeScholarship(req.adminUser, p.scholarshipId));
    const counts = await Renewal.aggregate([
      { $match: { periodId: { $in: visible.map(p => p._id) } } },
      { $group: { _id: { periodId: '$periodId', status: '$status' }, count: { $sum: 1 } } },
    ]);
    const countsById = {};
    for (const { _id, count } of counts) {
      (countsById[String(_id.periodId)] ??= {})[_id.status] = count;
    }
    res.json({ periods: visible.map(p => ({ ...periodView(p), counts: countsById[String(p._id)] ?? {} })) });
  } catch (err) {
    console.error('Load renewal periods error:', err);
    res.status(500).json({ error: 'Failed to load renewal periods.' });
  }
});

router.post('/admin/periods', requireAdso, async (req, res) => {
  try {
    const { period, error } = parsePeriodBody(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    if (period.minGpa === null) delete period.minGpa;
    // Checked here as well as by the unique index, which may still be
    // building on a new collection.
    const { scholarshipId, academicYear, term } = period;
    if (await RenewalPeriod.exists({ scholarshipId, academicYear, term })) {
      return res.status(409).json({ error: 'That scholarship already has a renewal period for this term.' });
    }
    const created = await RenewalPeriod.create({
      ...period,
      createdBy: req.adminUser.email || req.adminUser.id,
      updatedBy: req.adminUser.email || req.adminUser.id,
    });
    // Office heads with scholars to evaluate get one email (in the background).
    notifyOfficeHeads(created).catch(err => console.error('Emailing office heads failed:', err));
    res.status(201).json({ period: { ...periodView(created), counts: {} } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That scholarship already has a renewal period for this term.' });
    console.error('Create renewal period error:', err);
    res.status(500).json({ error: 'Failed to create the renewal period.' });
  }
});

router.patch('/admin/periods/:id', requireAdso, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid period id.' });
    const body = { ...(req.body || {}) };
    // The scholarship and term of a period are fixed once scholars may
    // have submitted against it.
    delete body.scholarshipId; delete body.academicYear; delete body.term;
    const { period, error } = parsePeriodBody(body, { partial: true });
    if (error) return res.status(400).json({ error });

    const update = { $set: { updatedBy: req.adminUser.email || req.adminUser.id } };
    for (const [key, value] of Object.entries(period)) {
      if (value === null) (update.$unset ??= {})[key] = '';
      else update.$set[key] = value;
    }
    const saved = await RenewalPeriod.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true });
    if (!saved) return res.status(404).json({ error: 'Renewal period not found.' });
    res.json({ period: periodView(saved) });
  } catch (err) {
    console.error('Update renewal period error:', err);
    res.status(500).json({ error: 'Failed to update the renewal period.' });
  }
});

// Every scholar who holds the scholarship for the period, with their
// renewal if they submitted one ("missing" = holders without one), plus any
// renewal from a scholar no longer counted as a holder.
// The office each scholar rendered duty in during the term a renewal looks
// back on (the term before the period's; its head does the evaluation),
// from Duty hours. Returns { term, offices: Map studentNumber -> office }.
async function dutyOfficesFor(period, studentNumbers) {
  const term = previousTerm(period);
  if (!studentNumbers.length) return { term, offices: new Map() };
  const logs = await DutyLog.find({ studentNumber: { $in: studentNumbers }, academicYear: term.academicYear, term: term.term, officeAssigned: { $nin: [null, ''] } })
    .select('studentNumber officeAssigned').lean();
  return { term, offices: new Map(logs.map(l => [l.studentNumber, l.officeAssigned])) };
}

// Emails the heads of offices with scholars to evaluate for this period
// (one email, heads in BCC). Returns how many heads were emailed.
async function notifyOfficeHeads(period) {
  if (!period.open || !period.requiresEvaluation) return 0;
  const prev = previousTerm(period);
  const holders = await findHolders(period);
  const logs = await DutyLog.find({ academicYear: prev.academicYear, term: prev.term, studentNumber: { $in: [...holders.keys()] }, officeAssigned: { $nin: [null, ''] } }).select('officeAssigned').lean();
  const withScholars = new Set(logs.map(l => norm(l.officeAssigned)));
  const heads = (await listOffices()).filter(o => o.headEmail && withScholars.has(norm(o.office))).map(o => o.headEmail);
  if (!heads.length) return 0;
  const name = findScholarship(period.scholarshipId)?.name ?? 'scholarship';
  const appUrl = process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';
  const email = renderEmail({
    heading: 'Scholar evaluations are open',
    intro: `Please evaluate the ${name} scholars who rendered duty in your office during the ${prev.term}, A.Y. ${prev.academicYear}–${prev.academicYear + 1}.`,
    body: `Sign in to AniSkolar with your school email and open Evaluations. Each scholar is rated 1–5 on the usual items; it takes a few minutes per scholar.${period.deadline ? `\n\nRenewal deadline: ${period.deadline}` : ''}`,
    button: { url: appUrl, label: 'Open AniSkolar' },
  });
  for (let i = 0; i < heads.length; i += 50) {
    await sendMail({ to: process.env.ACS_EMAIL_SENDER, bcc: heads.slice(i, i + 50), subject: `AniSkolar: please evaluate your ${name} scholars`, ...email });
  }
  return heads.length;
}

// POST /api/renewals/admin/periods/:id/notify-offices — remind office heads.
router.post('/admin/periods/:id/notify-offices', requireAdso, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid period id.' });
    const period = await RenewalPeriod.findById(req.params.id).lean();
    if (!period) return res.status(404).json({ error: 'Renewal period not found.' });
    if (!period.open || !period.requiresEvaluation) return res.status(400).json({ error: 'This period isn’t open for evaluations.' });
    res.json({ emailed: await notifyOfficeHeads(period) });
  } catch (err) {
    console.error('Notify office heads error:', err);
    res.status(500).json({ error: 'Failed to email the office heads.' });
  }
});

router.get('/admin/periods/:id/scholars', requireAdmin, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid period id.' });
    const period = await RenewalPeriod.findById(req.params.id);
    if (!period || !canSeeScholarship(req.adminUser, period.scholarshipId)) {
      return res.status(404).json({ error: 'Renewal period not found.' });
    }

    const [holders, renewals] = await Promise.all([
      findHolders(period),
      Renewal.find({ periodId: period._id }),
    ]);
    const renewalByStudent = new Map(renewals.map(r => [r.studentNumber, r]));
    const studentNumbers = [...new Set([...holders.keys(), ...renewalByStudent.keys()])];
    const students = await Student.find({ studentNumber: { $in: studentNumbers } })
      .select('studentNumber name email course programCode yearLevel avatarUrl').lean();
    const studentByNumber = new Map(students.map(s => [s.studentNumber, s]));
    const [duty, checks] = await Promise.all([dutyOfficesFor(period, studentNumbers), checksForPeriod(period, renewals)]);

    const scholars = studentNumbers.map(studentNumber => {
      const student = studentByNumber.get(studentNumber);
      const holder = holders.get(studentNumber);
      return {
        studentNumber,
        name: student?.name ?? '',
        email: student?.email ?? '',
        program: student?.programCode || student?.course || '',
        yearLevel: student?.yearLevel ?? '',
        avatarUrl: student?.avatarUrl,
        holder: holder ? { referenceCode: holder.referenceCode, renewedFrom: holder.renewedFrom } : null,
        renewal: renewalByStudent.get(studentNumber) ?? null,
        // Pre-check of a submitted renewal (utils/renewalCheck.js).
        check: renewalByStudent.has(studentNumber) ? checks.get(String(renewalByStudent.get(studentNumber)._id)) ?? null : null,
        // Where they did duty in the term being evaluated (Duty hours).
        dutyOffice: duty.offices.get(studentNumber) ?? null,
      };
    });

    res.json({ period: periodView(period), passingAverage: PASSING_AVERAGE, scholars, dutyTerm: duty.term });
  } catch (err) {
    console.error('Load renewal scholars error:', err);
    res.status(500).json({ error: 'Failed to load scholars for this renewal.' });
  }
});

// Renews, in one go, the chosen renewals that are Under Evaluation and pass
// every check (re-checked here, not trusted from the page). Returns how many
// were renewed and which were skipped.
router.post('/admin/periods/:id/renew-eligible', requireAdmin, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid period id.' });
    const period = await RenewalPeriod.findById(req.params.id).lean();
    if (!period || !canSeeScholarship(req.adminUser, period.scholarshipId)) return res.status(404).json({ error: 'Renewal period not found.' });
    const ids = Array.isArray(req.body?.renewalIds) ? [...new Set(req.body.renewalIds.filter(isObjectId))] : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose the renewals to renew.' });
    if (ids.length > 1000) return res.status(400).json({ error: 'At most 1,000 at a time.' });
    const renewals = await Renewal.find({ _id: { $in: ids }, periodId: period._id });
    const checks = await checksForPeriod(period, renewals);
    const now = new Date();
    let renewed = 0;
    const skipped = [];
    for (const renewal of renewals) {
      if (renewal.status !== 'Under Evaluation' || checks.get(String(renewal._id))?.result !== 'eligible') { skipped.push(renewal.studentNumber); continue; }
      // Only if nobody decided it in the meantime.
      const done = await Renewal.updateOne({ _id: renewal._id, status: 'Under Evaluation' }, {
        $set: { status: 'Renewed', reviewedBy: req.adminUser.email, reviewedAt: now },
        $unset: { reviewNote: '' },
        $push: { history: { status: 'Renewed', note: 'Passed every renewal check (renewed in bulk).', changedBy: req.adminUser.email, changedByName: req.adminUser.name, changedByOffice: req.adminUser.office, changedAt: now } },
      });
      if (done.modifiedCount) renewed++; else skipped.push(renewal.studentNumber);
    }
    res.json({ renewed, skipped: skipped.length + (ids.length - renewals.length) });
  } catch (err) {
    console.error('Bulk renew error:', err);
    res.status(500).json({ error: 'Failed to renew.' });
  }
});

async function findVisibleRenewal(req, res) {
  if (!isObjectId(req.params.id)) {
    res.status(400).json({ error: 'Invalid renewal id.' });
    return null;
  }
  const renewal = await Renewal.findById(req.params.id);
  if (!renewal || !canSeeScholarship(req.adminUser, renewal.scholarshipId)) {
    res.status(404).json({ error: 'Renewal not found.' });
    return null;
  }
  return renewal;
}

router.patch('/admin/:id/evaluation', requireAdmin, async (req, res) => {
  try {
    const renewal = await findVisibleRenewal(req, res);
    if (!renewal) return;
    const body = req.body || {};
    const { scores, average, error } = parseEvaluationScores(body.scores);
    if (error) return res.status(400).json({ error });
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || undefined;
    // The evaluating office defaults to the scholar's duty office for the
    // term being evaluated.
    const dutyOffice = text(body.assignedOffice, 200)
      ?? (await dutyOfficesFor(renewal, [renewal.studentNumber])).offices.get(renewal.studentNumber);
    renewal.evaluation = {
      scores,
      average,
      evaluatorName: text(body.evaluatorName, 200),
      assignedOffice: dutyOffice || undefined,
      remarks: text(body.remarks, 2000),
      enteredBy: req.adminUser.email,
      enteredAt: new Date(),
      source: 'adso',
    };
    await renewal.save();
    res.json({ renewal });
  } catch (err) {
    console.error('Save renewal evaluation error:', err);
    res.status(500).json({ error: 'Failed to save the evaluation.' });
  }
});

router.patch('/admin/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!DECISIONS.includes(status)) return res.status(400).json({ error: `Status must be one of: ${DECISIONS.join(', ')}.` });
    const renewal = await findVisibleRenewal(req, res);
    if (!renewal) return;

    // Same rules as application decisions: the scholar reads the message,
    // so asking for changes, turning them down, or changing a decision
    // must explain itself; re-sending the current status is refused.
    const note = typeof req.body.reviewNote === 'string' ? req.body.reviewNote.trim() : '';
    if (status === renewal.status) {
      return res.status(409).json({ error: `This renewal is already ${status}. Choose a different decision to change it.` });
    }
    if (!note) {
      if (status === 'Needs Revision' || status === 'Not Renewed') {
        return res.status(400).json({ error: 'Add a message to the scholar explaining what to do or why.' });
      }
      if (renewal.status !== 'Under Evaluation') {
        return res.status(400).json({ error: 'Add a message to the scholar explaining why the decision changed.' });
      }
    }
    if (status === 'Renewed') {
      const period = await RenewalPeriod.findById(renewal.periodId).select('requiresEvaluation').lean();
      if (period?.requiresEvaluation && !renewal.evaluation?.average) {
        return res.status(400).json({ error: "Enter the department head's evaluation before renewing." });
      }
    }

    const now = new Date();
    renewal.status = status;
    renewal.reviewNote = note || undefined;
    renewal.reviewedBy = req.adminUser.email;
    renewal.reviewedAt = now;
    renewal.history.push({
      status,
      note: note || undefined,
      changedBy: req.adminUser.email,
      changedByName: req.adminUser.name,
      changedByOffice: req.adminUser.office,
      changedAt: now,
    });
    await renewal.save();
    res.json({ renewal });
  } catch (err) {
    console.error('Renewal decision error:', err);
    res.status(500).json({ error: 'Failed to save the decision.' });
  }
});

// --- Scholar: resubmission ----------------------------------------------------

// Allowed only after "Needs Revision", even if the period has closed since.
// Documents re-uploaded replace the ones on file for the same requirement.
router.patch('/:id', requireScholar, withUploads(async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid renewal id.' });
    const renewal = await Renewal.findById(req.params.id);
    if (!renewal || renewal.studentNumber !== req.studentNumber) return res.status(404).json({ error: 'Renewal not found.' });
    if (renewal.status !== 'Needs Revision') {
      return res.status(409).json({ error: 'This renewal can only be changed when the office asks for a revision.' });
    }
    const period = await RenewalPeriod.findById(renewal.periodId);
    if (!period) return res.status(404).json({ error: 'Renewal period not found.' });

    const files = req.files || [];
    const kept = new Set(renewal.documents.map(d => d.docType));
    const parsed = parseSubmission(req.body, files, period, kept);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let newDocs = [];
    try {
      newDocs = await storeFilesInGridFS(files, parsed.labels);
    } catch (uploadErr) {
      console.error('GridFS upload failed:', uploadErr);
      return res.status(500).json({ error: 'Failed to store uploaded documents. Please try again.' });
    }
    const replaced = new Set(newDocs.map(d => d.docType));
    // Not continuing: nothing on file is needed any more.
    renewal.documents = parsed.fields.continuing
      ? [...renewal.documents.filter(d => !replaced.has(d.docType)), ...newDocs]
      : [];
    Object.assign(renewal, parsed.fields);

    const now = new Date();
    renewal.status = parsed.fields.continuing ? 'Under Evaluation' : 'Not Continuing';
    renewal.history.push({ status: 'Resubmitted', changedBy: 'student', changedAt: now });
    if (renewal.status === 'Not Continuing') {
      renewal.history.push({ status: 'Not Continuing', note: parsed.fields.notContinuingReason, changedBy: 'student', changedAt: now });
    }
    await renewal.save();
    res.json({ renewal: { ...toStudentView(renewal), period: studentPeriodView(period) } });
  } catch (err) {
    console.error('Resubmit renewal error:', err);
    res.status(500).json({ error: 'Failed to save your renewal.' });
  }
}));

module.exports = router;
