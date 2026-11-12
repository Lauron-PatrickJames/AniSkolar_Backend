// Unsending a message (npm test): only its writer, only within 24 hours;
// its text and files go, and a waiting email alert is cancelled.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const Message = require('../models/Message');
const OutboxEmail = require('../models/OutboxEmail');
const gridfs = require('../utils/gridfs');

const a = app(require('../routes/messages'), '/api/messages');
const ID = '64b7f0c2a1b2c3d4e5f60718';
const minutesAgo = n => new Date(Date.now() - n * 60_000);

let message; let update; let cancelled; let sent; let filesDeleted;
beforeEach(() => {
  update = null; cancelled = null; sent = false; filesDeleted = [];
  users.s1 = clerkUser('student@dlsud.edu.ph');
  users.adso = adsoAdmin();
  Student.findOne = () => query({ studentNumber: '202312345' });
  Message.findById = () => query(message);
  Message.updateOne = async (q, u) => { update = u; };
  OutboxEmail.deleteMany = async q => { cancelled = q; };
  OutboxEmail.exists = async () => sent;
  gridfs.deleteFile = async id => { filesDeleted.push(String(id)); };
});

const studentMessage = extra => ({ _id: ID, studentNumber: '202312345', from: 'student', body: 'Wrong file po', attachments: [{ fileId: 'f1', filename: 'cor.jpg' }], createdAt: minutesAgo(5), readAt: null, ...extra });

describe('a student unsending their message', () => {
  test('removes the text and files, and cancels the waiting email', async () => {
    message = studentMessage();
    const res = await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' });
    assert.equal(res.status, 200, res.body.error);
    assert.ok(res.body.message.unsentAt);
    assert.equal(res.body.message.body, '');
    assert.deepEqual(res.body.message.attachments, []);
    assert.equal(res.body.emailSent, false);
    assert.equal(update.$set.body, '');
    assert.ok(update.$set.readAt, 'it no longer counts as unread');
    assert.match(cancelled.key.$regex, new RegExp(ID));
    assert.equal(cancelled.status, 'queued');
  });

  test('says when the email alert already went out', async () => {
    message = studentMessage();
    sent = true;
    const res = await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' });
    assert.equal(res.body.emailSent, true);
  });

  test('not after 24 hours', async () => {
    message = studentMessage({ createdAt: minutesAgo(24 * 60 + 1) });
    const res = await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' });
    assert.equal(res.status, 409);
    assert.equal(update, null);
  });

  test('not someone else’s message', async () => {
    message = studentMessage({ from: 'adso' });
    assert.equal((await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' })).status, 404);
    message = studentMessage({ studentNumber: '202399999' });
    assert.equal((await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' })).status, 404);
  });

  test('not twice', async () => {
    message = studentMessage({ unsentAt: minutesAgo(1) });
    assert.equal((await call(a, 'POST', `/api/messages/mine/${ID}/unsend`, { user: 's1' })).status, 409);
  });
});

describe('an office unsending its message', () => {
  test('the AdSO can unsend its own message to a student', async () => {
    message = studentMessage({ from: 'adso', authorEmail: 'adso@dlsud.edu.ph', inbox: undefined });
    assert.equal((await call(a, 'POST', `/api/messages/admin/${ID}/unsend`, { user: 'adso' })).status, 200);
  });

  test('another office can’t unsend the AdSO’s message', async () => {
    users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
    message = studentMessage({ from: 'adso', authorEmail: 'adso@dlsud.edu.ph' });
    assert.equal((await call(a, 'POST', `/api/messages/admin/${ID}/unsend`, { user: 'polca' })).status, 404);
  });

  test('the student’s own message can’t be unsent by the office', async () => {
    message = studentMessage();
    assert.equal((await call(a, 'POST', `/api/messages/admin/${ID}/unsend`, { user: 'adso' })).status, 404);
  });
});
