const DutyLog = require('../models/DutyLog');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const Student = require('../models/Student');
const { currentTerm, todayInManila } = require('./dutyHours');
const { previousTerm } = require('./renewals');
const { listOffices, norm, officesWithHeads } = require('./offices');
const { renderEmail } = require('./emailTemplate');
const { queueEmails, processOutbox } = require('./outbox');

// Office heads evaluate a scholar once the scholar has completed the term's
// required duty hours (confirmed hours plus approved event credit). Until
// then the evaluation stays closed ("still rendering hours"). The moment
// the hours are complete the head is emailed, and so is the scholar (once
// each per scholar and term).
// The evaluation is stored on the term's duty log and copied into the
// renewal that looks back on that term (routes/renewals.js does it on
// submit; saving it here also updates a renewal already submitted).
//
// States: 'in_progress' (hours not complete), 'ready' (complete, not yet
// evaluated), 'done' (evaluated).

const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';
const fmt = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');

// The term after this one: its renewal looks back on this term.
function nextTerm({ academicYear, term }) {
  return term === '1st Semester' ? { academicYear, term: '2nd Semester' } : { academicYear: academicYear + 1, term: '1st Semester' };
}

// Full summaries for some logs (required hours from the AdSO's table,
// approved event credit, only confirmed duties when the office has a head).
async function summariesFor(logs) {
  if (!logs.length) return new Map();
  const { dutyHelpers } = require('../routes/dutyHours');
  const today = todayInManila();
  const rules = await dutyHelpers.dutyRules([...new Set(logs.map(l => l.studentNumber))]);
  const headOffices = await officesWithHeads();
  const eventsByTerm = new Map();
  const out = new Map();
  for (const log of logs) {
    const k = `${log.academicYear}|${log.term}`;
    if (!eventsByTerm.has(k)) eventsByTerm.set(k, await dutyHelpers.termEvents(log));
    out.set(String(log._id), dutyHelpers.logView(log, today, rules.get(log.studentNumber), eventsByTerm.get(k), headOffices).summary);
  }
  return out;
}

const stateOf = (log, s) => (log.evaluation?.average ? 'done' : s?.required && s.completed >= s.required ? 'ready' : 'in_progress');

// Renewals already decided for the term after each log's term (the
// evaluation is final then): Set of `${studentNumber}|${academicYear}|${term}`.
async function decidedRenewals(logs) {
  const keys = new Set();
  const terms = [...new Map(logs.map(l => [`${l.academicYear}|${l.term}`, { academicYear: l.academicYear, term: l.term }])).values()];
  for (const t of terms) {
    const next = nextTerm(t);
    const periods = await RenewalPeriod.find(next).select('_id').lean();
    if (!periods.length) continue;
    const decided = await Renewal.find({ periodId: { $in: periods.map(p => p._id) }, status: { $in: ['Renewed', 'Not Renewed'] } }).select('studentNumber').lean();
    decided.forEach(r => keys.add(`${r.studentNumber}|${t.academicYear}|${t.term}`));
  }
  return keys;
}

// The office's scholars for the current and previous term, with their
// evaluation state. Returns [{ term, scholars: [...] }], newest term first.
async function officeEvaluations(office) {
  const cur = currentTerm();
  const terms = [cur, previousTerm(cur)];
  const logs = (await DutyLog.find({ $or: terms, officeAssigned: { $nin: [null, ''] } }).lean())
    .filter(l => norm(l.officeAssigned) === norm(office));
  const [summaries, decided, students] = await Promise.all([
    summariesFor(logs),
    decidedRenewals(logs),
    Student.find({ studentNumber: { $in: logs.map(l => l.studentNumber) } }).select('studentNumber name programCode yearLevel avatarUrl').lean(),
  ]);
  const byNumber = new Map(students.map(s => [s.studentNumber, s]));
  return terms.map(term => ({
    term,
    scholars: logs.filter(l => l.academicYear === term.academicYear && l.term === term.term).map(l => {
      const s = summaries.get(String(l._id));
      const st = byNumber.get(l.studentNumber);
      return {
        studentNumber: l.studentNumber,
        name: st?.name ?? '',
        program: st?.programCode ?? '',
        yearLevel: st?.yearLevel ?? '',
        avatarUrl: st?.avatarUrl,
        state: stateOf(l, s),
        completed: s?.completed ?? 0,
        required: s?.required ?? null,
        waitingHours: s?.waitingHours ?? 0,
        evaluation: l.evaluation?.average ? { scores: l.evaluation.scores, average: l.evaluation.average, remarks: l.evaluation.remarks ?? null, enteredAt: l.evaluation.enteredAt, source: l.evaluation.source ?? null } : null,
        locked: decided.has(`${l.studentNumber}|${l.academicYear}|${l.term}`),
      };
    }).sort((a, b) => ['ready', 'in_progress', 'done'].indexOf(a.state) - ['ready', 'in_progress', 'done'].indexOf(b.state) || a.name.localeCompare(b.name)),
  }));
}

// Once a scholar's hours for a term are complete and they haven't been
// evaluated yet, emails the office head (please evaluate) and the scholar
// (hours done, evaluation next). Once each per log. Never throws.
async function notifyIfReady(logId) {
  try {
    const log = await DutyLog.findById(logId).lean();
    if (!log?.officeAssigned || log.evaluation?.average) return false;
    const summary = (await summariesFor([log])).get(String(log._id));
    if (stateOf(log, summary) !== 'ready') return false;
    const head = (await listOffices()).find(o => o.headEmail && norm(o.office) === norm(log.officeAssigned));
    const student = await Student.findOne({ studentNumber: log.studentNumber }).select('name email').lean();
    const who = student?.name || log.studentNumber;
    const hours = `${fmt(summary.completed)} of ${fmt(summary.required)} hours, ${log.term}, A.Y. ${log.academicYear}–${log.academicYear + 1}.`;
    const emails = [];
    if (head) {
      const { html, text } = renderEmail({
        heading: `${who} finished their duty hours`,
        intro: hours,
        body: `Good day${head.headName ? `, ${head.headName}` : ''}!\n\n${who} has completed the required SFAG duty hours in ${head.office}. You can now evaluate their performance in your office portal (Evaluations). It takes a few minutes and goes into their scholarship renewal.`,
        button: { url: appUrl(), label: 'Evaluate in AniSkolar' },
      });
      emails.push({ key: `eval-ready:${log._id}`, kind: 'evaluationReady', priority: 1, to: head.headEmail, subject: `AniSkolar: please evaluate ${who}`, text, html });
    }
    if (student?.email) {
      const { html, text } = renderEmail({
        heading: 'You’ve completed your duty hours',
        intro: hours,
        body: `Great work! You’ve completed the required SFAG duty hours for this semester in ${log.officeAssigned}.\n\n${head ? `${head.headName || 'Your office head'} has been asked to evaluate your performance` : 'Your office will evaluate your performance'}. The evaluation goes into your scholarship renewal for next semester. There’s nothing else you need to do for duty hours this semester.`,
        button: { url: appUrl(), label: 'View your duty hours' },
      });
      emails.push({ key: `hours-done:${log._id}`, kind: 'hoursDone', to: student.email, subject: 'AniSkolar: you’ve completed your duty hours', text, html });
    }
    const n = emails.length ? await queueEmails(emails) : 0;
    if (n) processOutbox().catch(() => {});
    return n > 0;
  } catch (err) {
    console.error('Evaluation-ready email failed:', err);
    return false;
  }
}

// Per office (normalized name): how many scholars are ready to evaluate,
// for the Monday reminder. Map office -> count.
async function readyCounts() {
  const cur = currentTerm();
  const logs = await DutyLog.find({ $or: [cur, previousTerm(cur)], officeAssigned: { $nin: [null, ''] }, 'evaluation.average': { $exists: false } }).lean();
  const summaries = await summariesFor(logs);
  const counts = new Map();
  for (const l of logs) {
    if (stateOf(l, summaries.get(String(l._id))) !== 'ready') continue;
    counts.set(norm(l.officeAssigned), (counts.get(norm(l.officeAssigned)) ?? 0) + 1);
  }
  return counts;
}

module.exports = { officeEvaluations, notifyIfReady, readyCounts, nextTerm, summariesFor, stateOf };
