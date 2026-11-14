// Deleting a student (AdSO): for students the office no longer needs,
// e.g. rejected applicants and graduated or stopped scholars. Only when
// nothing of theirs is active: no scholarship held now, no application or
// renewal still being decided. The student and everything linked to them
// (applications, drafts, renewals, duty logs, messages and their thread)
// move to the Trash as one item, restorable for 30 days; their files are
// deleted for good with it. FSE reports keep their saved figures.
//
// Their Clerk sign-in isn't touched: if they sign in again they start a
// new profile.

const Student = require('../models/Student');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');
const Renewal = require('../models/Renewal');
const DutyLog = require('../models/DutyLog');
const Message = require('../models/Message');
const MessageThread = require('../models/MessageThread');
const { findHeldScholarships } = require('./exclusivity');

// The linked collections, by how each finds the student's records.
const LINKED = [
  ['applications', Application, sn => ({ studentNumber: sn })],
  ['applicationDrafts', ApplicationDraft, sn => ({ studentNumber: sn })],
  ['renewals', Renewal, sn => ({ studentNumber: sn })],
  ['dutyLogs', DutyLog, sn => ({ studentNumber: sn })],
  ['messages', Message, sn => ({ studentNumber: sn })],
  ['messageThreads', MessageThread, sn => ({ kind: 'student', key: sn })],
];

// Why this student can't be deleted now, or null.
async function deleteBlock(studentNumber) {
  const held = await findHeldScholarships(studentNumber);
  if (held.length) return `They hold the ${held.map(h => h.scholarshipName).join(' and the ')} now. Mark the scholarship as graduated or stopped first.`;
  const app = await Application.findOne({ studentNumber, status: { $in: ['Under Evaluation', 'Needs Revision'] } }).select('scholarshipName').lean();
  if (app) return `Their ${app.scholarshipName} application is still being decided.`;
  const renewal = await Renewal.findOne({ studentNumber, status: { $in: ['Submitted', 'Resubmitted', 'Under Evaluation', 'Needs Revision'] } }).select('scholarshipName').lean();
  if (renewal) return `Their ${renewal.scholarshipName} renewal is still being decided.`;
  return null;
}

// The file ids on a set of linked records (deleted for good with the item).
function filesOf(linked) {
  const ids = [];
  for (const a of linked.applications) for (const d of a.documents || []) if (d.fileId) ids.push(d.fileId);
  for (const r of linked.renewals) for (const d of r.documents || []) if (d.fileId) ids.push(d.fileId);
  for (const m of linked.messages) for (const f of m.attachments || []) if (f.fileId) ids.push(f.fileId);
  return ids;
}

// Moves the student and their records to the Trash. { item } or { error }.
async function trashStudent(studentNumber, by) {
  const student = await Student.findOne({ studentNumber }).lean();
  if (!student) return { error: 'Student not found.', status: 404 };
  const block = await deleteBlock(studentNumber);
  if (block) return { error: block, status: 409 };

  const linked = {};
  for (const [name, Model, filter] of LINKED) linked[name] = await Model.find(filter(studentNumber)).lean();
  const name = student.name || [student.firstName, student.lastName].filter(Boolean).join(' ') || studentNumber;

  const TrashItem = require('../models/TrashItem');
  const { KEEP_DAYS } = require('./trash');
  const now = new Date();
  const item = await TrashItem.create({
    kind: 'student', title: `Student: ${name} (${studentNumber})`, office: 'LSO',
    data: student, extra: linked, files: filesOf(linked),
    deletedAt: now, deletedBy: by?.email || by?.id, deletedByName: by?.name,
    purgeAt: new Date(now.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000),
  });
  for (const [name2, Model, filter] of LINKED) if (linked[name2].length) await Model.deleteMany(filter(studentNumber));
  await Student.deleteOne({ _id: student._id });
  return { item };
}

// Puts a deleted student and their records back. { error, status } when a
// new profile with the same student number or sign-in exists now.
async function restoreStudent(item) {
  const data = item.data;
  const clash = await Student.exists({ $or: [{ studentNumber: data.studentNumber }, ...(data.clerkId ? [{ clerkId: data.clerkId }] : [])] });
  if (clash) return { error: 'This student has signed up again since. Delete the new profile first to restore this one.', status: 409 };
  await Student.collection.insertOne(data);
  for (const [name, Model] of LINKED) {
    const docs = item.extra?.[name] || [];
    if (docs.length) await Model.collection.insertMany(docs, { ordered: false }).catch(err => { if (err?.code !== 11000) throw err; });
  }
  return { restored: true };
}

module.exports = { deleteBlock, trashStudent, restoreStudent };
