const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdso } = require('../middleware/requireAdmin');
const { requireScholar } = require('../middleware/requireStudent');
const DutyLog = require('../models/DutyLog');
const Student = require('../models/Student');
const { findCurrentHolders } = require('../utils/renewals');
const { summarize, parseLog, currentTerm, todayInManila } = require('../utils/dutyHours');

// Duty hours monitoring.
//
// Scholar (anyone with an approved application; others get 403):
//   GET /api/duty-hours/mine?academicYear=&term=   their log for a term (default: current) + totals
//   PUT /api/duty-hours/mine                       save the whole log for a term
//
// AdSO:
//   GET /api/duty-hours/admin?academicYear=&term=  every SFA Grant holder for the term, plus anyone
//                                                  else who logged hours, with totals
//   GET /api/duty-hours/admin/:id                  one log in full

const { TERMS } = DutyLog;
// The SFA Grant carries the duty requirement; its holders are listed on
// the admin page even before they log anything.
const DUTY_SCHOLARSHIP_ID = 's1';

function parseTerm(source) {
  if (source.academicYear === undefined && source.term === undefined) return { value: currentTerm() };
  const academicYear = Number(source.academicYear);
  if (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2100) return { error: 'Choose the academic year.' };
  if (!TERMS.includes(source.term)) return { error: 'Choose the term.' };
  return { value: { academicYear, term: source.term } };
}

function logView(log, today) {
  return { log, summary: summarize(log, today) };
}

router.get('/mine', requireScholar, async (req, res) => {
  try {
    const { value: term, error } = parseTerm(req.query);
    if (error) return res.status(400).json({ error });
    const [log, others] = await Promise.all([
      DutyLog.findOne({ studentNumber: req.studentNumber, ...term }).lean(),
      DutyLog.find({ studentNumber: req.studentNumber }).select('academicYear term').sort({ academicYear: -1, term: -1 }).lean(),
    ]);
    const empty = { ...term, studentNumber: req.studentNumber, entries: [], specialEvents: [] };
    res.json({
      current: currentTerm(),
      terms: others.map(({ academicYear, term: t }) => ({ academicYear, term: t })),
      ...logView(log ?? empty, todayInManila()),
    });
  } catch (err) {
    console.error('Load duty log error:', err);
    res.status(500).json({ error: 'Failed to load your duty hours.' });
  }
});

router.put('/mine', requireScholar, async (req, res) => {
  try {
    const body = req.body || {};
    const { value: term, error: termError } = parseTerm({ academicYear: body.academicYear, term: body.term });
    if (termError) return res.status(400).json({ error: termError });
    const { log, error } = parseLog(body);
    if (error) return res.status(400).json({ error });

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
    res.json(logView(saved, todayInManila()));
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
    const [holders, logs] = await Promise.all([
      findCurrentHolders({ scholarshipId: DUTY_SCHOLARSHIP_ID, ...term }),
      DutyLog.find(term).lean(),
    ]);
    const logByStudent = new Map(logs.map(l => [l.studentNumber, l]));
    const studentNumbers = [...new Set([...holders.keys(), ...logByStudent.keys()])];
    const students = await Student.find({ studentNumber: { $in: studentNumbers } })
      .select('studentNumber name email course programCode yearLevel avatarUrl').lean();
    const studentByNumber = new Map(students.map(s => [s.studentNumber, s]));

    const scholars = studentNumbers.map(studentNumber => {
      const s = studentByNumber.get(studentNumber);
      const log = logByStudent.get(studentNumber);
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
        deadline: log?.deadline ?? null,
        entryCount: log?.entries?.length ?? 0,
        summary: log ? summarize(log, today) : null,
        updatedAt: log?.updatedAt ?? null,
      };
    });
    res.json({ term, current: currentTerm(), scholars });
  } catch (err) {
    console.error('Load duty hours (admin) error:', err);
    res.status(500).json({ error: 'Failed to load duty hours.' });
  }
});

router.get('/admin/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid duty log id.' });
    const log = await DutyLog.findById(req.params.id).lean();
    if (!log) return res.status(404).json({ error: 'Duty log not found.' });
    res.json(logView(log, todayInManila()));
  } catch (err) {
    console.error('Load duty log (admin) error:', err);
    res.status(500).json({ error: 'Failed to load the duty log.' });
  }
});

module.exports = router;
