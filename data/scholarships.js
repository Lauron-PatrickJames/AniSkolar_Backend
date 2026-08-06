// Server-side source of truth for valid scholarships. The application
// submit route checks scholarshipId against this list instead of trusting
// whatever scholarshipId/scholarshipName the client sends.
//
// IMPORTANT: keep this in sync with frontend/src/data/scholarships.ts
// (mockScholarships) — whenever you add/rename/remove a scholarship there,
// mirror the id + name change here too. Once scholarships are managed
// server-side (e.g. their own MongoDB collection), replace this file with
// a DB query and delete this comment.

const SCHOLARSHIPS = [
  { id: 's1', name: 'Student Financial Aid (SFA) Grant' },
  { id: 's2', name: 'Entrance Scholarship' },
];

function findScholarship(scholarshipId) {
  return SCHOLARSHIPS.find(s => s.id === scholarshipId);
}

module.exports = { SCHOLARSHIPS, findScholarship };