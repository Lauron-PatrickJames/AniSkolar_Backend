const Application = require('../models/Application');
const Student = require('../models/Student');
const { findHeldScholarships } = require('./exclusivity');
const { COLLEGES } = require('../data/programs');

// Scholarships with a fixed number of scholars per college
// (`slotsPerCollege` in data/scholarships.js). POLCA takes 2 per college
// and accepts a new one only when a current scholar graduates or stops
// (Oct 2026, to confirm with POLCA). A full college can't apply, and its
// applications can't be approved.

// Student numbers holding `scholarshipId` now (same rule as
// findHeldScholarships, checked per approved applicant).
async function currentHolders(scholarshipId, { excludeStudent } = {}) {
  const candidates = await Application.distinct('studentNumber', { scholarshipId, status: 'Approved' });
  const holders = [];
  for (const studentNumber of candidates) {
    if (studentNumber === excludeStudent) continue;
    const held = await findHeldScholarships(studentNumber);
    if (held.some(h => h.scholarshipId === scholarshipId)) holders.push(studentNumber);
  }
  return holders;
}

// Null when the student's college has a free slot (or the scholarship has
// no slots, or the student's college isn't known); otherwise
// { college, collegeName, slots, holders: [{ studentNumber, name }], message }.
async function collegeSlotsFull(scholarship, studentNumber) {
  if (!scholarship?.slotsPerCollege) return null;
  const student = await Student.findOne({ studentNumber }).select('college').lean();
  const college = student?.college;
  if (!college) return null;
  const holders = await currentHolders(scholarship.id, { excludeStudent: studentNumber });
  if (!holders.length) return null;
  const sameCollege = await Student.find({ studentNumber: { $in: holders }, college }).select('studentNumber name').lean();
  if (sameCollege.length < scholarship.slotsPerCollege) return null;
  const collegeName = COLLEGES[college] || college;
  const slots = scholarship.slotsPerCollege;
  return {
    college,
    collegeName,
    slots,
    holders: sameCollege.map(s => ({ studentNumber: s.studentNumber, name: s.name })),
    message: `The ${scholarship.name} takes ${slots} scholars per college, and the ${slots} slots for the ${collegeName} are taken. A slot opens when a current scholar graduates or stops.`,
  };
}

module.exports = { currentHolders, collegeSlotsFull };
