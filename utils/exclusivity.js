const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const { academicYearStart } = require('./academicYear');
const { findScholarship } = require('../data/scholarships');

// One internally funded scholarship at a time (AdSO interview, Oct 2026).
// Every scholarship in AniSkolar is internally funded. A student may apply
// for several; if two are approved, the student chooses which to keep
// (usually the bigger grant) and only that one is credited. So applying is
// never blocked: approving one for a student who already holds another
// needs the AdSO to acknowledge it (PATCH /api/applications/:id/status
// with acknowledgeOtherScholarship), and the student is told to choose.
// (SFAG 25% grantees may also hold one internally funded scholarship of up
// to ₱10,000 — the office handles that case.) Externally funded grants
// (DOST, CHED, …) aren't in AniSkolar and have no limit. Keep in sync with
// EXCLUSIVE_SCHOLARSHIP_ID in the frontend's src/utils/eligibility.ts.
const EXCLUSIVE_SCHOLARSHIP_ID = 's1';
const EXCLUSIVE_NAME = 'SFAG';

// Scholarships a student holds now. A scholarship counts when it was
// approved or renewed this academic year or last (applications for the
// coming year open in June, while last year's scholars are still on it),
// unless the latest decision on it is Not Renewed / Not Continuing.
// Scholarships without renewals (noRenewal, e.g. POLCA) count from
// approval until the office marks the scholar Graduated / Stopped.
// Returns [{ scholarshipId, scholarshipName }].
async function findHeldScholarships(studentNumber, { excludeApplicationId, now = new Date() } = {}) {
  const fromYear = academicYearStart(now) - 1;
  const [applications, renewals] = await Promise.all([
    Application.find({ studentNumber, status: 'Approved', ...(excludeApplicationId ? { _id: { $ne: excludeApplicationId } } : {}) })
      .select('scholarshipId scholarshipName createdAt reviewedAt endedAt').lean(),
    Renewal.find({ studentNumber, academicYear: { $gte: fromYear }, status: { $in: ['Renewed', 'Not Renewed', 'Not Continuing'] } })
      .select('scholarshipId scholarshipName status updatedAt').lean(),
  ]);

  // Latest event per scholarship decides whether it's held.
  const latest = new Map();
  const consider = (scholarshipId, scholarshipName, at, held) => {
    const prev = latest.get(scholarshipId);
    if (!prev || at >= prev.at) latest.set(scholarshipId, { scholarshipId, scholarshipName, at, held });
  };
  for (const a of applications) {
    const approvedAt = new Date(a.reviewedAt || a.createdAt);
    if (findScholarship(a.scholarshipId)?.noRenewal) {
      consider(a.scholarshipId, a.scholarshipName, approvedAt, true);
      if (a.endedAt) consider(a.scholarshipId, a.scholarshipName, new Date(a.endedAt), false);
      continue;
    }
    if (academicYearStart(a.createdAt) < fromYear) continue;
    consider(a.scholarshipId, a.scholarshipName, approvedAt, true);
    // Ended (graduated, stopped, or declined for another scholarship).
    if (a.endedAt) consider(a.scholarshipId, a.scholarshipName, new Date(a.endedAt), false);
  }
  for (const r of renewals) {
    consider(r.scholarshipId, r.scholarshipName, new Date(r.updatedAt), r.status === 'Renewed');
  }
  return [...latest.values()]
    .filter(s => s.held)
    .map(({ scholarshipId, scholarshipName }) => ({ scholarshipId, scholarshipName }));
}

// The other internally funded scholarships a student holds besides
// `scholarshipId` (empty when none).
async function otherScholarshipsHeld(studentNumber, scholarshipId, { excludeApplicationId } = {}) {
  const held = await findHeldScholarships(studentNumber, { excludeApplicationId });
  return held.filter(s => s.scholarshipId !== scholarshipId);
}

module.exports = { EXCLUSIVE_SCHOLARSHIP_ID, findHeldScholarships, otherScholarshipsHeld };
