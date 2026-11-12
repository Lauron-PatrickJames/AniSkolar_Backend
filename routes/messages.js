const { findExplicitWords } = require('../utils/profanity');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const { requireAdso, requireAdmin } = require('../middleware/requireAdmin');
const { clerkClient } = require('@clerk/express');
const { OFFICES, OFFICE_CODES, OFFICE_NAMES, CLERK_OFFICES } = require('../data/offices');
const { officeFilter } = require('../utils/officeScope');
const { requireStudent, requireStudentOrAdmin } = require('../middleware/requireStudent');
const Message = require('../models/Message');
const MessageThread = require('../models/MessageThread');
const Student = require('../models/Student');
const Application = require('../models/Application');
const { putFile, deleteFile, openFile } = require('../utils/gridfs');
const { queueEmails } = require('../utils/outbox');

// The email alert for a new message ("you have a new message"), through the
// outbox (utils/outbox.js): sent within the sender's limits and retried
// instead of lost. Never fails the request. It waits 2 minutes, so a
// message unsent right away never reaches anyone's email.
const ALERT_DELAY_MS = 2 * 60 * 1000;
function alertByEmail(message, { to, subject, email }) {
  const list = Array.isArray(to) ? to : [to];
  const sendAt = new Date(Date.now() + ALERT_DELAY_MS);
  queueEmails(list.map((addr, i) => ({ key: i ? `message:${message._id}:${i}` : `message:${message._id}`, kind: 'messageAlert', priority: 1, to: addr, subject, nextAttemptAt: sendAt, ...email })))
    .catch(err => console.error('Queueing the message alert failed:', err));
}

// --- Unsending -------------------------------------------------------------------
// The writer can unsend a message within 24 hours: its text, files and
// mentioned application are removed for both sides, and an email alert
// still waiting is cancelled. Returns { message, emailSent } or
// { status, error }.
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;
async function unsendMessage(m) {
  if (m.unsentAt) return { status: 409, error: 'It’s already unsent.' };
  if (Date.now() - new Date(m.createdAt).getTime() > UNSEND_WINDOW_MS) {
    return { status: 409, error: 'Messages can only be unsent within 24 hours of sending.' };
  }
  const OutboxEmail = require('../models/OutboxEmail');
  const keys = { key: { $regex: `^message:${m._id}(:|$)` } };
  await OutboxEmail.deleteMany({ ...keys, status: 'queued' });
  const emailSent = !!(await OutboxEmail.exists({ ...keys, status: 'sent' }));
  const files = (m.attachments || []).map(a => a.fileId);
  const now = new Date();
  await Message.updateOne({ _id: m._id }, {
    $set: { unsentAt: now, body: '', attachments: [], readAt: m.readAt || now },
    $unset: { applicationId: '', applicationRef: '' },
  });
  for (const fileId of files) await deleteFile(fileId).catch(err => console.error('Deleting an unsent message’s file failed:', err.message));
  return { message: { ...m, unsentAt: now, body: '', attachments: [], applicationId: null, applicationRef: null, readAt: m.readAt || now }, emailSent };
}

const findMessage = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404).json({ error: 'Message not found.' }); return null; }
  const m = await Message.findById(req.params.id).lean();
  if (!m) res.status(404).json({ error: 'Message not found.' });
  return m;
};
const { renderEmail } = require('../utils/emailTemplate');
const { requireOfficeHead } = require('../middleware/requireOfficeHead');
const { listOffices, norm } = require('../utils/offices');

// Messages between students and the scholarship offices. Each office (the
// AdSO, POLCA, Alumni…) has its own inbox: one conversation per student per
// office. Message.inbox is the office code; older messages have none and
// are the AdSO's ('LSO').
//
// Student (?office= / body.office picks the office; default the AdSO):
//   GET  /api/messages/mine/offices    the offices they can write to (with last message and
//                                      unread; `started` = has a conversation or their application)
//   GET  /api/messages/mine            their conversation with that office (oldest first)
//   GET  /api/messages/mine/unread     { unread } office messages not yet read (every office)
//   POST /api/messages/mine/read       mark that office's messages read
//   POST /api/messages/mine            multipart: body, office?, applicationId?, files (≤ 3 JPG/PNG/PDF, 10 MB each)
// Any office admin (their own office's inbox only):
//   GET  /api/messages/admin/threads   every conversation, latest first, with unread counts
//   GET  /api/messages/admin/unread    { unread } messages from students not yet read
//   GET  /api/messages/admin/students?q=   students to start a conversation with
//   GET  /api/messages/admin/peers     the other scholarship offices (with admin accounts)
//   GET  /api/messages/admin/peers/:code (+ POST, POST …/read, PATCH …/state, DELETE)
//                                      a conversation with another scholarship office
//                                      (Message.peer = the two codes, sorted, "LSO|POLCA")
//   GET  /api/messages/admin/threads/:studentNumber        one conversation + the student
//   POST /api/messages/admin/threads/:studentNumber        send (multipart, as above)
//   POST /api/messages/admin/threads/:studentNumber/read   mark the student's messages read
//   PATCH /api/messages/admin/threads/:studentNumber/state { pinned?, archived?, unread? }
//   DELETE /api/messages/admin/threads/:studentNumber      delete it from the AdSO's inbox
//   GET  /api/messages/admin/offices/:office (+ POST, POST …/read, PATCH …/state, DELETE)
//                                                          a duty office's conversation
// The duty-office conversations below are the AdSO's only.
// Pinned, archived, marked unread and deleted are the office's own inbox
// state (models/MessageThread.js); the student or office keeps their copy.
// Office head (office portal):
//   GET  /api/messages/office/mine · GET …/mine/unread · POST …/mine/read · POST …/mine
//   GET  /api/messages/office/files/:fileId
// Both:
//   GET  /api/messages/files/:fileId   an attachment (the conversation's student, or the AdSO)
//
// New messages are also emailed (utils/mailer.js, Outlook): to the student's
// school email, or to ADSO_NOTIFY_EMAIL for the AdSO and to an office's
// admin accounts (from Clerk) for the other offices. At most one email per
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

const ADSO = 'LSO';
// A student conversation's messages in an office's inbox (the AdSO's include
// messages from before inboxes, which have none).
const inboxOf = code => (code === ADSO ? { inbox: { $in: [null, ADSO] } } : { inbox: code });
// The office a student is writing to (?office= or body.office, by code),
// the AdSO by default; null if it isn't an office.
function studentInbox(req) {
  const raw = req.query?.office ?? req.body?.office;
  const code = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : ADSO;
  return OFFICE_CODES.includes(code) ? code : null;
}
const officeLabel = code => OFFICE_NAMES[code] || OFFICE_NAMES[ADSO];
// MessageThread key of a student's conversation with an office: the AdSO's
// keep the plain student number (as before inboxes), others "POLCA|<no.>".
const studentKey = (code, studentNumber) => (code === ADSO ? studentNumber : `${code}|${studentNumber}`);

// An office's admin emails (Clerk accounts with that office), cached for
// ten minutes. The AdSO uses ADSO_NOTIFY_EMAIL instead.
let adminEmailCache = { at: 0, byOffice: new Map() };
async function officeAdminEmails(code) {
  if (Date.now() - adminEmailCache.at > 10 * 60 * 1000) {
    const byOffice = new Map();
    const { data = [] } = await clerkClient.users.getUserList({ limit: 500 });
    for (const u of data) {
      if (u.publicMetadata?.role !== 'admin') continue;
      const office = CLERK_OFFICES[String(u.publicMetadata?.office ?? '').trim().toUpperCase()];
      const email = u.emailAddresses?.[0]?.emailAddress;
      if (office && email) byOffice.set(office, [...(byOffice.get(office) ?? []), email]);
    }
    adminEmailCache = { at: Date.now(), byOffice };
  }
  return adminEmailCache.byOffice.get(code) ?? [];
}

// Office-to-office conversations: both offices' codes, sorted ("LSO|POLCA").
const pairKey = (a, b) => [a, b].sort().join('|');
// Matches the conversations an office is part of.
const peerOf = code => ({ peer: { $regex: `(^|\\|)${code}(\\||$)` } });
const officeShort = code => OFFICES.find(o => o.code === code)?.short ?? code;
// A message as one office sees it: its own are 'adso' (mine), the other's 'office'.
function peerView(m, me) {
  const mine = m.fromOffice === me;
  return {
    ...view(m),
    from: mine ? 'adso' : 'office',
    authorName: mine ? (m.authorName || officeLabel(me)) : [m.authorName, officeShort(m.fromOffice)].filter(Boolean).join(' · '),
  };
}

const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';

function view(m) {
  return {
    _id: String(m._id),
    from: m.from,
    // Which office's conversation (student conversations only).
    ...(m.studentNumber ? { office: m.inbox || ADSO } : {}),
    authorName: m.from === 'adso' ? (m.authorName || officeLabel(m.inbox || ADSO)) : m.authorName,
    body: m.body,
    attachments: (m.attachments || []).map(a => ({ fileId: String(a.fileId), filename: a.filename, mimetype: a.mimetype, size: a.size })),
    applicationId: m.applicationId ? String(m.applicationId) : null,
    applicationRef: m.applicationRef ?? null,
    readAt: m.readAt,
    unsentAt: m.unsentAt ?? null,
    createdAt: m.createdAt,
  };
}

// Validates and stores a new message. Returns { message } or { status, error }.
// The thread is a student's with an office ({ studentNumber, inbox }) or a
// duty office's with the AdSO ({ office }).
async function createMessage(req, { studentNumber, inbox = ADSO, office, peer, fromOffice, from, authorEmail, authorName }) {
  const thread = studentNumber ? { studentNumber, inbox } : peer ? { peer, fromOffice } : { office };
  const match = studentNumber ? { studentNumber, ...inboxOf(inbox) } : peer ? { peer, fromOffice } : { office };
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
  const alreadyWaiting = await Message.exists({ ...match, from, readAt: null });

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

// The offices a student can write to: the AdSO and every partner office
// with an admin account to answer. `started` marks the ones the student
// already deals with (a conversation, or one of their applications); the
// page lists those and offers the rest under "Message another office".
router.get('/mine/offices', requireStudent, async (req, res) => {
  try {
    const [appOffices, groups] = await Promise.all([
      Application.distinct('office', { studentNumber: req.studentNumber }),
      Message.aggregate([
        { $match: { studentNumber: req.studentNumber } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: { $ifNull: ['$inbox', ADSO] },
          last: { $first: '$$ROOT' },
          unread: { $sum: { $cond: [{ $and: [{ $eq: ['$from', 'adso'] }, { $eq: ['$readAt', null] }] }, 1, 0] } },
        } },
      ]),
    ]);
    const byCode = new Map(groups.map(g => [g._id, g]));
    const started = new Set([ADSO, ...appOffices.map(o => o || ADSO), ...byCode.keys()]);
    // Offices with someone to reply (any office, if Clerk can't be asked).
    let staffed = null;
    try {
      staffed = new Set((await Promise.all(OFFICES.map(async o => ((await officeAdminEmails(o.code)).length ? o.code : null)))).filter(Boolean));
    } catch (err) {
      console.error('Office admin lookup failed:', err);
    }
    const offices = OFFICES.filter(o => started.has(o.code) || !staffed || staffed.has(o.code)).map(o => {
      const g = byCode.get(o.code);
      return { code: o.code, name: o.name, short: o.short, started: started.has(o.code), unread: g?.unread ?? 0, last: g ? view(g.last) : null };
    }).sort((x, y) => (x.code === ADSO ? -1 : y.code === ADSO ? 1 : 0)
      || (new Date(y.last?.createdAt ?? 0) - new Date(x.last?.createdAt ?? 0)));
    res.json({ offices });
  } catch (err) {
    console.error('Load message offices error:', err);
    res.status(500).json({ error: 'Failed to load your messages.' });
  }
});

router.get('/mine', requireStudent, async (req, res) => {
  try {
    const inbox = studentInbox(req);
    if (!inbox) return res.status(400).json({ error: 'Unknown office.' });
    const messages = await Message.find({ studentNumber: req.studentNumber, ...inboxOf(inbox) }).sort({ createdAt: 1 }).limit(1000).lean();
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
    const inbox = studentInbox(req);
    if (!inbox) return res.status(400).json({ error: 'Unknown office.' });
    await Message.updateMany({ studentNumber: req.studentNumber, ...inboxOf(inbox), from: 'adso', readAt: null }, { $set: { readAt: new Date() } });
    res.json({ unread: await Message.countDocuments({ studentNumber: req.studentNumber, from: 'adso', readAt: null }) });
  } catch (err) {
    console.error('Mark messages read error:', err);
    res.status(500).json({ error: 'Failed to update your messages.' });
  }
});

router.post('/mine', requireStudent, withUpload, async (req, res) => {
  try {
    const inbox = studentInbox(req);
    if (!inbox) return res.status(400).json({ error: 'Unknown office.' });
    const student = await Student.findOne({ studentNumber: req.studentNumber }).select('name email').lean();
    const result = await createMessage(req, { studentNumber: req.studentNumber, inbox, from: 'student', authorEmail: student?.email, authorName: student?.name });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting) {
      const who = student?.name || req.studentNumber;
      const email = renderEmail({
        heading: `New message from ${who}`,
        intro: `${student?.name || 'A student'} (${req.studentNumber}) sent ${inbox === ADSO ? 'a message' : `the ${officeLabel(inbox)} a message`} on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      const subject = `AniSkolar: new message from ${who} (${req.studentNumber})`;
      if (inbox === ADSO) {
        if (process.env.ADSO_NOTIFY_EMAIL) alertByEmail(result.message, { to: process.env.ADSO_NOTIFY_EMAIL, subject, email });
      } else {
        officeAdminEmails(inbox)
          .then(to => to.length && alertByEmail(result.message, { to, subject, email }))
          .catch(err => console.error('Office admin emails lookup failed:', err));
      }
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send your message.' });
  }
});

// --- Office admins -------------------------------------------------------------

// An office's inbox state for a conversation (models/MessageThread.js).
// kind 'student' (key = student number, in the inbox of `inbox`) or
// 'office' (a duty office's, the AdSO's only).
// 'peer' (key = the other scholarship office's code, inbox = this office's).
const threadQuery = (kind, key, inbox = ADSO) => (kind === 'student' ? { studentNumber: key, ...inboxOf(inbox) }
  : kind === 'peer' ? { peer: pairKey(inbox, key) } : { office: key });
const stateKey = (kind, key, inbox = ADSO) => ({ kind, key: kind === 'student' ? studentKey(inbox, key) : kind === 'peer' ? `${inbox}>${key}` : key });
// The other side's messages in a conversation.
const incoming = (kind, key, inbox = ADSO) => (kind === 'peer' ? { ...threadQuery(kind, key, inbox), fromOffice: key } : { ...threadQuery(kind, key, inbox), from: kind });
const afterDeleted = st => (st?.clearedAt ? { createdAt: { $gt: st.clearedAt } } : {});
const stateView = st => ({ pinned: !!st?.pinnedAt, archived: !!st?.archivedAt, markedUnread: !!st?.markedUnread });

// Opening a conversation: the other side's messages are read, and a
// "mark as unread" is cleared.
async function markRead(kind, key, inbox = ADSO) {
  await Promise.all([
    Message.updateMany({ ...incoming(kind, key, inbox), readAt: null }, { $set: { readAt: new Date() } }),
    MessageThread.updateOne(stateKey(kind, key, inbox), { $set: { markedUnread: false } }),
  ]);
}

// body: { pinned?, archived?, unread? } (booleans). Returns { state } or { error }.
async function setState(kind, key, body = {}, inbox = ADSO) {
  const set = {};
  for (const [field, value] of Object.entries(body)) {
    if (!['pinned', 'archived', 'unread'].includes(field)) continue;
    if (typeof value !== 'boolean') return { error: `${field} must be true or false.` };
    if (field === 'pinned') set.pinnedAt = value ? new Date() : null;
    if (field === 'archived') set.archivedAt = value ? new Date() : null;
    if (field === 'unread') set.markedUnread = value;
  }
  if (!Object.keys(set).length) return { error: 'Nothing to change.' };
  if (set.markedUnread === false) await markRead(kind, key, inbox);
  const st = await MessageThread.findOneAndUpdate(stateKey(kind, key, inbox), { $set: set }, { upsert: true, returnDocument: 'after' }).lean();
  return { state: stateView(st) };
}

// Deletes the conversation from the AdSO's inbox only: its messages so far
// are hidden from the AdSO (the student or office keeps their copy, and
// attachments stay theirs). A new message starts it again.
async function deleteForAdso(kind, key, inbox = ADSO) {
  const now = new Date();
  await Message.updateMany({ ...incoming(kind, key, inbox), readAt: null }, { $set: { readAt: now } });
  await MessageThread.findOneAndUpdate(
    stateKey(kind, key, inbox),
    { $set: { clearedAt: now, pinnedAt: null, archivedAt: null, markedUnread: false } },
    { upsert: true }
  );
}

// An office's conversations with other scholarship offices, as thread rows.
async function peerGroups(me) {
  const prefix = `${me}>`;
  const states = (await MessageThread.find({ kind: 'peer', key: { $regex: `^${me}>` } }).lean())
    .map(t => ({ ...t, other: t.key.slice(prefix.length) }));
  const deleted = states.filter(t => t.clearedAt).map(t => ({ peer: pairKey(me, t.other), createdAt: { $lte: t.clearedAt } }));
  const groups = await Message.aggregate([
    { $match: { ...peerOf(me), ...(deleted.length ? { $nor: deleted } : {}) } },
    { $sort: { createdAt: -1 } },
    { $group: {
      _id: '$peer',
      last: { $first: '$$ROOT' },
      unread: { $sum: { $cond: [{ $and: [{ $ne: ['$fromOffice', me] }, { $eq: ['$readAt', null] }] }, 1, 0] } },
      count: { $sum: 1 },
      lastIncomingAt: { $max: { $cond: [{ $ne: ['$fromOffice', me] }, '$createdAt', null] } },
    } },
  ]);
  return groups.map(g => {
    const other = g._id.split('|').find(c => c !== me) ?? me;
    const st = states.find(t => t.other === other);
    return {
      kind: 'peer',
      peerOffice: other,
      name: officeLabel(other),
      email: '',
      unread: g.unread,
      count: g.count,
      last: peerView(g.last, me),
      pinned: !!st?.pinnedAt,
      archived: !!st?.archivedAt && !(g.lastIncomingAt && g.lastIncomingAt > st.archivedAt),
      markedUnread: !!st?.markedUnread,
    };
  });
}

router.get('/admin/threads', requireAdmin, async (req, res) => {
  try {
    const inbox = req.adminUser.office;
    const isAdso = inbox === ADSO;
    // This office's states, keyed by student number (or office name).
    const prefix = `${inbox}|`;
    const states = (await MessageThread.find(isAdso
      ? { kind: { $in: ['student', 'office'] }, key: { $not: /\|/ } }
      : { kind: 'student', key: { $regex: `^${inbox}\\|` } }).lean())
      .map(t => (isAdso ? t : { ...t, key: t.key.slice(prefix.length) }));
    const stateOf = (kind, key) => states.find(t => t.kind === kind && t.key === key);
    const group = (key, from) => {
      const kind = key === 'studentNumber' ? 'student' : 'office';
      // Messages the office deleted stay hidden.
      const deleted = states.filter(t => t.kind === kind && t.clearedAt).map(t => ({ [key]: t.key, createdAt: { $lte: t.clearedAt } }));
      return Message.aggregate([
        { $match: { [key]: { $nin: [null, ''] }, ...(kind === 'student' ? inboxOf(inbox) : {}), ...(deleted.length ? { $nor: deleted } : {}) } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: `$${key}`,
          last: { $first: '$$ROOT' },
          unread: { $sum: { $cond: [{ $and: [{ $eq: ['$from', from] }, { $eq: ['$readAt', null] }] }, 1, 0] } },
          count: { $sum: 1 },
          lastIncomingAt: { $max: { $cond: [{ $eq: ['$from', from] }, '$createdAt', null] } },
        } },
        { $sort: { 'last.createdAt': -1 } },
        { $limit: 500 },
      ]);
    };
    // The AdSO's inbox state; an archived conversation comes back to the
    // inbox when the other side writes again.
    const inboxState = (kind, t) => {
      const st = stateOf(kind, t._id);
      return {
        pinned: !!st?.pinnedAt,
        archived: !!st?.archivedAt && !(t.lastIncomingAt && t.lastIncomingAt > st.archivedAt),
        markedUnread: !!st?.markedUnread,
      };
    };
    // Duty offices write to the AdSO only.
    const [threads, officeThreads, offices, peerThreads] = await Promise.all([
      group('studentNumber', 'student'),
      isAdso ? group('office', 'office') : [],
      isAdso ? listOffices() : [],
      peerGroups(inbox),
    ]);
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
          ...inboxState('student', t),
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
        ...inboxState('office', t),
      }))).concat(peerThreads).sort((a, b) => (b.pinned - a.pinned) || (new Date(b.last.createdAt) - new Date(a.last.createdAt))),
    });
  } catch (err) {
    console.error('Load message threads error:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

router.get('/admin/unread', requireAdmin, async (req, res) => {
  try {
    const inbox = req.adminUser.office;
    const isAdso = inbox === ADSO;
    const [unread, marked, peerUnread, peerMarked] = await Promise.all([
      Message.countDocuments(isAdso
        ? { readAt: null, $or: [{ from: 'student', ...inboxOf(ADSO) }, { from: 'office' }] }
        : { readAt: null, from: 'student', inbox }),
      MessageThread.countDocuments({ markedUnread: true, ...(isAdso ? { kind: { $in: ['student', 'office'] }, key: { $not: /\|/ } } : { kind: 'student', key: { $regex: `^${inbox}\\|` } }) }),
      Message.countDocuments({ ...peerOf(inbox), fromOffice: { $ne: inbox }, readAt: null }),
      MessageThread.countDocuments({ kind: 'peer', markedUnread: true, key: { $regex: `^${inbox}>` } }),
    ]);
    res.json({ unread: unread + marked + peerUnread + peerMarked });
  } catch (err) {
    console.error('Unread messages (admin) error:', err);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

// Students to start a conversation with, by name or student number. The
// AdSO can write to anyone; another office to students who applied to it
// or are already in its inbox.
router.get('/admin/students', requireAdmin, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.json({ students: [] });
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = { $or: [{ studentNumber: { $regex: `^${safe}` } }, { name: { $regex: safe, $options: 'i' } }] };
    const inbox = req.adminUser.office;
    if (inbox !== ADSO) {
      const [applied, written] = await Promise.all([
        Application.distinct('studentNumber', { office: inbox }),
        Message.distinct('studentNumber', { inbox }),
      ]);
      filter.studentNumber = { $in: [...new Set([...applied, ...written])] };
    }
    const students = await Student.find(filter).select('studentNumber name programCode college yearLevel').limit(10).lean();
    res.json({ students: students.map(({ _id, ...st }) => st) });
  } catch (err) {
    console.error('Message student search error:', err);
    res.status(500).json({ error: 'Failed to search students.' });
  }
});

async function findStudent(studentNumber) {
  if (typeof studentNumber !== 'string' || !/^\d{9}$/.test(studentNumber)) return null;
  return Student.findOne({ studentNumber }).select('studentNumber name email programCode college yearLevel avatarUrl').lean();
}

router.get('/admin/threads/:studentNumber', requireAdmin, async (req, res) => {
  try {
    const inbox = req.adminUser.office;
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const st = await MessageThread.findOne(stateKey('student', student.studentNumber, inbox)).lean();
    const [messages, applications] = await Promise.all([
      Message.find({ studentNumber: student.studentNumber, ...inboxOf(inbox), ...afterDeleted(st) }).sort({ createdAt: 1 }).limit(1000).lean(),
      // Only the applications this office can see.
      Application.find({ studentNumber: student.studentNumber, ...officeFilter(req.adminUser) }).select('_id referenceCode scholarshipName status').sort({ createdAt: -1 }).lean(),
    ]);
    const { _id, ...info } = student;
    res.json({
      student: info,
      applications: applications.map(a => ({ _id: String(a._id), referenceCode: a.referenceCode, scholarshipName: a.scholarshipName, status: a.status })),
      messages: messages.map(view),
      state: stateView(st),
    });
  } catch (err) {
    console.error('Load message thread error:', err);
    res.status(500).json({ error: 'Failed to load the conversation.' });
  }
});

router.post('/admin/threads/:studentNumber', requireAdmin, withUpload, async (req, res) => {
  try {
    const inbox = req.adminUser.office;
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const result = await createMessage(req, {
      studentNumber: student.studentNumber, inbox, from: 'adso', authorEmail: req.adminUser.email, authorName: req.adminUser.name,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting) {
      const email = renderEmail({
        heading: 'You have a new message',
        intro: `The ${officeLabel(inbox)} sent you a message on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      alertByEmail(result.message, { to: student.email, subject: `AniSkolar: new message from the ${officeLabel(inbox)}`, email });
    }
    res.status(201).json({ message: view(result.message) });
  } catch (err) {
    console.error('Send message (admin) error:', err);
    res.status(500).json({ error: 'Failed to send the message.' });
  }
});

router.post('/admin/threads/:studentNumber/read', requireAdmin, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await markRead('student', student.studentNumber, req.adminUser.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark thread read error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.patch('/admin/threads/:studentNumber/state', requireAdmin, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const result = await setState('student', student.studentNumber, req.body, req.adminUser.office);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ state: result.state });
  } catch (err) {
    console.error('Update thread state error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.delete('/admin/threads/:studentNumber', requireAdmin, async (req, res) => {
  try {
    const student = await findStudent(req.params.studentNumber);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await deleteForAdso('student', student.studentNumber, req.adminUser.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete thread error:', err);
    res.status(500).json({ error: 'Failed to delete the conversation.' });
  }
});

// --- Other scholarship offices ---------------------------------------------------

// Another scholarship office to write to (by code), not this one; or null.
const findPeer = (req, code) => {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return OFFICE_CODES.includes(c) && c !== req.adminUser.office ? c : null;
};

// The offices with someone to answer (admin accounts in Clerk); every
// office if Clerk can't be asked.
router.get('/admin/peers', requireAdmin, async (req, res) => {
  try {
    const me = req.adminUser.office;
    let staffed = null;
    try {
      staffed = new Set((await Promise.all(OFFICES.map(async o => ((await officeAdminEmails(o.code)).length ? o.code : null)))).filter(Boolean));
    } catch (err) {
      console.error('Office admin lookup failed:', err);
    }
    res.json({ offices: OFFICES.filter(o => o.code !== me && (!staffed || staffed.has(o.code))).map(o => ({ code: o.code, name: o.name, short: o.short })) });
  } catch (err) {
    console.error('Load peer offices error:', err);
    res.status(500).json({ error: 'Failed to load the offices.' });
  }
});

router.get('/admin/peers/:code', requireAdmin, async (req, res) => {
  try {
    const me = req.adminUser.office;
    const other = findPeer(req, req.params.code);
    if (!other) return res.status(404).json({ error: 'Office not found.' });
    const st = await MessageThread.findOne(stateKey('peer', other, me)).lean();
    const messages = await Message.find({ peer: pairKey(me, other), ...afterDeleted(st) }).sort({ createdAt: 1 }).limit(1000).lean();
    res.json({ office: { code: other, name: officeLabel(other), short: officeShort(other) }, messages: messages.map(m => peerView(m, me)), state: stateView(st) });
  } catch (err) {
    console.error('Load peer thread error:', err);
    res.status(500).json({ error: 'Failed to load the conversation.' });
  }
});

router.post('/admin/peers/:code', requireAdmin, withUpload, async (req, res) => {
  try {
    const me = req.adminUser.office;
    const other = findPeer(req, req.params.code);
    if (!other) return res.status(404).json({ error: 'Office not found.' });
    const result = await createMessage(req, {
      peer: pairKey(me, other), fromOffice: me, from: 'adso', authorEmail: req.adminUser.email, authorName: req.adminUser.name,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (!result.alreadyWaiting) {
      const email = renderEmail({
        heading: `New message from the ${officeLabel(me)}`,
        intro: `${req.adminUser.name || req.adminUser.email} (${officeLabel(me)}) sent your office a message on AniSkolar:`,
        body: preview(result.message),
        button: { url: appUrl(), label: 'Reply in AniSkolar' },
      });
      const subject = `AniSkolar: new message from the ${officeLabel(me)}`;
      if (other === ADSO) {
        if (process.env.ADSO_NOTIFY_EMAIL) alertByEmail(result.message, { to: process.env.ADSO_NOTIFY_EMAIL, subject, email });
      } else {
        officeAdminEmails(other)
          .then(to => to.length && alertByEmail(result.message, { to, subject, email }))
          .catch(err => console.error('Office admin emails lookup failed:', err));
      }
    }
    res.status(201).json({ message: peerView(result.message, me) });
  } catch (err) {
    console.error('Send peer message error:', err);
    res.status(500).json({ error: 'Failed to send the message.' });
  }
});

router.post('/admin/peers/:code/read', requireAdmin, async (req, res) => {
  try {
    const other = findPeer(req, req.params.code);
    if (!other) return res.status(404).json({ error: 'Office not found.' });
    await markRead('peer', other, req.adminUser.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark peer thread read error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.patch('/admin/peers/:code/state', requireAdmin, async (req, res) => {
  try {
    const other = findPeer(req, req.params.code);
    if (!other) return res.status(404).json({ error: 'Office not found.' });
    const result = await setState('peer', other, req.body, req.adminUser.office);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ state: result.state });
  } catch (err) {
    console.error('Update peer thread state error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.delete('/admin/peers/:code', requireAdmin, async (req, res) => {
  try {
    const other = findPeer(req, req.params.code);
    if (!other) return res.status(404).json({ error: 'Office not found.' });
    await deleteForAdso('peer', other, req.adminUser.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete peer thread error:', err);
    res.status(500).json({ error: 'Failed to delete the conversation.' });
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
    const st = await MessageThread.findOne({ kind: 'office', key: office.office }).lean();
    const messages = await Message.find({ office: office.office, ...afterDeleted(st) }).sort({ createdAt: 1 }).limit(1000).lean();
    res.json({ office: { office: office.office, headName: office.headName ?? '', headEmail: office.headEmail ?? '' }, messages: messages.map(view), state: stateView(st) });
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
    await markRead('office', office.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark office thread read error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.patch('/admin/offices/:office/state', requireAdso, async (req, res) => {
  try {
    const office = await findOffice(req.params.office);
    if (!office) return res.status(404).json({ error: 'Office not found.' });
    const result = await setState('office', office.office, req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ state: result.state });
  } catch (err) {
    console.error('Update office thread state error:', err);
    res.status(500).json({ error: 'Failed to update the conversation.' });
  }
});

router.delete('/admin/offices/:office', requireAdso, async (req, res) => {
  try {
    const office = await findOffice(req.params.office);
    if (!office) return res.status(404).json({ error: 'Office not found.' });
    await deleteForAdso('office', office.office);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete office thread error:', err);
    res.status(500).json({ error: 'Failed to delete the conversation.' });
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
    // The conversation's student, or the office whose inbox it's in (the
    // AdSO also has the duty offices' conversations).
    const filter = { 'attachments.fileId': fileId };
    if (req.studentNumber) filter.studentNumber = req.studentNumber;
    else if (!req.adminUser?.office) return res.status(404).json({ error: 'File not found.' });
    else {
      // Its student conversations, (AdSO) the duty offices', or its
      // conversations with other scholarship offices.
      const o = req.adminUser.office;
      filter.$or = [
        { studentNumber: { $exists: true, $ne: null }, ...inboxOf(o) },
        ...(o === ADSO ? [{ office: { $exists: true, $ne: null } }] : []),
        peerOf(o),
      ];
    }
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

// Unsend (within 24 hours), by whoever wrote it.
//   POST /api/messages/mine/:id/unsend         a student's own message
//   POST /api/messages/admin/:id/unsend        an office admin's (its own office's)
//   POST /api/messages/office/mine/:id/unsend  a duty office head's
const sendUnsend = async (res, m) => {
  const result = await unsendMessage(m);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: view(result.message), emailSent: result.emailSent });
};

router.post('/mine/:id/unsend', requireStudent, async (req, res) => {
  try {
    const m = await findMessage(req, res);
    if (!m) return;
    if (m.studentNumber !== req.studentNumber || m.from !== 'student') return res.status(404).json({ error: 'Message not found.' });
    await sendUnsend(res, m);
  } catch (err) {
    console.error('Unsend message (student) error:', err);
    res.status(500).json({ error: 'Failed to unsend the message.' });
  }
});

router.post('/admin/:id/unsend', requireAdmin, async (req, res) => {
  try {
    const m = await findMessage(req, res);
    if (!m) return;
    const me = req.adminUser.office;
    const email = (req.adminUser.email || '').toLowerCase();
    const byMe = !m.authorEmail || m.authorEmail.toLowerCase() === email;
    const mine = m.from === 'adso' && byMe && (
      (m.studentNumber && (m.inbox || ADSO) === me)        // to a student
      || (m.peer && m.fromOffice === me)                   // to another office
      || (m.office && !m.peer && me === ADSO)              // the AdSO to a duty office
    );
    if (!mine) return res.status(404).json({ error: 'Message not found.' });
    await sendUnsend(res, m);
  } catch (err) {
    console.error('Unsend message (admin) error:', err);
    res.status(500).json({ error: 'Failed to unsend the message.' });
  }
});

router.post('/office/mine/:id/unsend', requireOfficeHead, async (req, res) => {
  try {
    const m = await findMessage(req, res);
    if (!m) return;
    if (m.from !== 'office' || norm(m.office) !== norm(req.officeHead.office)) return res.status(404).json({ error: 'Message not found.' });
    await sendUnsend(res, m);
  } catch (err) {
    console.error('Unsend message (office head) error:', err);
    res.status(500).json({ error: 'Failed to unsend the message.' });
  }
});

module.exports = router;
