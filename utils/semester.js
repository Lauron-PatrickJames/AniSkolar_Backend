// One-semester grants (oneSemester in data/scholarships.js, e.g. the USG's
// SFAG): a grant covers the semester it was decided for, then ends; the
// student applies again in the next call. Mirrors semesterEnd() in the
// frontend's src/utils/eligibility.ts.
//
// In Philippine time, a grant approved June–December covers the 1st
// semester (June–July is the enrollment run-up to it) and ends with the
// year; one approved January–May covers the 2nd semester and ends at the
// start of June.

const TIMEZONE = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8, no daylight saving

// When a one-semester grant approved at `date` stops counting (exclusive).
function semesterEnd(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: 'numeric' })
    .formatToParts(new Date(date));
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const endUtc = month >= 6 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, 5, 1);
  return new Date(endUtc - MANILA_OFFSET_MS);
}

module.exports = { semesterEnd };
