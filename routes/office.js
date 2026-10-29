const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireOfficeHead } = require('../middleware/requireOfficeHead');
const DutyLog = require('../models/DutyLog');
const Student = require('../models/Student');
const RenewalPeriod = require('../models/RenewalPeriod');
const Renewal = require('../models/Renewal');
const OfficeRequest = require('../models/OfficeRequest');
const { findScholarship } = require('../data/scholarships');
const { summarize, currentTerm, todayInManila, entryHours } = require('../utils/dutyHours');
const { findHolders, parseEvaluationScores, previousTerm, EVALUATION_ITEMS, PASSING_AVERAGE } = require('../utils/renewals');
const { norm } = require('../utils/offices');
const { queueEmails, processOutbox } = require('../utils/outbox');
const { officeEvaluations, notifyIfReady, summariesFor, stateOf, nextTerm } = require('../utils/evaluations');
const { renderEmail } = require('../utils/emailTemplate');

// The office portal: the head of a duty office (listed by the AdSO in Duty
// hours → Offices) signs in with that school email and, for the SFAG
// scholars assigned to their office:
//   GET   /api/office/me
//   GET   /api/office/scholars?academicYear=&term=           their scholars and hours for a term
//                                                            (?all=1: every term, newest first)
//   GET   /api/office/scholars/:studentNumber?academicYear=&term=   one scholar's duties
//   PATCH /api/office/scholars/:studentNumber/entries        { academicYear, term, entryIds, status: 'confirmed' | 'flagged' | null, note }
//   GET   /api/office/evaluations                            this and last term's scholars with their
//                                                            evaluation state (in_progress / ready / done)
//   PUT   /api/office/evaluations/:studentNumber             { academicYear, term, scores, remarks }
//                                                            once the scholar's hours are complete
//   GET   /api/office/requests  ·  POST /api/office/requests { kind, scholar, count, note }
// Messages with the AdSO are in routes/messages.js (/api/messages/office…).

const TERMS = DutyLog.TERMS;
const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';

function parseTerm(q) {
  if (q.academicYear === undefined && q.term === undefined) return { value: currentTerm() };
  const academicYear = Number(q.academicYear);
  if (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2100 || !TERMS.includes(q.term)) return { error: 'Choose the term.' };
  return { value: { academicYear, term: q.term } };
}

// This office's duty logs for a term (office names match ignoring case).
async function officeLogs(office, term, extra = {}) {
  const logs = await DutyLog.find({ ...term, ...extra, officeAssigned: { $nin: [null, ''] } }).lean();
  return logs.filter(l => norm(l.officeAssigned) === norm(office));
}

function entryView(e) {
  return { _id: String(e._id), date: e.date, timeIn: e.timeIn, timeOut: e.timeOut, hours: entryHours(e), status: e.status ?? null, note: e.note ?? null, reviewedAt: e.reviewedAt ?? null };
}

router.get('/me', requireOfficeHead, (req, res) => {
  res.json({ ...req.officeHead, current: currentTerm(), evaluationItems: EVALUATION_ITEMS, passingAverage: PASSING_AVERAGE });
});

router.get('/scholars', requireOfficeHead, async (req, res) => {
  try {
    const all = req.query.all === '1';
    const { value: term, error } = all ? { value: null } : parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const logs = await officeLogs(req.officeHead.office, term ?? {});
    const students = await Student.find({ studentNumber: { $in: logs.map(l => l.studentNumber) } }).select('studentNumber name programCode yearLevel avatarUrl').lean();
    const byNumber = new Map(students.map(s => [s.studentNumber, s]));
    const today = todayInManila();
    const full = await summariesFor(logs);
    res.json({
      term,
      current: currentTerm(),
      scholars: logs.map(l => {
        const s = byNumber.get(l.studentNumber);
        const summary = summarize(l, today, { confirmationRequired: true });
        const f = full.get(String(l._id));
        return {
          studentNumber: l.studentNumber,
          name: s?.name ?? '',
          program: s?.programCode ?? '',
          yearLevel: s?.yearLevel ?? '',
          avatarUrl: s?.avatarUrl,
          academicYear: l.academicYear,
          term: l.term,
          confirmedHours: summary.regularHours,
          waitingHours: summary.waitingHours,
          waitingCount: summary.waitingCount,
          flaggedCount: summary.flaggedCount,
          lastDutyDate: summary.lastDutyDate,
          // Toward the requirement (incl. approved event credit), and
          // whether the head can evaluate yet.
          completedHours: f?.completed ?? summary.regularHours,
          requiredHours: f?.required ?? null,
          evaluationState: stateOf(l, f),
        };
      }).sort((a, b) => b.academicYear - a.academicYear || b.term.localeCompare(a.term) || b.waitingCount - a.waitingCount || a.name.localeCompare(b.name)),
    });
  } catch (err) {
    console.error('Office scholars error:', err);
    res.status(500).json({ error: 'Failed to load your scholars.' });
  }
});

async function findOfficeLog(req, term) {
  if (!/^\d{9}$/.test(req.params.studentNumber)) return null;
  const [log] = await officeLogs(req.officeHead.office, term, { studentNumber: req.params.studentNumber });
  return log ?? null;
}

// Toward the requirement: confirmed hours plus approved event credit, and
// the hours the AdSO requires (null when not set).
async function progressOf(log) {
  const s = (await summariesFor([log])).get(String(log._id));
  return { completed: s?.completed ?? 0, required: s?.required ?? null };
}

router.get('/scholars/:studentNumber', requireOfficeHead, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const log = await findOfficeLog(req, term);
    if (!log) return res.status(404).json({ error: 'This scholar isn’t assigned to your office for that term.' });
    const student = await Student.findOne({ studentNumber: log.studentNumber }).select('studentNumber name programCode yearLevel avatarUrl').lean();
    const { _id, ...s } = student || {};
    res.json({
      term,
      student: s,
      entries: [...log.entries].sort((a, b) => (a.date + a.timeIn).localeCompare(b.date + b.timeIn)).map(entryView),
      summary: summarize(log, todayInManila(), { confirmationRequired: true }),
      progress: await progressOf(log),
    });
  } catch (err) {
    console.error('Office scholar log error:', err);
    res.status(500).json({ error: 'Failed to load the duties.' });
  }
});

router.patch('/scholars/:studentNumber/entries', requireOfficeHead, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error } = parseTerm(body);
    if (error) return res.status(400).json({ error });
    const ids = Array.isArray(body.entryIds) ? body.entryIds.filter(id => mongoose.Types.ObjectId.isValid(id)).map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose the duties.' });
    const status = body.status ?? null;
    if (status !== null && !DutyLog.ENTRY_STATUSES.includes(status)) return res.status(400).json({ error: 'Confirm or flag the duties.' });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (status === 'flagged' && !note) return res.status(400).json({ error: 'Say what’s wrong with the duty so the scholar can fix it.' });

    const log = await findOfficeLog(req, term);
    if (!log) return res.status(404).json({ error: 'This scholar isn’t assigned to your office for that term.' });
    const known = new Set(log.entries.map(e => String(e._id)));
    if (ids.some(id => !known.has(id))) return res.status(409).json({ error: 'The scholar changed their duties. Reload and try again.' });

    const set = {};
    const unset = {};
    log.entries.forEach((e, i) => {
      if (!ids.includes(String(e._id))) return;
      if (status) {
        Object.assign(set, { [`entries.${i}.status`]: status, [`entries.${i}.reviewedBy`]: req.officeHead.email, [`entries.${i}.reviewedAt`]: new Date() });
        if (note) set[`entries.${i}.note`] = note; else unset[`entries.${i}.note`] = '';
      } else {
        Object.assign(unset, { [`entries.${i}.status`]: '', [`entries.${i}.reviewedBy`]: '', [`entries.${i}.reviewedAt`]: '', [`entries.${i}.note`]: '' });
      }
    });
    // Only if the duties are still the same ones (the scholar may be saving).
    const updated = await DutyLog.findOneAndUpdate(
      { _id: log._id, 'entries._id': { $all: ids.map(id => new mongoose.Types.ObjectId(id)) } },
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) return res.status(409).json({ error: 'The scholar changed their duties. Reload and try again.' });
    // Hours complete now? Email the head that they can evaluate.
    if (status === 'confirmed') notifyIfReady(updated._id);
    res.json({
      entries: [...updated.entries].sort((a, b) => (a.date + a.timeIn).localeCompare(b.date + b.timeIn)).map(entryView),
      summary: summarize(updated, todayInManila(), { confirmationRequired: true }),
      progress: await progressOf(updated),
    });
  } catch (err) {
    console.error('Confirm duties error:', err);
    res.status(500).json({ error: 'Failed to save.' });
  }
});

// --- Evaluations ---------------------------------------------------------------
// A scholar can be evaluated once their duty hours for the term are
// complete (utils/evaluations.js); the head is emailed at that moment.

router.get('/evaluations', requireOfficeHead, async (req, res) => {
  try {
    res.json({ terms: await officeEvaluations(req.officeHead.office) });
  } catch (err) {
    console.error('Office evaluations error:', err);
    res.status(500).json({ error: 'Failed to load the evaluations.' });
  }
});

router.put('/evaluations/:studentNumber', requireOfficeHead, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error: termError } = parseTerm({ academicYear: body.academicYear, term: body.term });
    if (termError || body.academicYear === undefined) return res.status(400).json({ error: termError || 'Choose the term.' });
    const { scores, average, error } = parseEvaluationScores(body.scores);
    if (error) return res.status(400).json({ error });
    const log = await findOfficeLog(req, term);
    if (!log) return res.status(404).json({ error: 'This scholar didn’t render duty in your office that term.' });
    const summary = (await summariesFor([log])).get(String(log._id));
    if (stateOf(log, summary) === 'in_progress') {
      return res.status(409).json({ error: `You can evaluate once the scholar completes their hours (${summary?.completed ?? 0} of ${summary?.required ?? '?'} so far).` });
    }
    // The renewal that looks back on this term, if submitted.
    const next = nextTerm(term);
    const periods = await RenewalPeriod.find(next).select('_id').lean();
    const renewal = periods.length ? await Renewal.findOne({ periodId: { $in: periods.map(p => p._id) }, studentNumber: log.studentNumber }) : null;
    if (renewal && ['Renewed', 'Not Renewed'].includes(renewal.status)) return res.status(409).json({ error: 'The scholarship office already decided this scholar’s renewal.' });

    const evaluation = {
      scores,
      average,
      evaluatorName: req.officeHead.name,
      assignedOffice: log.officeAssigned,
      remarks: typeof body.remarks === 'string' ? body.remarks.trim().slice(0, 2000) || undefined : undefined,
      enteredBy: req.officeHead.email,
      enteredAt: new Date(),
      source: 'office',
    };
    await DutyLog.updateOne({ _id: log._id }, { $set: { evaluation } });
    if (renewal && renewal.continuing) {
      renewal.evaluation = evaluation;
      await renewal.save();
    }
    res.json({ evaluation: { scores, average, remarks: evaluation.remarks ?? null, enteredAt: evaluation.enteredAt, source: 'office' } });
  } catch (err) {
    console.error('Save office evaluation error:', err);
    res.status(500).json({ error: 'Failed to save the evaluation.' });
  }
});

// --- Requests ------------------------------------------------------------------

router.get('/requests', requireOfficeHead, async (req, res) => {
  try {
    const all = await OfficeRequest.find({}).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ requests: all.filter(r => norm(r.office) === norm(req.officeHead.office)) });
  } catch (err) {
    console.error('Office requests error:', err);
    res.status(500).json({ error: 'Failed to load your requests.' });
  }
});

router.post('/requests', requireOfficeHead, async (req, res) => {
  try {
    const body = req.body || {};
    if (!OfficeRequest.KINDS.includes(body.kind)) return res.status(400).json({ error: 'Choose what you’re requesting.' });
    const scholar = typeof body.scholar === 'string' ? body.scholar.trim().slice(0, 200) : '';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    const count = body.count === undefined || body.count === '' ? undefined : Number(body.count);
    if (body.kind === 'specific' && !scholar) return res.status(400).json({ error: 'Enter the scholar’s name or student number.' });
    if ((body.kind === 'more' || body.kind === 'fewer') && (!Number.isInteger(count) || count < 1 || count > 20)) return res.status(400).json({ error: 'Enter how many scholars (1–20).' });
    if (body.kind === 'other' && !note) return res.status(400).json({ error: 'Write your request.' });
    const term = currentTerm();
    const request = await OfficeRequest.create({
      office: req.officeHead.office, headEmail: req.officeHead.email, headName: req.officeHead.name,
      kind: body.kind, ...(scholar ? { scholar } : {}), ...(count ? { count } : {}), ...(note ? { note } : {}),
      ...term,
    });
    if (process.env.ADSO_NOTIFY_EMAIL) {
      const what = { specific: `a specific scholar: ${scholar}`, more: `${count} more scholar${count === 1 ? '' : 's'}`, fewer: `${count} fewer scholar${count === 1 ? '' : 's'}`, other: 'something else' }[body.kind];
      const email = renderEmail({
        heading: `Request from ${req.officeHead.office}`,
        intro: `${req.officeHead.name || req.officeHead.email} asked for ${what}.`,
        body: note,
        button: { url: appUrl(), label: 'Open Duty hours → Requests' },
      });
      // Through the outbox, like message alerts (sent within the email limits).
      queueEmails([{ key: `office-request:${request._id}`, kind: 'officeRequest', priority: 1, to: process.env.ADSO_NOTIFY_EMAIL, subject: `AniSkolar: request from ${req.officeHead.office}`, ...email }])
        .then(n => n && processOutbox())
        .catch(err => console.error('Queueing the request email failed:', err));
    }
    res.status(201).json({ request });
  } catch (err) {
    console.error('Create office request error:', err);
    res.status(500).json({ error: 'Failed to send the request.' });
  }
});

module.exports = router;
