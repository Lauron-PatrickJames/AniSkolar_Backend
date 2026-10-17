const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdso } = require('../middleware/requireAdmin');
const { requireSfagScholar, SFAG_ID } = require('../middleware/requireStudent');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const DutyLog = require('../models/DutyLog');
const DutySetting = require('../models/DutySetting');
const Student = require('../models/Student');
const { findCurrentHolders } = require('../utils/renewals');
const { summarize, parseLog, currentTerm, todayInManila } = require('../utils/dutyHours');

// Duty hours monitoring.
//
// Duty hours are an SFAG requirement only.
//
// SFAG scholar (approved for or renewed on the SFAG at some point; others get 403):
//   GET /api/duty-hours/mine?academicYear=&term=   their log for a term (default: current) + totals
//   PUT /api/duty-hours/mine                       save the whole log for a term
//
// AdSO:
//   GET /api/duty-hours/admin?academicYear=&term=  every SFAG holder for the term, plus any other
//                                                  SFAG scholar who logged hours for it, with totals
//   GET /api/duty-hours/admin/:id                  one log in full
//   GET /api/duty-hours/admin/settings             required hours per grant percentage
//   PUT /api/duty-hours/admin/settings             { hoursByPercentage: { 100, 75, 50, 25 } } (null = scholars enter it)
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

// Required hours follow the scholar's grant percentage when the AdSO has
// set hours for it (DutySetting); otherwise the scholar enters them.
// Returns Map studentNumber -> { percentage, requiredHours } for the
// latest approved SFAG application that has a percentage.
async function dutyRules(studentNumbers) {
  if (!studentNumbers.length) return new Map();
  const [apps, settings] = await Promise.all([
    Application.find({ studentNumber: { $in: studentNumbers }, scholarshipId: SFAG_ID, status: 'Approved', sfagPercentage: { $exists: true } })
      .select('studentNumber sfagPercentage reviewedAt createdAt').sort({ reviewedAt: -1, createdAt: -1 }).lean(),
    DutySetting.current(),
  ]);
  const rules = new Map();
  for (const a of apps) {
    if (rules.has(a.studentNumber)) continue;
    rules.set(a.studentNumber, { percentage: a.sfagPercentage, requiredHours: settings.hoursByPercentage[a.sfagPercentage] ?? null });
  }
  return rules;
}

// The log with the AdSO's required hours in place of the scholar's, plus
// `rule` saying where they came from.
function logView(log, today, rule) {
  const fromAdso = rule?.requiredHours != null;
  const effective = fromAdso ? { ...log, requiredHours: rule.requiredHours } : log;
  return {
    log: effective,
    summary: summarize(effective, today),
    rule: { percentage: rule?.percentage ?? null, requiredHours: fromAdso ? rule.requiredHours : null },
  };
}

// The scholar's copy leaves out who assigned the office.
function scholarLogView(log, today, rule) {
  const { officeAssignedBy, ...rest } = log;
  return logView(rest, today, rule);
}

router.get('/mine', requireSfagScholar, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const [log, others, rules] = await Promise.all([
      DutyLog.findOne({ studentNumber: req.studentNumber, ...term }).lean(),
      DutyLog.find({ studentNumber: req.studentNumber }).select('academicYear term').sort({ academicYear: -1, term: -1 }).lean(),
      dutyRules([req.studentNumber]),
    ]);
    const empty = { ...term, studentNumber: req.studentNumber, entries: [], specialEvents: [] };
    res.json({
      current: currentTerm(),
      terms: others.map(({ academicYear, term: t }) => ({ academicYear, term: t })),
      ...scholarLogView(log ?? empty, todayInManila(), rules.get(req.studentNumber)),
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
    const { log, error } = parseLog(body);
    if (error) return res.status(400).json({ error });
    // Hours set by the AdSO for the scholar's percentage aren't theirs to change.
    const rule = (await dutyRules([req.studentNumber])).get(req.studentNumber);
    if (rule?.requiredHours != null) delete log.requiredHours;

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
    res.json(scholarLogView(saved, todayInManila(), rule));
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
    const rules = await dutyRules(studentNumbers);
    const students = await Student.find({ studentNumber: { $in: studentNumbers } })
      .select('studentNumber name email course programCode yearLevel avatarUrl').lean();
    const studentByNumber = new Map(students.map(s => [s.studentNumber, s]));

    const scholars = studentNumbers.map(studentNumber => {
      const s = studentByNumber.get(studentNumber);
      const view = logByStudent.has(studentNumber) ? logView(logByStudent.get(studentNumber), today, rules.get(studentNumber)) : null;
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
        updatedAt: log?.updatedAt ?? null,
      };
    });
    res.json({
      term,
      current: currentTerm(),
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
    const input = req.body?.hoursByPercentage;
    if (!input || typeof input !== 'object') return res.status(400).json({ error: 'Enter the hours for each grant percentage.' });
    const $set = { updatedBy: req.adminUser.email || req.adminUser.id };
    const $unset = {};
    for (const p of DutySetting.GRANT_PERCENTAGES) {
      const raw = input[p];
      const path = `hours.${DutySetting.hoursKey(p)}`;
      if (raw === null || raw === '' || raw === undefined) { $unset[path] = ''; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: `Hours for ${p}% must be between 0 and 1000.` });
      $set[path] = Math.round(n * 100) / 100;
    }
    await DutySetting.findByIdAndUpdate('duty', { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { upsert: true, runValidators: true });
    res.json(await DutySetting.current());
  } catch (err) {
    console.error('Save duty settings error:', err);
    res.status(500).json({ error: 'Failed to save the duty hours settings.' });
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

    const update = office
      ? {
          $set: { officeAssigned: office, officeAssignedBy: req.adminUser.email || req.adminUser.id, officeAssignedAt: new Date() },
          $setOnInsert: { entries: [], specialEvents: [] },
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

router.get('/admin/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid duty log id.' });
    const log = await DutyLog.findById(req.params.id).lean();
    if (!log) return res.status(404).json({ error: 'Duty log not found.' });
    const rules = await dutyRules([log.studentNumber]);
    res.json(logView(log, todayInManila(), rules.get(log.studentNumber)));
  } catch (err) {
    console.error('Load duty log (admin) error:', err);
    res.status(500).json({ error: 'Failed to load the duty log.' });
  }
});

module.exports = router;
