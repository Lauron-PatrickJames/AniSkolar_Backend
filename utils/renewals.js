const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const { academicYearStartExpr } = require('./academicYear');

// Department head's Student Assistant evaluation (SFAG), from the
// office's "Performance Evaluation of Student Financial Aid Grantees" form.
// Each item is rated 1–5. The interview says the form has 19 items; the
// copy in the NG manuscript (Appendix G) only shows these 15, so the rest
// must be added here once the AdSO shares the full form. Keep in sync with
// EVALUATION_ITEMS in the frontend's src/utils/renewals.ts.
const EVALUATION_ITEMS = [
  { key: 'jobKnowledge', label: 'Job knowledge' },
  { key: 'awareness', label: 'Awareness of what to do without constant supervision' },
  { key: 'knowledgeOfDuties', label: 'Knowledge of how to perform duties' },
  { key: 'jobPerformance', label: 'Job performance' },
  { key: 'organization', label: 'Organization' },
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'speed', label: 'Speed' },
  { key: 'neatness', label: 'Neatness' },
  { key: 'attitude', label: 'Attitude' },
  { key: 'initiative', label: 'Initiative' },
  { key: 'conformance', label: 'Conformance to operational policies' },
  { key: 'cooperationCoSa', label: "Cooperation with co-SA's" },
  { key: 'cooperationPublic', label: 'Cooperation with public' },
  { key: 'acceptanceOfSupervision', label: 'Acceptance of supervision' },
  { key: 'reliability', label: 'Reliability and consistency in performance' },
];
const EVALUATION_KEYS = EVALUATION_ITEMS.map(i => i.key);

// A scholar must average at least "Very satisfactory" (4) to renew; below
// that, they are interviewed by the scholarship head before a decision.
const PASSING_AVERAGE = 4;

// The term a scholar must have held the scholarship in before this one.
function previousTerm({ academicYear, term }) {
  return term === '2nd Semester'
    ? { academicYear, term: '1st Semester' }
    : { academicYear: academicYear - 1, term: '2nd Semester' };
}

// Who holds the scholarship for a renewal period, keyed by student number:
//   - an Approved application for it in the academic year the scholar is
//     continuing from (the same year for a 2nd-semester renewal, the year
//     before for a 1st-semester one), or
//   - a renewal marked Renewed in the previous term.
// A scholar whose previous-term renewal ended Not Renewed / Not Continuing
// no longer holds it, even with an approved application.
// Returns Map<studentNumber, { applicationId?, referenceCode?, renewedFrom? }>.
async function findHolders(period, studentNumber) {
  const fromYear = period.term === '2nd Semester' ? period.academicYear : period.academicYear - 1;
  const studentMatch = studentNumber ? { studentNumber } : {};

  const approved = await Application.aggregate([
    { $match: { scholarshipId: period.scholarshipId, status: 'Approved', endedAt: null, ...studentMatch } },
    { $addFields: { ay: academicYearStartExpr('$createdAt') } },
    { $match: { ay: fromYear } },
    { $sort: { createdAt: -1 } },
    { $project: { studentNumber: 1, referenceCode: 1 } },
  ]);

  const holders = new Map();
  for (const app of approved) {
    if (!holders.has(app.studentNumber)) {
      holders.set(app.studentNumber, { applicationId: app._id, referenceCode: app.referenceCode });
    }
  }

  const prev = previousTerm(period);
  const prevPeriod = await RenewalPeriod.findOne({ scholarshipId: period.scholarshipId, ...prev }).select('_id').lean();
  if (prevPeriod) {
    const prevRenewals = await Renewal.find({ periodId: prevPeriod._id, ...studentMatch })
      .select('studentNumber status').lean();
    for (const r of prevRenewals) {
      if (r.status === 'Renewed') {
        holders.set(r.studentNumber, { ...holders.get(r.studentNumber), renewedFrom: `${prev.term}, AY ${prev.academicYear}–${prev.academicYear + 1}` });
      } else if (r.status === 'Not Renewed' || r.status === 'Not Continuing') {
        holders.delete(r.studentNumber);
      }
    }
  }
  // A scholarship the student ended since (declined for another one,
  // graduated, stopped) isn't theirs to renew.
  for (const sn of await endedSince(period.scholarshipId, fromYear, [...holders.keys()])) holders.delete(sn);
  return holders;
}

// Of these students, the ones whose application for the scholarship was
// ended (endedAt) in academic year `fromYear` or later.
async function endedSince(scholarshipId, fromYear, studentNumbers) {
  if (!studentNumbers.length) return [];
  const ended = await Application.find({ scholarshipId, studentNumber: { $in: studentNumbers }, endedAt: { $ne: null } }).select('studentNumber endedAt').lean();
  const { academicYearStart } = require('./academicYear');
  return ended.filter(a => academicYearStart(a.endedAt) >= fromYear).map(a => a.studentNumber);
}

// Who holds the scholarship *during* a term (not who may renew into it):
// an Approved application in that academic year, or a renewal marked
// Renewed for that term. Used for duty hours. Returns a Set of student numbers.
async function findCurrentHolders({ scholarshipId, academicYear, term }) {
  const [approved, period] = await Promise.all([
    Application.aggregate([
      { $match: { scholarshipId, status: 'Approved', endedAt: null } },
      { $addFields: { ay: academicYearStartExpr('$createdAt') } },
      { $match: { ay: academicYear } },
      { $group: { _id: '$studentNumber' } },
    ]),
    RenewalPeriod.findOne({ scholarshipId, academicYear, term }).select('_id').lean(),
  ]);
  const holders = new Set(approved.map(a => a._id));
  if (period) {
    const renewed = await Renewal.find({ periodId: period._id, status: 'Renewed' }).select('studentNumber').lean();
    renewed.forEach(r => holders.add(r.studentNumber));
  }
  for (const sn of await endedSince(scholarshipId, academicYear, [...holders])) holders.delete(sn);
  return holders;
}

// Validates 1–5 scores for every evaluation item. Returns { scores, average }
// or { error }.
function parseEvaluationScores(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Rate every evaluation item from 1 to 5.' };
  const scores = {};
  for (const key of EVALUATION_KEYS) {
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return { error: 'Rate every evaluation item from 1 to 5.' };
    }
    scores[key] = value;
  }
  const average = EVALUATION_KEYS.reduce((sum, key) => sum + scores[key], 0) / EVALUATION_KEYS.length;
  return { scores, average: Math.round(average * 100) / 100 };
}

function academicYearLabel(start) {
  return `AY ${start}–${start + 1}`;
}

module.exports = {
  EVALUATION_ITEMS,
  PASSING_AVERAGE,
  previousTerm,
  findHolders,
  findCurrentHolders,
  parseEvaluationScores,
  academicYearLabel,
};
