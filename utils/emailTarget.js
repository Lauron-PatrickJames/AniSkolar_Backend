const Application = require('../models/Application');
const Student = require('../models/Student');
const { findScholarship, allScholarships, acceptsOnlineApplications } = require('../data/scholarships');
const { COLLEGES, YEAR_LEVELS } = require('../data/programs');
const { currentHolders } = require('./collegeSlots');

// Who an announcement email goes to (Announcement.emailTarget):
//   mode            'all' | 'applicants' | 'scholars' | 'students'
//   scholarshipIds  applicants / scholars of these (empty = any scholarship)
//   statuses        applicants only: their application's status (empty = any)
//   colleges        narrow to these colleges (empty = any)
//   yearLevels      narrow to these year levels (empty = any)
//   studentNumbers  mode 'students': exactly these students
// Colleges and year levels narrow every mode, including 'students'.

const MODES = ['all', 'applicants', 'scholars', 'students'];
const STATUSES = ['Under Evaluation', 'Needs Revision', 'Approved', 'Rejected'];
const MAX_STUDENTS = 2000;

const list = v => (Array.isArray(v) ? v : []);

// Validates a target from the client. Returns { value } or { error }.
function parseEmailTarget(raw) {
  let t = raw;
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch { return { error: 'Invalid email audience.' }; }
  }
  if (!t || typeof t !== 'object' || !MODES.includes(t.mode)) return { error: 'Choose who gets the email.' };
  const scholarshipIds = [...new Set(list(t.scholarshipIds).filter(id => typeof id === 'string'))];
  if (scholarshipIds.some(id => !findScholarship(id))) return { error: 'Unknown scholarship in the email audience.' };
  const statuses = [...new Set(list(t.statuses))];
  if (statuses.some(s => !STATUSES.includes(s))) return { error: 'Unknown application status in the email audience.' };
  const colleges = [...new Set(list(t.colleges))];
  if (colleges.some(c => !COLLEGES[c])) return { error: 'Unknown college in the email audience.' };
  const yearLevels = [...new Set(list(t.yearLevels))];
  if (yearLevels.some(y => !YEAR_LEVELS.includes(y))) return { error: 'Unknown year level in the email audience.' };
  const studentNumbers = [...new Set(list(t.studentNumbers).map(n => String(n).trim()).filter(Boolean))];
  if (studentNumbers.some(n => !/^\d{9}$/.test(n))) return { error: 'Student numbers in the email audience must have 9 digits.' };
  if (studentNumbers.length > MAX_STUDENTS) return { error: `Pick at most ${MAX_STUDENTS} students.` };
  if (t.mode === 'students' && !studentNumbers.length) return { error: 'Add at least one student to email.' };
  return {
    value: {
      mode: t.mode,
      scholarshipIds: t.mode === 'applicants' || t.mode === 'scholars' ? scholarshipIds : [],
      statuses: t.mode === 'applicants' ? statuses : [],
      colleges,
      yearLevels,
      studentNumbers: t.mode === 'students' ? studentNumbers : [],
    },
  };
}

// The target of an announcement, also for ones saved before emailTarget
// existed (emailAudience + the related scholarship).
function targetOf(doc) {
  if (doc.emailTarget?.mode) return doc.emailTarget;
  const mode = doc.emailAudience || 'all';
  return { mode, scholarshipIds: mode === 'all' || !doc.scholarshipId ? [] : [doc.scholarshipId], statuses: [], colleges: [], yearLevels: [], studentNumbers: [] };
}

// Student filter for a target.
async function studentFilter(target) {
  const filter = {};
  if (target.mode === 'applicants') {
    const appFilter = {};
    if (target.scholarshipIds?.length) appFilter.scholarshipId = { $in: target.scholarshipIds };
    if (target.statuses?.length) appFilter.status = { $in: target.statuses };
    filter.studentNumber = { $in: await Application.distinct('studentNumber', appFilter) };
  } else if (target.mode === 'scholars') {
    const ids = target.scholarshipIds?.length
      ? target.scholarshipIds
      : allScholarships().filter(acceptsOnlineApplications).map(s => s.id);
    const holders = new Set();
    for (const id of ids) (await currentHolders(id)).forEach(n => holders.add(n));
    filter.studentNumber = { $in: [...holders] };
  } else if (target.mode === 'students') {
    filter.studentNumber = { $in: target.studentNumbers || [] };
  }
  if (target.colleges?.length) filter.college = { $in: target.colleges };
  if (target.yearLevels?.length) filter.yearLevel = { $in: target.yearLevels };
  return filter;
}

// Sorted, unique, lower-case school emails for a target.
async function recipientEmails(target) {
  const emails = await Student.distinct('email', { ...(await studentFilter(target)), email: { $exists: true, $ne: '' } });
  return [...new Set(emails.map(e => e.toLowerCase()))].sort();
}

// For the editor: how many students a target reaches, a few names, and
// student numbers that matched nobody.
async function previewTarget(target) {
  const filter = await studentFilter(target);
  const students = await Student.find({ ...filter, email: { $exists: true, $ne: '' } }).select('studentNumber name').sort({ name: 1 }).lean();
  const found = new Set(students.map(s => s.studentNumber));
  return {
    count: students.length,
    sample: students.slice(0, 5).map(s => s.name || s.studentNumber),
    unknown: target.mode === 'students' ? (target.studentNumbers || []).filter(n => !found.has(n)) : [],
  };
}

module.exports = { parseEmailTarget, targetOf, recipientEmails, previewTarget, STATUSES };
