const { findExplicitWords } = require('../utils/profanity');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { requireAdso } = require('../middleware/requireAdmin');
const { requireStudent, requireStudentOrAdmin } = require('../middleware/requireStudent');
const Message = require('../models/Message');
const Student = require('../models/Student');
const Application = require('../models/Application');
const { putFile, deleteFile, openFile } = require('../utils/gridfs');
const { queueEmails, processOutbox } = require('../utils/outbox');

// The email alert for a new message ("you have a new message"), through the
// outbox (utils/outbox.js): sent within the sender's limits and retried
// instead of lost. Never fails the request.
function alertByEmail(message, { to, subject, email }) {
  queueEmails([{ key: `message:${message._id}`, kind: 'messageAlert', priority: 1, to, subject, ...email }])
    .then(n => n && processOutbox())
    .catch(err => console.error('Queueing the message alert failed:', err));
}
const { renderEmail } = require('../utils/emailTemplate');
const { requireOfficeHead } = require('../middleware/requireOfficeHead');
const { listOffices, norm } = require('../utils/offices');

// Messages between students and the AdSO (one conversation per student).
//
// Student:
//   GET  /api/messages/mine            their conversation (oldest first)
//   GET  /api/messages/mine/unread     { unread } messages from the AdSO not yet read
//   POST /api/messages/mine/read       mark the AdSO's messages read
//   POST /api/messages/mine            multipart: body, applicationId?, files (≤ 3 JPG/PNG/PDF, 10 MB each)
// AdSO:
//   GET  /api/messages/admin/threads   every conversation, latest first, with unread counts
//   GET  /api/messages/admin/unread    { unread } messages from students not yet read
//   GET  /api/messages/admin/threads/:studentNumber        one conversation + the student
//   POST /api/messages/admin/threads/:studentNumber        send (multipart, as above)
//   POST /api/messages/admin/threads/:studentNumber/read   mark the student's messages read
//   GET  /api/messages/admin/offices/:office (+ POST, POST …/read)   a duty office's conversation
// Office head (office portal):
//   GET  /api/messages/office/mine · GET …/mine/unread · POST …/mine/read · POST …/mine
//   GET  /api/messages/office/files/:fileId
// Both:
//   GET  /api/messages/files/:fileId   an attachment (the conversation's student, or the AdSO)
//
// New messages are also emailed (utils/mailer.js, Outlook): to the student's
// school email, or to ADSO_NOTIFY_EMAIL for the AdSO. At most one email per
// side while earlier messages are still unread, so a burst sends one alert.

const MAX_FILES = 3;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_BODY = 4000;
const ALLOWED = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => (ALLOWED[file.mimetype] ? cb(null, true) : cb(new Error('Attach JPG, PNG or PDF files only.'))),
});
// Multer errors (too big, too many, wrong type) as 400s.
const withUpload = (req, res, next) => upload.array('files', MAX_FILES)(req, res, err => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 10 MB.'
    : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Attach at most ${MAX_FILES} files.`
      : err.message;
  res.status(400).json({ error: message });
});

// The file really is what its type says (checks the first bytes).
const looksLike = file => ALLOWED[file.mimetype]?.every((b, i) => file.buffer[i] === b);

const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';

function view(m) {
  return {
    _id: String(m._id),
    from: m.from,
    authorName: m.from === 'adso' ? (m.authorName || 'Admissions and Scholarship Office') : m.authorName,
    body: m.body,
    attachments: (m.attachments || []).map(a => ({ fileId: String(a.fileId), filename: a.filename, mimetype: a.mimetype, size: a.size })),
    applicationId: m.applicationId ? String(m.applicationId) : null,
    applicationRef: m.applicationRef ?? null,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}

// Validates and stores a new message. Returns { message } or { status, error }.
// The thread is a student's ({ studentNumber }) or a duty office's ({ office }).
async function createMessage(req, { studentNumber, office, from, authorEmail, authorName }) {
  const thread = studentNumber ? { studentNumber } : { office };
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const files = req.files || [];
  if (!body && !files.length) return { status: 400, error: 'Write a message or attach a file.' };
  if (body.length > MAX_BODY) return { status: 400, error: `Messages can be at most ${MAX_BODY} characters.` };
  // No explicit words, from anyone (utils/profanity.js).
  const explicit = findExplicitWords(body);
  if (explicit.length) return { status: 400, error: `Please remove inappropriate language before sending (${explicit.join(', ')}). If you're reporting something someone said, describe it without the word.`, code: 'explicit_words' };
  if (files.some(f => !looksLike(f))) return { status: 400, error: "One of the files isn't a real JPG, PNG or PDF." };

  let application = null;
  if (req.body?.applicationId && studentNumber) {
    if (!mongoose.Types.ObjectId.isValid(req.body.applicationId)) return { status: 400, error: 'Invalid application.' };
    application = await Application.findOne({ _id: req.body.applicationId, studentNumber }).select('referenceCode').lean();
    if (!application) return { status: 400, error: "That application isn't this student's." };
  }

  // One alert per burst: skip the email while this side's earlier
  // messages are still unread.
  const alreadyWaiting = await Message.exists({ ...thread, from, readAt: null });

  const stored = [];
  try {
    for (const f of files) {
      const fileId = await putFile({ buffer: f.buffer, filename: f.originalname, mimetype: f.mimetype, metadata: { kind: 'message', ...thread } });
      stored.push({ fileId, filename: f.originalname, mimetype: f.mimetype, size: f.size });
    }
    const message = await Message.create({
      ...thread, from, authorEmail, authorName, body, attachments: stored,
      ...(application ? { applicationId: application._id, applicationRef: application.referenceCode } : {}),
    });
    return { message, alreadyWaiting };
  } catch (err) {
    await Promise.all(stored.map(s => deleteFile(s.fileId).catch(() => {})));
    throw err;
  }
}

function preview(message) {
  const text = message.body ? (message.body.length > 500 ? `${message.body.slice(0, 500)}…` : message.body) : '';
  const files = message.attachments.length ? `\n\n(${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'})` : '';
  return `${text}${files}`;
}

// --- Student -------------------------------------------------------------------

router.get('/mine', requireStudent, async (req, res) => {
  try {
    const messages = await Message.find({ studentNumber: req.studentNumber }).sort({ createdAt: 1 }).limit(1000).lean();
    res.json({ messages: messages.map(view) });
  } catch (err) {
    console.error('Load messages error:', err);
    res.status(500).json({ error: 'Failed to load your messages.' });
  }
});

router.get('/mine/unread', requireStudent, async (req, res) => {
  try {
    res.json({ unread: await Message.countDocuments({ studentNumber: req.studentNumber, from: 'adso', readAt: null }) });
  } catch (err) {
    console.error('Unread messages error:', err);
    res.status(500).json({ error: 'Failed to load your messages.' });
  }
});

router.post('/mine/read', requireStudent, async (req, res) => {
  try {
    await Message.updateMany({ studentNumber: req.studentNumber, from: 'adso', readAt: null }, { $set: { readAt: new Date() } });
    res.json({ unread: 0 });
  } catch (err) {
    console.error('Mark messages read error:', err);
    res.status(500).json({ error: 'Failed to update your messages.' });
  }
});

router.post('/mine', requireStudent, withUpload, async (req, res) => {
  try {
    const student = await Student.findOne({ studentNumber: req.studentNumber }).select('name email').lean();
    const result = await createMessage(req, { studentNumber: req.studentNumber, from: 'student', authorEmail: student?.email, authorName: student?.name });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting && process.env.ADSO_NOTIFY_EMAIL) {
      const email = renderEmail({
        heading: `New message from ${student?.name || req.studentNumber}`,
        intro: `${student?.name || 'A student'} (${req.studentNumber}) sent a message on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      alertByEmail(result.message, { to: process.env.ADSO_NOTIFY_EMAIL, subject: `AniSkolar: new message from ${student?.name || req.studentNumber} (${req.studentNumber})`, email });
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send your message.' });
  }
});

// --- AdSO ----------------------------------------------------------------------

router.get('/admin/threads', requireAdso, async (req, res) => {
  try {
    const group = (key, from) => Message.aggregate([
      { $match: { [key]: { $nin: [null, ''] } } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: `$${key}`,
        last: { $first: '$$ROOT' },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ['$from', from] }, { $eq: ['$readAt', null] }] }, 1, 0] } },
        count: { $sum: 1 },
      } },
      { $sort: { 'last.createdAt': -1 } },
      { $limit: 500 },
    ]);
    const [threads, officeThreads, offices] = await Promise.all([group('studentNumber', 'student'), group('office', 'office'), listOffices()]);
    const headOf = new Map(offices.map(o => [norm(o.office), o]));
    const students = await Student.find({ studentNumber: { $in: threads.map(t => t._id) } })
      .select('studentNumber name email programCode college yearLevel avatarUrl').lean();
    const byNumber = new Map(students.map(s => [s.studentNumber, s]));
    res.json({
      threads: threads.map(t => {
        const s = byNumber.get(t._id);
        return {
          kind: 'student',
          studentNumber: t._id,
          name: s?.name ?? '',
          email: s?.email ?? '',
          programCode: s?.programCode ?? '',
          college: s?.college ?? '',
          yearLevel: s?.yearLevel ?? '',
          avatarUrl: s?.avatarUrl,
          unread: t.unread,
          count: t.count,
          last: view(t.last),
        };
      }).concat(officeThreads.map(t => ({
        kind: 'office',
        office: t._id,
        name: t._id,
        email: headOf.get(norm(t._id))?.headEmail ?? '',
        headName: headOf.get(norm(t._id))?.headName ?? '',
        unread: t.unread,
        count: t.count,
        last: view(t.last),
      }))).sort((a, b) => new Date(b.last.createdAt) - new Date(a.last.createdAt)),
    });
  } catch (err) {
    console.error('Load message threads error:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

router.get('/admin/unread', requireAdso, async (req, res) => {
  try {
    res.json({ unread: await Message.countDocuments({ from: { $in: ['student', 'office'] }, readAt: null }) });
  } catch (err) {
    console.error('Unread messages (admin) error:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

async function findStudent(studentNumber) {
  if (typeof studentNumber !== 'string' || !/^\d{9}$/.test(studentNumber)) return null;
  return Student.findOne({ studentNumber }).select('studentNumber name email programCode college yearLevel avatarUrl').lean();
}

router.get('/admin/threads/:studentNumber', requireAdso, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const [messages, applications] = await Promise.all([
      Message.find({ studentNumber: student.studentNumber }).sort({ createdAt: 1 }).limit(1000).lean(),
      Application.find({ studentNumber: student.studentNumber }).select('_id referenceCode scholarshipName status').sort({ createdAt: -1 }).lean(),
    ]);
    const { _id, ...info } = student;
    res.json({
      student: info,
      applications: applications.map(a => ({ _id: String(a._id), referenceCode: a.referenceCode, scholarshipName: a.scholarshipName, status: a.status })),
      messages: messages.map(view),
    });
  } catch (err) {
    console.error('Load message thread error:', err);
    res.status(500).json({ error: 'Failed to load the conversation.' });
  }
});

router.post('/admin/threads/:studentNumber', requireAdso, withUpload, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const result = await createMessage(req, {
      studentNumber: student.studentNumber, from: 'adso', authorEmail: req.adminUser.email, authorName: req.adminUser.name,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting) {
      const email = renderEmail({
        heading: 'You have a new message',
        intro: 'The Admissions and Scholarship Office sent you a message on AniSkolar:',
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      alertByEmail(result.message, { to: student.email, subject: 'AniSkolar: new message from the Admissions and Scholarship Office', email });
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send message (admin) error:', err);
    res.status(500).json({ error: 'Failed to send the message.' });
  }
});

router.post('/admin/threads/:studentNumber/read', requireAdso, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await Message.updateMany({ studentNumber: student.studentNumber, from: 'student', readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark thread read error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

// --- Duty offices ----------------------------------------------------------------

// A duty office from the AdSO's list (by name, ignoring case), or null.
async function findOffice(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  return (await listOffices()).find(o => norm(o.office) === norm(name)) ?? null;
}

router.get('/admin/offices/:office', requireAdso, async (req, res) => {
  try {
    const office = await findOffice(req.params.office);
    if (!office) return res.status(404).json({ error: 'Office not found.' });
    const messages = await Message.find({ office: office.office }).sort({ createdAt: 1 }).limit(1000).lean();
    res.json({ office: { office: office.office, headName: office.headName ?? '', headEmail: office.headEmail ?? '' }, messages: messages.map(view) });
  } catch (err) {
    console.error('Load office thread error:', err);
    res.status(500).json({ error: 'Failed to load the conversation.' });
  }
});

router.post('/admin/offices/:office', requireAdso, withUpload, async (req, res) => {
  try {
    const office = await findOffice(req.params.office);
    if (!office) return res.status(404).json({ error: 'Office not found.' });
    const result = await createMessage(req, { office: office.office, from: 'adso', authorEmail: req.adminUser.email, authorName: req.adminUser.name });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting && office.headEmail) {
      const email = renderEmail({
        heading: 'You have a new message',
        intro: `The Admissions and Scholarship Office sent ${office.office} a message on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      alertByEmail(result.message, { to: office.headEmail, subject: 'AniSkolar: new message from the Admissions and Scholarship Office', email });
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send office message (admin) error:', err);
    res.status(500).json({ error: 'Failed to send the message.' });
  }
});

router.post('/admin/offices/:office/read', requireAdso, async (req, res) => {
  try {
    const office = await findOffice(req.params.office);
    if (!office) return res.status(404).json({ error: 'Office not found.' });
    await Message.updateMany({ office: office.office, from: 'office', readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark office thread read error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.get('/office/mine', requireOfficeHead, async (req, res) => {
  try {
    const messages = await Message.find({ office: req.officeHead.office }).sort({ createdAt: 1 }).limit(1000).lean();
    res.json({ messages: messages.map(view) });
  } catch (err) {
    console.error('Load office messages error:', err);
    res.status(500).json({ error: 'Failed to load your messages.' });
  }
});

router.get('/office/mine/unread', requireOfficeHead, async (req, res) => {
  try {
    res.json({ unread: await Message.countDocuments({ office: req.officeHead.office, from: 'adso', readAt: null }) });
  } catch (err) {
    console.error('Office unread error:', err);
    res.status(500).json({ error: 'Failed to load your messages.' });
  }
});

router.post('/office/mine/read', requireOfficeHead, async (req, res) => {
  try {
    await Message.updateMany({ office: req.officeHead.office, from: 'adso', readAt: null }, { $set: { readAt: new Date() } });
    res.json({ unread: 0 });
  } catch (err) {
    console.error('Office read error:', err);
    res.status(500).json({ error: 'Failed to update your messages.' });
  }
});

router.post('/office/mine', requireOfficeHead, withUpload, async (req, res) => {
  try {
    const { office, name, email } = req.officeHead;
    const result = await createMessage(req, { office, from: 'office', authorEmail: email, authorName: name ? `${name} (${office})` : office });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting && process.env.ADSO_NOTIFY_EMAIL) {
      const mail = renderEmail({
        heading: `New message from ${office}`,
        intro: `${name || email} (${office}) sent a message on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      alertByEmail(result.message, { to: process.env.ADSO_NOTIFY_EMAIL, subject: `AniSkolar: new message from ${office}`, email: mail });
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send office message error:', err);
    res.status(500).json({ error: 'Failed to send your message.' });
  }
});

router.get('/office/files/:fileId', requireOfficeHead, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) return res.status(400).json({ error: 'Invalid file id.' });
    const fileId = new mongoose.Types.ObjectId(req.params.fileId);
    const message = await Message.findOne({ 'attachments.fileId': fileId, office: req.officeHead.office }).select('attachments').lean();
    if (!message) return res.status(404).json({ error: 'File not found.' });
    const meta = message.attachments.find(a => String(a.fileId) === String(fileId));
    const file = await openFile(fileId);
    if (!file) return res.status(404).json({ error: 'File not found.' });
    res.set('Content-Type', meta?.mimetype || file.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    file.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); }).pipe(res);
  } catch (err) {
    console.error('Office message file error:', err);
    res.status(500).json({ error: 'Failed to load the file.' });
  }
});

// --- Attachments ---------------------------------------------------------------

router.get('/files/:fileId', requireStudentOrAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) return res.status(400).json({ error: 'Invalid file id.' });
    const fileId = new mongoose.Types.ObjectId(req.params.fileId);
    // The conversation's student, or the AdSO (not the other offices).
    const filter = { 'attachments.fileId': fileId };
    if (req.studentNumber) filter.studentNumber = req.studentNumber;
    else if (req.adminUser?.office !== 'LSO') return res.status(404).json({ error: 'File not found.' });
    const message = await Message.findOne(filter).select('attachments').lean();
    if (!message) return res.status(404).json({ error: 'File not found.' });
    const meta = message.attachments.find(a => String(a.fileId) === String(fileId));
    const file = await openFile(fileId);
    if (!file) return res.status(404).json({ error: 'File not found.' });
    res.set('Content-Type', meta?.mimetype || file.contentType || 'application/octet-stream');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    file.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); }).pipe(res);
  } catch (err) {
    console.error('Message file error:', err);
    res.status(500).json({ error: 'Failed to load the file.' });
  }
});

module.exports = router;
