const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdso } = require('../middleware/requireAdmin');
const { requireSfagScholar, SFAG_ID } = require('../middleware/requireStudent');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const DutyLog = require('../models/DutyLog');
const DutySetting = require('../models/DutySetting');
const DutyEvent = require('../models/DutyEvent');
const { norm, officesWithHeads } = require('../utils/offices');
const Student = require('../models/Student');
const { findCurrentHolders } = require('../utils/renewals');
const { summarize, parseLog, currentTerm, todayInManila, isValidDate } = require('../utils/dutyHours');
const multer = require('multer');
const { attendanceSheetUpload } = require('../middleware/uploadConfig');
const { putFile, openFile, deleteFile } = require('../utils/gridfs');

// Duty hours monitoring.
//
// Duty hours are an SFAG requirement only.
//
// SFAG scholar (approved for or renewed on the SFAG at some point; others get 403):
//   GET /api/duty-hours/mine?academicYear=&term=   their log for a term (default: current) + totals
//   PUT /api/duty-hours/mine                       save the whole log for a term
//   DELETE /api/duty-hours/mine/claims/:eventId    withdraw a Pending claim made before the
//                                                  attendance sheets (scholars no longer claim)
//
// AdSO:
//   GET /api/duty-hours/admin?academicYear=&term=  every SFAG holder for the term, plus any other
//                                                  SFAG scholar who logged hours for it, with totals
//   GET /api/duty-hours/admin/:id                  one log in full
//   GET /api/duty-hours/admin/settings             required hours per year group and grant percentage
//   PUT /api/duty-hours/admin/settings             { hoursByGroup: { lower: { 100, 75, 50, 25 }, upper: { … } } }
//                                                  (lower = 1st–2nd year, upper = 3rd year and up;
//                                                  null = scholars enter it)
//   GET /api/duty-hours/admin/events?academicYear=&term=  credited events for the term (with claim
//                                                  counts) and every claim waiting for review
//   POST /api/duty-hours/admin/events              { name, date, organizer, creditHours }
//   PUT /api/duty-hours/admin/events/:id           edit one
//   DELETE /api/duty-hours/admin/events/:id        delete one (not once a claim is approved)
//   PUT /api/duty-hours/admin/claims               { studentNumber, eventId, status: Approved|Rejected, note }
//                                                  (older claims made by scholars)
//   POST /api/duty-hours/admin/events/:id/sheets   multipart "sheets": the signed attendance sheets
//   GET  /api/duty-hours/admin/events/:id/sheets/:fileId   one sheet
//   DELETE /api/duty-hours/admin/events/:id/sheets/:fileId
//   GET  /api/duty-hours/admin/events/:id/attendance       the term's SFAG scholars, who attended
//   PUT  /api/duty-hours/admin/events/:id/attendance       { studentNumbers } exactly who attended:
//                                                  they're credited, anyone unticked is uncredited
//   PUT /api/duty-hours/admin/office-slots         { officeSlots: [{ office, slots }] } — how many
//                                                  scholars each office takes (for Random assign)
//   PUT /api/duty-hours/admin/deadline             { academicYear, term, deadline } the term's duty
//                                                  deadline ('' = none); copied onto every log of the term
//   PUT /api/duty-hours/admin/office               assign the office one or more scholars render
//                                                  duty in for a term ({ academicYear, term,
//                                                  studentNumbers, officeAssigned }; '' = unassign)

const { TERMS } = DutyLog;
// The SFAG carries the duty requirement; its holders are listed on
// the admin page even before they log anything.
const DUTY_SCHOLARSHIP_ID = SFAG_ID;

// Of these students, the ones who have ever been SFAG scholars (approved
// or renewed). Logs from anyone else aren't duty hours.
async function everSfag(studentNumbers) {
  if (!studentNumbers.length) return new Set();
  const [approved, renewed] = await Promise.all([
    Application.distinct('studentNumber', { studentNumber: { $in: studentNumbers }, scholarshipId: SFAG_ID, status: 'Approved' }),
    Renewal.distinct('studentNumber', { studentNumber: { $in: studentNumbers }, scholarshipId: SFAG_ID, status: 'Renewed' }),
  ]);
  return new Set([...approved, ...renewed]);
}

function parseTerm(source) {
  if (source.academicYear === undefined && source.term === undefined) return { value: currentTerm() };
  const academicYear = Number(source.academicYear);
  if (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2100) return { error: 'Choose the academic year.' };
  if (!TERMS.includes(source.term)) return { error: 'Choose the term.' };
  return { value: { academicYear, term: source.term } };
}

// Required hours follow the scholar's grant percentage and year level
// (from their profile) when the AdSO has set hours for that pair
// (DutySetting); otherwise the scholar enters them. Returns Map
// studentNumber -> { percentage, yearGroup, requiredHours } for the latest
// approved SFAG application that has a percentage.
async function dutyRules(studentNumbers) {
  if (!studentNumbers.length) return new Map();
  const [apps, students, settings] = await Promise.all([
    Application.find({ studentNumber: { $in: studentNumbers }, scholarshipId: SFAG_ID, status: 'Approved', sfagPercentage: { $exists: true } })
      .select('studentNumber sfagPercentage reviewedAt createdAt').sort({ reviewedAt: -1, createdAt: -1 }).lean(),
    Student.find({ studentNumber: { $in: studentNumbers } }).select('studentNumber yearLevel').lean(),
    DutySetting.current(),
  ]);
  const yearLevelOf = new Map(students.map(s => [s.studentNumber, s.yearLevel]));
  const rules = new Map();
  for (const a of apps) {
    if (rules.has(a.studentNumber)) continue;
    const yearGroup = DutySetting.yearGroupOf(yearLevelOf.get(a.studentNumber));
    const requiredHours = yearGroup ? settings.hoursByGroup[yearGroup][a.sfagPercentage] ?? null : null;
    rules.set(a.studentNumber, { percentage: a.sfagPercentage, yearGroup, requiredHours });
  }
  return rules;
}

// Credited events for a term, by id (string).
async function termEvents(term) {
  const events = await DutyEvent.find({ academicYear: term.academicYear, term: term.term }).sort({ date: -1, name: 1 }).lean();
  return new Map(events.map(e => [String(e._id), e]));
}

function eventView(e) {
  return { _id: String(e._id), name: e.name, date: e.date, organizer: e.organizer, creditHours: e.creditHours };
}

// The admin's view adds the uploaded sheets and when attendance was saved.
function adminEventView(e) {
  return {
    ...eventView(e),
    sheets: (e.sheets || []).map(s => ({ fileId: String(s.fileId), filename: s.filename, mimetype: s.mimetype, size: s.size, uploadedAt: s.uploadedAt })),
    attendanceSavedAt: e.attendanceSavedAt ?? null,
  };
}

// The scholar's claims with their events (claims whose event was deleted
// are left out).
function claimsView(log, eventsById) {
  return (log.eventClaims || [])
    .filter(c => eventsById.has(String(c.event)))
    .map(c => ({
      ...eventView(eventsById.get(String(c.event))),
      eventId: String(c.event),
      status: c.status,
      note: c.note ?? null,
      claimedAt: c.claimedAt ?? null,
      reviewedAt: c.reviewedAt ?? null,
    }));
}

// The log with the AdSO's required hours in place of the scholar's and
// approved event claims added as special events (at the event's credit
// hours), plus `rule` saying where the hours came from and `claims`.
// headOffices: offices with a head in AniSkolar — their scholars' duties
// count once the head confirms them.
function logView(log, today, rule, eventsById = new Map(), headOffices = new Set()) {
  const fromAdso = rule?.requiredHours != null;
  const claims = claimsView(log, eventsById);
  const credited = claims.filter(c => c.status === 'Approved').map(c => ({ name: c.name, hours: c.creditHours, eventId: c.eventId }));
  const { eventClaims, ...rest } = log;
  const effective = {
    ...rest,
    ...(fromAdso ? { requiredHours: rule.requiredHours } : {}),
    specialEvents: [...(log.specialEvents || []), ...credited],
  };
  return {
    log: effective,
    summary: summarize(effective, today, { confirmationRequired: headOffices.has(norm(log.officeAssigned)) }),
    rule: { percentage: rule?.percentage ?? null, yearGroup: rule?.yearGroup ?? null, requiredHours: fromAdso ? rule.requiredHours : null },
    claims,
  };
}

// The scholar's copy leaves out who assigned the office. The office
// head's evaluation is shown to the scholar (scores, remarks, who and
// when), without the staff email that entered it.
function scholarLogView(log, today, rule, eventsById, headOffices) {
  const { officeAssignedBy, evaluation, ...rest } = log;
  return {
    ...logView(rest, today, rule, eventsById, headOffices),
    evaluated: !!evaluation?.average,
    evaluation: evaluation?.average ? scholarEvaluation(evaluation) : null,
  };
}

function scholarEvaluation(e) {
  return { scores: e.scores, average: e.average, remarks: e.remarks ?? null, evaluatorName: e.evaluatorName ?? null, assignedOffice: e.assignedOffice ?? null, enteredAt: e.enteredAt ?? null };
}

router.get('/mine', requireSfagScholar, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const [log, others, rules, eventsById] = await Promise.all([
      DutyLog.findOne({ studentNumber: req.studentNumber, ...term }).lean(),
      DutyLog.find({ studentNumber: req.studentNumber }).select('academicYear term').sort({ academicYear: -1, term: -1 }).lean(),
      dutyRules([req.studentNumber]),
      termEvents(term),
    ]);
    const empty = { ...term, studentNumber: req.studentNumber, entries: [], specialEvents: [], eventClaims: [], deadline: (await DutySetting.deadlineFor(term)) ?? undefined };
    res.json({
      current: currentTerm(),
      terms: others.map(({ academicYear, term: t }) => ({ academicYear, term: t })),
      ...scholarLogView(log ?? empty, todayInManila(), rules.get(req.studentNumber), eventsById, await officesWithHeads()),
      // Credited events of the term the scholar can claim.
      events: [...eventsById.values()].map(eventView),
    });
  } catch (err) {
    console.error('Load duty log error:', err);
    res.status(500).json({ error: 'Failed to load your duty hours.' });
  }
});

router.put('/mine', requireSfagScholar, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error: termError } = parseTerm({ academicYear: body.academicYear, term: body.term });
    if (termError) return res.status(400).json({ error: termError });
    // A duty the office head already confirmed or flagged keeps that (and
    // its id) as long as its date and times are unchanged; a new or edited
    // duty waits for the head again.
    const existing = await DutyLog.findOne({ studentNumber: req.studentNumber, ...term }).select('entries officeAssigned').lean();
    const before = new Map((existing?.entries || []).map(e => [`${e.date}|${e.timeIn}|${e.timeOut}`, e]));
    const { log, error } = parseLog(body, { keep: new Set(before.keys()) });
    if (error) return res.status(400).json({ error });
    // Duty is rendered in the office the AdSO assigns: no new duties before
    // that (removing old ones is fine; event claims are separate).
    if (!existing?.officeAssigned && log.entries.some(e => !before.has(`${e.date}|${e.timeIn}|${e.timeOut}`))) {
      return res.status(409).json({ error: 'You can log duties once the scholarship office assigns your office.' });
    }
    // A new duty is logged on the day it's rendered (AdSO, Nov 2026). The
    // one exception: correcting a duty the head flagged, which keeps its
    // date (the flagged one is replaced in the same save).
    const today = todayInManila();
    const keptKeys = new Set(log.entries.map(e => `${e.date}|${e.timeIn}|${e.timeOut}`));
    const fixableDates = (existing?.entries || [])
      .filter(e => e.status === 'flagged' && !keptKeys.has(`${e.date}|${e.timeIn}|${e.timeOut}`))
      .map(e => e.date);
    for (const e of log.entries) {
      if (before.has(`${e.date}|${e.timeIn}|${e.timeOut}`) || e.date === today) continue;
      const i = fixableDates.indexOf(e.date);
      if (i >= 0) { fixableDates.splice(i, 1); continue; }
      return res.status(400).json({ error: `Log a duty on the day you render it. You can’t add one for ${e.date}.` });
    }
    // Hours set by the AdSO for the scholar's percentage aren't theirs to change.
    const rule = (await dutyRules([req.studentNumber])).get(req.studentNumber);
    if (rule?.requiredHours != null) delete log.requiredHours;
    // The deadline is the AdSO's for the term.
    log.deadline = (await DutySetting.deadlineFor(term)) ?? undefined;
    log.entries = log.entries.map(e => {
      const old = before.get(`${e.date}|${e.timeIn}|${e.timeOut}`);
      if (!old) return { ...e, loggedAt: new Date() };
      before.delete(`${e.date}|${e.timeIn}|${e.timeOut}`);
      return { ...e, _id: old._id, ...(old.loggedAt ? { loggedAt: old.loggedAt } : {}), ...(old.status ? { status: old.status, reviewedBy: old.reviewedBy, reviewedAt: old.reviewedAt, note: old.note } : {}) };
    });

    const update = { $set: {}, $unset: {} };
    for (const [key, value] of Object.entries(log)) {
      if (value === undefined) update.$unset[key] = '';
      else update.$set[key] = value;
    }
    if (!Object.keys(update.$unset).length) delete update.$unset;
    const saved = await DutyLog.findOneAndUpdate(
      { studentNumber: req.studentNumber, ...term },
      update,
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    res.json(scholarLogView(saved, todayInManila(), rule, await termEvents(term), await officesWithHeads()));
  } catch (err) {
    console.error('Save duty log error:', err);
    res.status(500).json({ error: 'Failed to save your duty hours.' });
  }
});

router.get('/admin', requireAdso, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const today = todayInManila();
    const [holders, logs, offices] = await Promise.all([
      findCurrentHolders({ scholarshipId: DUTY_SCHOLARSHIP_ID, ...term }),
      DutyLog.find(term).lean(),
      DutyLog.distinct('officeAssigned'),
    ]);
    const sfagLoggers = await everSfag(logs.map(l => l.studentNumber).filter(n => !holders.has(n)));
    const logByStudent = new Map(logs.filter(l => holders.has(l.studentNumber) || sfagLoggers.has(l.studentNumber)).map(l => [l.studentNumber, l]));
    const studentNumbers = [...new Set([...holders, ...logByStudent.keys()])];
    const [rules, eventsById, headOffices] = await Promise.all([dutyRules(studentNumbers), termEvents(term), officesWithHeads()]);
    const students = await Student.find({ studentNumber: { $in: studentNumbers } })
      .select('studentNumber name email course programCode yearLevel avatarUrl').lean();
    const studentByNumber = new Map(students.map(s => [s.studentNumber, s]));

    const scholars = studentNumbers.map(studentNumber => {
      const s = studentByNumber.get(studentNumber);
      const view = logByStudent.has(studentNumber) ? logView(logByStudent.get(studentNumber), today, rules.get(studentNumber), eventsById, headOffices) : null;
      const log = view?.log;
      const rule = rules.get(studentNumber);
      return {
        studentNumber,
        name: s?.name ?? '',
        email: s?.email ?? '',
        program: s?.programCode || s?.course || '',
        yearLevel: s?.yearLevel ?? '',
        avatarUrl: s?.avatarUrl,
        sfaHolder: holders.has(studentNumber),
        logId: log?._id ?? null,
        officeAssigned: log?.officeAssigned ?? '',
        officeAssignedAt: log?.officeAssignedAt ?? null,
        deadline: log?.deadline ?? null,
        entryCount: log?.entries?.length ?? 0,
        summary: view?.summary ?? null,
        grantPercentage: rule?.percentage ?? null,
        requiredHoursFromAdso: rule?.requiredHours ?? null,
        yearGroup: rule?.yearGroup ?? null,
        pendingClaims: view ? view.claims.filter(c => c.status === 'Pending').length : 0,
        updatedAt: log?.updatedAt ?? null,
      };
    });
    res.json({
      term,
      current: currentTerm(),
      // The AdSO's duty deadline for this term (YYYY-MM-DD) or null.
      deadline: await DutySetting.deadlineFor(term),
      scholars,
      // Offices used in any term, for suggestions when assigning.
      offices: offices.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    });
  } catch (err) {
    console.error('Load duty hours (admin) error:', err);
    res.status(500).json({ error: 'Failed to load duty hours.' });
  }
});

router.get('/admin/settings', requireAdso, async (req, res) => {
  try {
    res.json(await DutySetting.current());
  } catch (err) {
    console.error('Load duty settings error:', err);
    res.status(500).json({ error: 'Failed to load the duty hours settings.' });
  }
});

router.put('/admin/settings', requireAdso, async (req, res) => {
  try {
    const input = req.body?.hoursByGroup;
    if (!input || typeof input !== 'object') return res.status(400).json({ error: 'Enter the hours for each grant percentage.' });
    const $set = { hoursSaved: true, updatedBy: req.adminUser.email || req.adminUser.id };
    const $unset = {};
    for (const g of DutySetting.YEAR_GROUPS) {
      const group = input[g] && typeof input[g] === 'object' ? input[g] : {};
      const label = g === 'lower' ? '1st–2nd year' : '3rd year and up';
      for (const p of DutySetting.GRANT_PERCENTAGES) {
        const raw = group[p];
        const path = `hours.${g}.${DutySetting.hoursKey(p)}`;
        if (raw === null || raw === '' || raw === undefined) { $unset[path] = ''; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: `Hours for ${p}% (${label}) must be between 0 and 1000.` });
        $set[path] = Math.round(n * 100) / 100;
      }
    }
    await DutySetting.findByIdAndUpdate('duty', { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { upsert: true, runValidators: true });
    res.json(await DutySetting.current());
  } catch (err) {
    console.error('Save duty settings error:', err);
    res.status(500).json({ error: 'Failed to save the duty hours settings.' });
  }
});

router.put('/admin/office-slots', requireAdso, async (req, res) => {
  try {
    const input = req.body?.officeSlots;
    if (!Array.isArray(input)) return res.status(400).json({ error: 'Enter the offices and their slots.' });
    if (input.length > 200) return res.status(400).json({ error: 'At most 200 offices.' });
    const seen = new Set();
    const heads = new Set();
    const officeSlots = [];
    // Head name / email not sent (Random assign) = keep what's saved.
    const saved = new Map(((await DutySetting.findById('duty').select('officeSlots').lean())?.officeSlots ?? []).map(o => [norm(o.office), o]));
    for (const row of input) {
      const office = typeof row?.office === 'string' ? row.office.replace(/\s+/g, ' ').trim() : '';
      if (!office) return res.status(400).json({ error: 'Every office needs a name.' });
      if (office.length > 200) return res.status(400).json({ error: 'An office name is too long (200 characters at most).' });
      const slots = Number(row.slots);
      if (!Number.isInteger(slots) || slots < 0 || slots > 50) return res.status(400).json({ error: `Slots for ${office} must be a whole number from 0 to 50.` });
      const k = office.toLowerCase();
      if (seen.has(k)) return res.status(400).json({ error: `${office} is listed twice.` });
      seen.add(k);
      const old = saved.get(norm(office));
      const headName = row.headName === undefined ? old?.headName : String(row.headName || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const headEmail = row.headEmail === undefined ? old?.headEmail : String(row.headEmail || '').trim().toLowerCase();
      if (headEmail) {
        if (!/^[^\s@]+@dlsud\.edu\.ph$/.test(headEmail)) return res.status(400).json({ error: `The head's email for ${office} must be a @dlsud.edu.ph address.` });
        if (heads.has(headEmail)) return res.status(400).json({ error: `${headEmail} is the head of two offices; each office needs its own head.` });
        heads.add(headEmail);
      }
      officeSlots.push({ office, slots, ...(headName ? { headName } : {}), ...(headEmail ? { headEmail } : {}) });
    }
    await DutySetting.findByIdAndUpdate('duty', { $set: { officeSlots, updatedBy: req.adminUser.email || req.adminUser.id } }, { upsert: true, runValidators: true });
    res.json(await DutySetting.current());
  } catch (err) {
    console.error('Save office slots error:', err);
    res.status(500).json({ error: 'Failed to save the office slots.' });
  }
});

router.put('/admin/deadline', requireAdso, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error } = parseTerm({ academicYear: body.academicYear, term: body.term });
    if (error) return res.status(400).json({ error });
    const deadline = typeof body.deadline === 'string' ? body.deadline.trim() : '';
    if (deadline && !isValidDate(deadline)) return res.status(400).json({ error: 'Choose a valid date.' });
    const setting = await DutySetting.findById('duty').select('deadlines').lean();
    const others = (setting?.deadlines ?? []).filter(d => !(d.academicYear === term.academicYear && d.term === term.term));
    const deadlines = deadline ? [...others, { ...term, date: deadline }] : others;
    await DutySetting.findByIdAndUpdate('duty', { $set: { deadlines, updatedBy: req.adminUser.email || req.adminUser.id } }, { upsert: true, runValidators: true });
    await DutyLog.updateMany(term, deadline ? { $set: { deadline } } : { $unset: { deadline: '' } });
    res.json({ term, deadline: deadline || null });
  } catch (err) {
    console.error('Set duty deadline error:', err);
    res.status(500).json({ error: 'Failed to save the deadline.' });
  }
});

router.put('/admin/office', requireAdso, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error } = parseTerm({ academicYear: body.academicYear, term: body.term });
    if (error) return res.status(400).json({ error });
    if (typeof body.officeAssigned !== 'string') return res.status(400).json({ error: 'Enter the office.' });
    const office = body.officeAssigned.replace(/\s+/g, ' ').trim();
    if (office.length > 200) return res.status(400).json({ error: 'The office name is too long (200 characters at most).' });
    const studentNumbers = Array.isArray(body.studentNumbers)
      ? [...new Set(body.studentNumbers.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))]
      : [];
    if (!studentNumbers.length) return res.status(400).json({ error: 'Choose at least one scholar.' });
    if (studentNumbers.length > 1000) return res.status(400).json({ error: 'Assign at most 1,000 scholars at a time.' });

    // Only scholars on this term's list: SFAG holders, or another SFAG
    // scholar who already has a log for the term.
    const [holders, logged] = await Promise.all([
      findCurrentHolders({ scholarshipId: DUTY_SCHOLARSHIP_ID, ...term }),
      DutyLog.find({ ...term, studentNumber: { $in: studentNumbers } }).distinct('studentNumber'),
    ]);
    const loggedSet = new Set(logged);
    const sfagLoggers = await everSfag(logged.filter(n => !holders.has(n)));
    const unknown = studentNumbers.filter(n => !holders.has(n) && !sfagLoggers.has(n));
    if (unknown.length) {
      return res.status(400).json({ error: `Not an SFAG scholar for this term: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.` });
    }

    const termDeadline = await DutySetting.deadlineFor(term);
    const update = office
      ? {
          $set: { officeAssigned: office, officeAssignedBy: req.adminUser.email || req.adminUser.id, officeAssignedAt: new Date() },
          $setOnInsert: { entries: [], specialEvents: [], ...(termDeadline ? { deadline: termDeadline } : {}) },
        }
      : { $unset: { officeAssigned: '', officeAssignedBy: '', officeAssignedAt: '' } };
    // Assigning creates the scholar's log for the term if they haven't
    // started one; unassigning never does.
    const ops = studentNumbers
      .filter(n => office || loggedSet.has(n))
      .map(studentNumber => ({
        updateOne: { filter: { studentNumber, ...term }, update, upsert: Boolean(office) },
      }));
    if (ops.length) await DutyLog.bulkWrite(ops);
    res.json({ updated: studentNumbers.length, officeAssigned: office });
  } catch (err) {
    console.error('Assign duty office error:', err);
    res.status(500).json({ error: 'Failed to assign the office.' });
  }
});

// --- Credited events -------------------------------------------------------------

function parseEvent(body) {
  const name = typeof body?.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Enter the event name.' };
  if (name.length > 200) return { error: 'The event name is too long (200 characters at most).' };
  if (!isValidDate(body.date)) return { error: 'Enter the event date.' };
  if (!DutyEvent.ORGANIZERS.includes(body.organizer)) return { error: 'Choose who organized it.' };
  const creditHours = Number(body.creditHours);
  if (!Number.isFinite(creditHours) || creditHours < 0.25 || creditHours > 24) return { error: 'Credit hours must be from 0.25 to 24.' };
  // The duty term the date falls in (noon Manila time, so the day is right).
  const term = currentTerm(new Date(`${body.date}T12:00:00+08:00`));
  return { value: { name, date: body.date, organizer: body.organizer, creditHours: Math.round(creditHours * 100) / 100, ...term } };
}

// Scholars sign the event's attendance sheet instead; the AdSO credits
// them from it.
router.post('/mine/claims', requireSfagScholar, (req, res) => {
  res.status(410).json({ error: 'Sign the attendance sheet at the event. The scholarship office credits you from it.' });
});

// Unused since the attendance sheets; kept for reference.
router.post('/mine/claims-legacy', requireSfagScholar, async (req, res) => {
  try {
    const eventId = req.body?.eventId;
    if (typeof eventId !== 'string' || !mongoose.Types.ObjectId.isValid(eventId)) return res.status(400).json({ error: 'Choose an event.' });
    const event = await DutyEvent.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    if (event.date > todayInManila()) return res.status(400).json({ error: 'You can claim an event once it has taken place.' });
    const term = { academicYear: event.academicYear, term: event.term };
    // One claim per event; the filter makes a double tap a no-op.
    const termDeadline = await DutySetting.deadlineFor(term);
    const updated = await DutyLog.findOneAndUpdate(
      { studentNumber: req.studentNumber, ...term, 'eventClaims.event': { $ne: event._id } },
      { $push: { eventClaims: { event: event._id, status: 'Pending', claimedAt: new Date() } }, $setOnInsert: { entries: [], specialEvents: [], ...(termDeadline ? { deadline: termDeadline } : {}) } },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    ).lean().catch(err => (err.code === 11000 ? null : Promise.reject(err)));
    if (!updated) return res.status(409).json({ error: 'You already claimed this event.' });
    const [rules, eventsById] = await Promise.all([dutyRules([req.studentNumber]), termEvents(term)]);
    res.status(201).json(scholarLogView(updated, todayInManila(), rules.get(req.studentNumber), eventsById, await officesWithHeads()));
  } catch (err) {
    console.error('Claim event error:', err);
    res.status(500).json({ error: 'Failed to claim the event.' });
  }
});

router.delete('/mine/claims/:eventId', requireSfagScholar, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.eventId)) return res.status(400).json({ error: 'Invalid event.' });
    const event = await DutyEvent.findById(req.params.eventId).lean();
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    const term = { academicYear: event.academicYear, term: event.term };
    // Only a claim still waiting for review can be withdrawn.
    const updated = await DutyLog.findOneAndUpdate(
      { studentNumber: req.studentNumber, ...term, eventClaims: { $elemMatch: { event: event._id, status: 'Pending' } } },
      { $pull: { eventClaims: { event: event._id } } },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) return res.status(409).json({ error: 'Only a claim waiting for review can be withdrawn.' });
    const [rules, eventsById] = await Promise.all([dutyRules([req.studentNumber]), termEvents(term)]);
    res.json(scholarLogView(updated, todayInManila(), rules.get(req.studentNumber), eventsById, await officesWithHeads()));
  } catch (err) {
    console.error('Withdraw claim error:', err);
    res.status(500).json({ error: 'Failed to withdraw the claim.' });
  }
});

router.get('/admin/events', requireAdso, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const [eventsById, logs] = await Promise.all([
      termEvents(term),
      DutyLog.find({ ...term, 'eventClaims.0': { $exists: true } }).select('studentNumber eventClaims').lean(),
    ]);
    const counts = new Map();
    const pending = [];
    for (const log of logs) {
      for (const c of log.eventClaims) {
        const id = String(c.event);
        if (!eventsById.has(id)) continue;
        const n = counts.get(id) ?? { Pending: 0, Approved: 0, Rejected: 0 };
        n[c.status]++;
        counts.set(id, n);
        if (c.status === 'Pending') pending.push({ studentNumber: log.studentNumber, eventId: id, claimedAt: c.claimedAt });
      }
    }
    const students = await Student.find({ studentNumber: { $in: [...new Set(pending.map(p => p.studentNumber))] } }).select('studentNumber name').lean();
    const nameOf = new Map(students.map(s => [s.studentNumber, s.name]));
    res.json({
      term,
      events: [...eventsById.values()].map(e => ({ ...adminEventView(e), claims: counts.get(String(e._id)) ?? { Pending: 0, Approved: 0, Rejected: 0 } })),
      pending: pending
        .sort((a, b) => new Date(a.claimedAt) - new Date(b.claimedAt))
        .map(p => ({ ...p, name: nameOf.get(p.studentNumber) ?? '', event: eventView(eventsById.get(p.eventId)) })),
    });
  } catch (err) {
    console.error('Load duty events error:', err);
    res.status(500).json({ error: 'Failed to load the events.' });
  }
});

router.post('/admin/events', requireAdso, async (req, res) => {
  try {
    const { value, error } = parseEvent(req.body);
    if (error) return res.status(400).json({ error });
    const by = req.adminUser.email || req.adminUser.id;
    const event = await DutyEvent.create({ ...value, createdBy: by, updatedBy: by });
    res.status(201).json({ event: eventView(event) });
  } catch (err) {
    console.error('Create duty event error:', err);
    res.status(500).json({ error: 'Failed to add the event.' });
  }
});

router.put('/admin/events/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid event.' });
    const { value, error } = parseEvent(req.body);
    if (error) return res.status(400).json({ error });
    const event = await DutyEvent.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    // Claims live in the term's duty logs, so an event with claims can't
    // move to another term.
    if ((value.academicYear !== event.academicYear || value.term !== event.term)
      && await DutyLog.exists({ 'eventClaims.event': event._id })) {
      return res.status(409).json({ error: 'Scholars have claimed this event, so its date must stay in the same term.' });
    }
    Object.assign(event, value, { updatedBy: req.adminUser.email || req.adminUser.id });
    await event.save();
    res.json({ event: eventView(event) });
  } catch (err) {
    console.error('Update duty event error:', err);
    res.status(500).json({ error: 'Failed to save the event.' });
  }
});

router.delete('/admin/events/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid event.' });
    const event = await DutyEvent.findById(req.params.id).lean();
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    if (await DutyLog.exists({ eventClaims: { $elemMatch: { event: event._id, status: 'Approved' } } })) {
      return res.status(409).json({ error: 'Scholars have been credited for this event. Reject their claims first if it should be removed.' });
    }
    await DutyLog.updateMany({ 'eventClaims.event': event._id }, { $pull: { eventClaims: { event: event._id } } });
    await DutyEvent.deleteOne({ _id: event._id });
    for (const s of event.sheets || []) await deleteFile(s.fileId).catch(err => console.error('Failed to delete an attendance sheet:', err.message));
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete duty event error:', err);
    res.status(500).json({ error: 'Failed to delete the event.' });
  }
});

router.put('/admin/claims', requireAdso, async (req, res) => {
  try {
    const { studentNumber, eventId, status } = req.body || {};
    if (typeof studentNumber !== 'string' || !studentNumber.trim()) return res.status(400).json({ error: 'Choose the scholar.' });
    if (typeof eventId !== 'string' || !mongoose.Types.ObjectId.isValid(eventId)) return res.status(400).json({ error: 'Choose the event.' });
    if (status !== 'Approved' && status !== 'Rejected') return res.status(400).json({ error: 'Choose Approve or Reject.' });
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const event = await DutyEvent.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    const updated = await DutyLog.findOneAndUpdate(
      { studentNumber: studentNumber.trim(), academicYear: event.academicYear, term: event.term, 'eventClaims.event': event._id },
      {
        $set: {
          'eventClaims.$.status': status,
          'eventClaims.$.reviewedBy': req.adminUser.email || req.adminUser.id,
          'eventClaims.$.reviewedAt': new Date(),
          ...(note ? { 'eventClaims.$.note': note } : {}),
        },
        ...(note ? {} : { $unset: { 'eventClaims.$.note': '' } }),
      },
      { returnDocument: 'after' }
    ).lean();
    if (!updated) return res.status(404).json({ error: "This scholar hasn't claimed this event." });
    // Event credit can complete the hours: tell the office head.
    if (status === 'Approved') require('../utils/evaluations').notifyIfReady(updated._id);
    res.json({ studentNumber: updated.studentNumber, eventId, status });
  } catch (err) {
    console.error('Review event claim error:', err);
    res.status(500).json({ error: 'Failed to save the decision.' });
  }
});

// --- Attendance sheets --------------------------------------------------------------

const SHEET_SIGNATURES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };
const isRealSheet = f => SHEET_SIGNATURES[f.mimetype]?.every((b, i) => f.buffer[i] === b);
const MAX_SHEETS = 30;

async function findEvent(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid event.' }); return null; }
  const event = await DutyEvent.findById(req.params.id);
  if (!event) { res.status(404).json({ error: 'Event not found.' }); return null; }
  return event;
}

router.post('/admin/events/:id/sheets', requireAdso, (req, res, next) => {
  attendanceSheetUpload(req, res, err => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 10MB.' : 'Upload at most 10 files at a time.' });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const event = await findEvent(req, res);
    if (!event) return;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Choose the photos or scans of the signed sheets.' });
    const bad = files.find(f => !isRealSheet(f));
    if (bad) return res.status(400).json({ error: `"${bad.originalname}" isn't a real JPG, PNG or PDF.` });
    if (event.sheets.length + files.length > MAX_SHEETS) return res.status(400).json({ error: `An event can have up to ${MAX_SHEETS} sheet files.` });
    const by = req.adminUser.email || req.adminUser.id;
    for (const f of files) {
      const fileId = await putFile({ buffer: f.buffer, filename: f.originalname, mimetype: f.mimetype, metadata: { kind: 'attendance-sheet', eventId: String(event._id) } });
      event.sheets.push({ fileId, filename: f.originalname, mimetype: f.mimetype, size: f.size, uploadedBy: by, uploadedAt: new Date() });
    }
    await event.save();
    res.status(201).json({ event: adminEventView(event) });
  } catch (err) {
    console.error('Upload attendance sheet error:', err);
    res.status(500).json({ error: 'Failed to upload the sheets.' });
  }
});

router.get('/admin/events/:id/sheets/:fileId', requireAdso, async (req, res) => {
  try {
    const event = await findEvent(req, res);
    if (!event) return;
    const sheet = event.sheets.find(s => String(s.fileId) === req.params.fileId);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found.' });
    const file = await openFile(sheet.fileId);
    if (!file) return res.status(404).json({ error: 'Sheet not found.' });
    res.set('Content-Type', sheet.mimetype || file.contentType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(sheet.filename || 'sheet')}"`);
    res.set('Cache-Control', 'private, max-age=300');
    file.stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); }).pipe(res);
  } catch (err) {
    console.error('Open attendance sheet error:', err);
    res.status(500).json({ error: 'Failed to open the sheet.' });
  }
});

router.delete('/admin/events/:id/sheets/:fileId', requireAdso, async (req, res) => {
  try {
    const event = await findEvent(req, res);
    if (!event) return;
    const sheet = event.sheets.find(s => String(s.fileId) === req.params.fileId);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found.' });
    event.sheets = event.sheets.filter(s => s !== sheet);
    await event.save();
    await deleteFile(sheet.fileId).catch(err => console.error('Failed to delete an attendance sheet:', err.message));
    res.json({ event: adminEventView(event) });
  } catch (err) {
    console.error('Delete attendance sheet error:', err);
    res.status(500).json({ error: 'Failed to delete the sheet.' });
  }
});

// The term's SFAG scholars (holders, and anyone who logged for the term),
// for ticking who signed the sheet.
async function termScholars(term) {
  const [holders, logged] = await Promise.all([
    findCurrentHolders({ scholarshipId: DUTY_SCHOLARSHIP_ID, ...term }),
    DutyLog.find(term).distinct('studentNumber'),
  ]);
  const others = await everSfag(logged.filter(n => !holders.has(n)));
  const numbers = [...new Set([...holders.keys(), ...others])];
  const students = await Student.find({ studentNumber: { $in: numbers } }).select('studentNumber name programCode yearLevel').lean();
  const byNumber = new Map(students.map(s => [s.studentNumber, s]));
  return numbers.map(n => ({ studentNumber: n, name: byNumber.get(n)?.name ?? '', program: byNumber.get(n)?.programCode ?? '', yearLevel: byNumber.get(n)?.yearLevel ?? '' }));
}

router.get('/admin/events/:id/attendance', requireAdso, async (req, res) => {
  try {
    const event = await findEvent(req, res);
    if (!event) return;
    const term = { academicYear: event.academicYear, term: event.term };
    const [scholars, logs] = await Promise.all([
      termScholars(term),
      DutyLog.find({ ...term, 'eventClaims.event': event._id }).select('studentNumber eventClaims').lean(),
    ]);
    const statusOf = new Map(logs.map(l => [l.studentNumber, l.eventClaims.find(c => String(c.event) === String(event._id))?.status]));
    res.json({
      event: adminEventView(event),
      scholars: scholars
        .map(s => ({ ...s, attended: statusOf.get(s.studentNumber) === 'Approved', claim: statusOf.get(s.studentNumber) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.studentNumber.localeCompare(b.studentNumber)),
    });
  } catch (err) {
    console.error('Load attendance error:', err);
    res.status(500).json({ error: 'Failed to load the attendance.' });
  }
});

router.put('/admin/events/:id/attendance', requireAdso, async (req, res) => {
  try {
    const event = await findEvent(req, res);
    if (!event) return;
    if (event.date > todayInManila()) return res.status(400).json({ error: 'You can check attendance once the event has taken place.' });
    const raw = req.body?.studentNumbers;
    if (!Array.isArray(raw) || raw.some(n => typeof n !== 'string')) return res.status(400).json({ error: 'Send who attended.' });
    const attended = [...new Set(raw.map(n => n.trim()).filter(Boolean))];
    const term = { academicYear: event.academicYear, term: event.term };
    const allowed = new Set((await termScholars(term)).map(s => s.studentNumber));
    const unknown = attended.filter(n => !allowed.has(n));
    if (unknown.length) return res.status(400).json({ error: `Not an SFAG scholar this term: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.` });

    const by = req.adminUser.email || req.adminUser.id;
    const now = new Date();
    const claim = { event: event._id, status: 'Approved', claimedAt: now, reviewedBy: by, reviewedAt: now, note: 'Attendance sheet' };
    const termDeadline = await DutySetting.deadlineFor(term);
    const credited = [];
    for (const studentNumber of attended) {
      // An existing claim becomes Approved; otherwise one is added.
      const updated = await DutyLog.findOneAndUpdate(
        { studentNumber, ...term, eventClaims: { $elemMatch: { event: event._id, status: { $ne: 'Approved' } } } },
        { $set: { 'eventClaims.$.status': 'Approved', 'eventClaims.$.reviewedBy': by, 'eventClaims.$.reviewedAt': now, 'eventClaims.$.note': 'Attendance sheet' } },
        { returnDocument: 'after' }
      ).lean() ?? await DutyLog.findOneAndUpdate(
        { studentNumber, ...term, 'eventClaims.event': { $ne: event._id } },
        { $push: { eventClaims: claim }, $setOnInsert: { entries: [], specialEvents: [], ...(termDeadline ? { deadline: termDeadline } : {}) } },
        { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
      ).lean().catch(err => (err.code === 11000 ? null : Promise.reject(err)));
      if (updated) credited.push(updated._id);
    }
    // Unticked: no credit for this event.
    const removed = await DutyLog.updateMany(
      { ...term, studentNumber: { $nin: attended }, 'eventClaims.event': event._id },
      { $pull: { eventClaims: { event: event._id } } }
    );
    event.attendanceSavedAt = now;
    event.attendanceSavedBy = by;
    await event.save();
    // The credit can complete someone's hours: tell their office head.
    const { notifyIfReady } = require('../utils/evaluations');
    for (const id of credited) notifyIfReady(id);
    res.json({ event: adminEventView(event), attended: attended.length, uncredited: removed.modifiedCount });
  } catch (err) {
    console.error('Save attendance error:', err);
    res.status(500).json({ error: 'Failed to save the attendance.' });
  }
});

router.get('/admin/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid duty log id.' });
    const log = await DutyLog.findById(req.params.id).lean();
    if (!log) return res.status(404).json({ error: 'Duty log not found.' });
    const [rules, eventsById] = await Promise.all([dutyRules([log.studentNumber]), termEvents(log)]);
    res.json(logView(log, todayInManila(), rules.get(log.studentNumber), eventsById, await officesWithHeads()));
  } catch (err) {
    console.error('Load duty log (admin) error:', err);
    res.status(500).json({ error: 'Failed to load the duty log.' });
  }
});

module.exports = router;
// For the automation jobs (utils/automation.js) and renewal checks.
module.exports.dutyHelpers = { dutyRules, logView, termEvents, everSfag, DUTY_SCHOLARSHIP_ID };
