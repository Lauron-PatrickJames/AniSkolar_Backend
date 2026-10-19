const Application = require('../models/Application');
const Student = require('../models/Student');
const { findHeldScholarships } = require('./exclusivity');
const { COLLEGES } = require('../data/programs');

// Scholarships with a fixed number of scholars (data/scholarships.js):
//   slotsPerCollege — per college (POLCA: 2 per college)
//   totalSlots      — in all, campus-wide (Alumni: 2)
// A new scholar is accepted only when a current one graduates or stops
// (Oct 2026). When full, students can't apply and applications can't be
// approved.

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

// Null when there's a free slot for this student (or the scholarship has no
// slots); otherwise { slots, holders: [{ studentNumber, name }], message }
// (plus college / collegeName for per-college slots).
async function slotsFull(scholarship, studentNumber) {
  if (scholarship?.totalSlots) {
    const holders = await currentHolders(scholarship.id, { excludeStudent: studentNumber });
    if (holders.length < scholarship.totalSlots) return null;
    const students = await Student.find({ studentNumber: { $in: holders } }).select('studentNumber name').lean();
    const slots = scholarship.totalSlots;
    return {
      slots,
      holders: students.map(s => ({ studentNumber: s.studentNumber, name: s.name })),
      message: `The ${scholarship.name} takes only ${slots} scholars in all, and ${slots === 2 ? 'both' : 'all'} slots are taken. A slot opens when a current scholar graduates or stops.`,
    };
  }
  return collegeSlotsFull(scholarship, studentNumber);
}

// Per-college slots: null when the student's college has a free slot (or
// the student's college isn't known).
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

module.exports = { currentHolders, slotsFull };
