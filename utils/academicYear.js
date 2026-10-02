// Academic years (scholarship cycles). Mirrors academicYearOf() and
// academicCycles() in the frontend's src/pages/admin/adminData.ts — keep the
// two in sync.
//
// DLSU-D's academic year starts in August, but scholarship applications
// (Entrance, SFA Grant) open June 1–20 for the coming year, so a cycle runs
// June through May, in Philippine time: an application in June 2026 belongs
// to AY 2026–2027; one in March 2026 to AY 2025–2026.

const ACADEMIC_YEAR_START_MONTH = 6; // June (1-based, as MongoDB's $month returns)
const TIMEZONE = 'Asia/Manila';

// The year an academic year starts in, for a Date (JS).
function academicYearStart(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: 'numeric' })
    .formatToParts(new Date(date));
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  return month >= ACADEMIC_YEAR_START_MONTH ? year : year - 1;
}

// A scholar is returning when their applications span 2+ distinct academic
// years — not when they have 2+ applications (several in one cycle is still
// a first-time scholar).
function isReturning(applications) {
  return new Set(applications.map(a => academicYearStart(a.createdAt))).size >= 2;
}

// The same academic-year start as a MongoDB aggregation expression, for
// pipelines that group applications by student.
function academicYearStartExpr(dateField = '$createdAt') {
  return {
    $let: {
      vars: { parts: { $dateToParts: { date: dateField, timezone: TIMEZONE } } },
      in: {
        $cond: [
          { $gte: ['$$parts.month', ACADEMIC_YEAR_START_MONTH] },
          '$$parts.year',
          { $subtract: ['$$parts.year', 1] },
        ],
      },
    },
  };
}

module.exports = { ACADEMIC_YEAR_START_MONTH, TIMEZONE, academicYearStart, isReturning, academicYearStartExpr };
