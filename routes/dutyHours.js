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
const OfficeRequest = require('../models/OfficeRequest');
const { norm, officesWithHeads } = require('../utils/offices');
const Student = require('../models/Student');
const { findCurrentHolders } = require('../utils/renewals');
const { summarize, parseLog, currentTerm, todayInManila, isValidDate } = require('../utils/dutyHours');

// Duty hours monitoring.
//
// Duty hours are an SFAG requirement only.
//
// SFAG scholar (approved for or renewed on the SFAG at some point; others get 403):
//   GET /api/duty-hours/mine?academicYear=&term=   their log for a term (default: current) + totals
//   PUT /api/duty-hours/mine                       save the whole log for a term
//   POST /api/duty-hours/mine/claims               { eventId } claim attending a credited event (Pending)
//   DELETE /api/duty-hours/mine/claims/:eventId    withdraw a Pending claim
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
//   PUT /api/duty-hours/admin/office-slots         { officeSlots: [{ office, slots }] } — how many
//                                                  scholars each office takes (for Random assign)
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

// The scholar's copy leaves out who assigned the office.
function scholarLogView(log, today, rule, eventsById, headOffices) {
  const { officeAssignedBy, evaluation, ...rest } = log;
  return logView(rest, today, rule, eventsById, headOffices);
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
    const empty = { ...term, studentNumber: req.studentNumber, entries: [], specialEvents: [], eventClaims: [] };
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
    const { log, error } = parseLog(body);
    if (error) return res.status(400).json({ error });
    // Hours set by the AdSO for the scholar's percentage aren't theirs to change.
    const rule = (await dutyRules([req.studentNumber])).get(req.studentNumber);
    if (rule?.requiredHours != null) delete log.requiredHours;
    // A duty the office head already confirmed or flagged keeps that (and
    // its id) as long as its date and times are unchanged; a new or edited
    // duty waits for the head again.
    const existing = await DutyLog.findOne({ studentNumber: req.studentNumber, ...term }).select('entries').lean();
    const before = new Map((existing?.entries || []).map(e => [`${e.date}|${e.timeIn}|${e.timeOut}`, e]));
    log.entries = log.entries.map(e => {
      const old = before.get(`${e.date}|${e.timeIn}|${e.timeOut}`);
      if (!old) return e;
      before.delete(`${e.date}|${e.timeIn}|${e.timeOut}`);
      return { ...e, _id: old._id, ...(old.status ? { status: old.status, reviewedBy: old.reviewedBy, reviewedAt: old.reviewedAt, note: old.note } : {}) };
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

// Office requests (sent from the office portal).
//   GET   /api/duty-hours/admin/requests?status=open|done|declined
//   PATCH /api/duty-hours/admin/requests/:id  { status: 'done' | 'declined' | 'open', response }
router.get('/admin/requests', requireAdso, async (req, res) => {
  try {
    const filter = OfficeRequest.STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
    const requests = await OfficeRequest.find(filter).sort({ status: 1, createdAt: -1 }).limit(300).lean();
    res.json({ requests, open: await OfficeRequest.countDocuments({ status: 'open' }) });
  } catch (err) {
    console.error('Load office requests error:', err);
    res.status(500).json({ error: 'Failed to load the requests.' });
  }
});

router.patch('/admin/requests/:id', requireAdso, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
    const { status } = req.body || {};
    if (!OfficeRequest.STATUSES.includes(status)) return res.status(400).json({ error: 'Choose Done, Declined or Open.' });
    const response = typeof req.body.response === 'string' ? req.body.response.trim().slice(0, 1000) : undefined;
    const request = await OfficeRequest.findByIdAndUpdate(req.params.id, {
      $set: { status, ...(response !== undefined ? { response } : {}), resolvedBy: status === 'open' ? undefined : (req.adminUser.email || req.adminUser.id), resolvedAt: status === 'open' ? undefined : new Date() },
    }, { returnDocument: 'after' }).lean();
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    res.json({ request });
  } catch (err) {
    console.error('Update office request error:', err);
    res.status(500).json({ error: 'Failed to update the request.' });
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

router.post('/mine/claims', requireSfagScholar, async (req, res) => {
  try {
    const eventId = req.body?.eventId;
    if (typeof eventId !== 'string' || !mongoose.Types.ObjectId.isValid(eventId)) return res.status(400).json({ error: 'Choose an event.' });
    const event = await DutyEvent.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    if (event.date > todayInManila()) return res.status(400).json({ error: 'You can claim an event once it has taken place.' });
    const term = { academicYear: event.academicYear, term: event.term };
    // One claim per event; the filter makes a double tap a no-op.
    const updated = await DutyLog.findOneAndUpdate(
      { studentNumber: req.studentNumber, ...term, 'eventClaims.event': { $ne: event._id } },
      { $push: { eventClaims: { event: event._id, status: 'Pending', claimedAt: new Date() } }, $setOnInsert: { entries: [], specialEvents: [] } },
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
      events: [...eventsById.values()].map(e => ({ ...eventView(e), claims: counts.get(String(e._id)) ?? { Pending: 0, Approved: 0, Rejected: 0 } })),
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
    res.json({ studentNumber: updated.studentNumber, eventId, status });
  } catch (err) {
    console.error('Review event claim error:', err);
    res.status(500).json({ error: 'Failed to save the decision.' });
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
