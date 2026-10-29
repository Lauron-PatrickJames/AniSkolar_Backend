const DutyLog = require('../models/DutyLog');
const { RENEWAL_DOCUMENTS } = require('../models/RenewalPeriod');
const { previousTerm, PASSING_AVERAGE } = require('./renewals');
const { officesWithHeads } = require('./offices');
const { todayInManila } = require('./dutyHours');

// Renewal pre-check: what the AdSO checks by hand before renewing a
// scholar, done when the list loads. Each item is 'pass', 'fail' (not
// eligible), 'review' (look at it / interview first) or 'waiting' (data
// not in yet). The result is the worst of them:
//   not_eligible > review > waiting > eligible.
// Only 'eligible' renewals can be renewed in bulk; the rest are decided
// one by one as before. The check never decides anything on its own.

const RANK = { fail: 3, review: 2, waiting: 1, pass: 0 };
const RESULT = ['eligible', 'waiting', 'review', 'not_eligible'];
const fmt = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');

// duty: undefined = the scholarship has no duty hours; null = no log for
// the term; else { summary } from the duty hours view.
function checkRenewal({ renewal, period, duty }) {
  if (!renewal?.continuing) return null;
  const items = [];

  if (typeof renewal.gpa === 'number') {
    if (period.minGpa != null) {
      items.push({ key: 'gpa', label: 'GPA', status: renewal.gpa >= period.minGpa ? 'pass' : 'fail', detail: `${renewal.gpa.toFixed(2)} (minimum ${Number(period.minGpa).toFixed(2)})` });
    }
  } else {
    items.push({ key: 'gpa', label: 'GPA', status: 'review', detail: 'Not given' });
  }
  items.push(renewal.hasFailingGrade
    ? { key: 'failing', label: 'No failing grade', status: 'fail', detail: 'Reported a failing grade' }
    : { key: 'failing', label: 'No failing grade', status: 'pass', detail: 'None reported' });

  const onFile = new Set((renewal.documents || []).map(d => d.docType));
  const missing = RENEWAL_DOCUMENTS.filter(r => !onFile.has(r));
  items.push(missing.length
    ? { key: 'documents', label: 'Documents', status: 'review', detail: `Missing: ${missing.join(', ')}` }
    : { key: 'documents', label: 'Documents', status: 'pass', detail: 'All uploaded' });

  if (duty !== undefined) {
    const s = duty?.summary;
    if (!s) items.push({ key: 'duty', label: 'Duty hours', status: 'review', detail: 'No duty log for the term' });
    else if (s.required == null) items.push({ key: 'duty', label: 'Duty hours', status: 'review', detail: `${fmt(s.completed)} h; required hours not set` });
    else if (s.completed >= s.required) items.push({ key: 'duty', label: 'Duty hours', status: 'pass', detail: `${fmt(s.completed)} of ${fmt(s.required)} h` });
    else if (s.completed + (s.waitingHours || 0) >= s.required) items.push({ key: 'duty', label: 'Duty hours', status: 'waiting', detail: `${fmt(s.completed)} of ${fmt(s.required)} h; ${fmt(s.waitingHours)} h waiting for the office to confirm` });
    else items.push({ key: 'duty', label: 'Duty hours', status: 'review', detail: `${fmt(s.completed)} of ${fmt(s.required)} h (${fmt(s.required - s.completed)} h short)` });
  }

  if (period.requiresEvaluation) {
    const avg = renewal.evaluation?.average;
    if (!avg) items.push({ key: 'evaluation', label: 'Evaluation', status: 'waiting', detail: 'Not evaluated yet' });
    else if (avg < PASSING_AVERAGE) items.push({ key: 'evaluation', label: 'Evaluation', status: 'review', detail: `Average ${avg.toFixed(2)}, below ${PASSING_AVERAGE}: interview before deciding` });
    else items.push({ key: 'evaluation', label: 'Evaluation', status: 'pass', detail: `Average ${avg.toFixed(2)}` });
  }

  const worst = Math.max(...items.map(i => RANK[i.status]));
  return { result: RESULT[worst], items };
}

// Checks for every renewal of a period: Map renewalId (string) -> check.
async function checksForPeriod(period, renewals) {
  const { dutyHelpers } = require('../routes/dutyHours');
  const hasDuty = period.scholarshipId === dutyHelpers.DUTY_SCHOLARSHIP_ID;
  const duties = new Map();
  const continuing = renewals.filter(r => r.continuing);
  if (hasDuty && continuing.length) {
    const term = previousTerm(period);
    const sns = continuing.map(r => r.studentNumber);
    const [logs, rules, eventsById, headOffices] = await Promise.all([
      DutyLog.find({ studentNumber: { $in: sns }, academicYear: term.academicYear, term: term.term }).lean(),
      dutyHelpers.dutyRules(sns),
      dutyHelpers.termEvents(term),
      officesWithHeads(),
    ]);
    const today = todayInManila();
    for (const log of logs) duties.set(log.studentNumber, dutyHelpers.logView(log, today, rules.get(log.studentNumber), eventsById, headOffices));
  }
  return new Map(renewals.map(r => [
    String(r._id),
    checkRenewal({ renewal: r, period, duty: hasDuty ? (duties.get(r.studentNumber) ?? null) : undefined }),
  ]));
}

module.exports = { checkRenewal, checksForPeriod };
