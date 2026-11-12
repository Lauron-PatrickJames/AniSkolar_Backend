// Per-office message inboxes (routes/messages.js): each office admin sees
// only its own inbox, and a student's message goes to the office they
// picked. Models are stubbed; the filters each route builds are checked.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Message = require('../models/Message');
const MessageThread = require('../models/MessageThread');
const Student = require('../models/Student');
const Application = require('../models/Application');

const messages = require('../routes/messages');
const a = app(messages, '/api/messages');

users.adso = adsoAdmin();
users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
users.stud = clerkUser('juan@dlsud.edu.ph');

let calls;
beforeEach(() => {
  calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); return query(name.endsWith('count') ? 0 : []); };
  Message.find = record('find');
  Message.countDocuments = record('count');
  Message.updateMany = record('updateMany');
  Message.aggregate = record('aggregate');
  Message.distinct = record('distinct');
  MessageThread.find = record('threads');
  MessageThread.countDocuments = record('threadcount');
  MessageThread.updateOne = record('threadUpdate');
  MessageThread.findOne = () => query(null);
  Application.distinct = () => query([]);
  Student.findOne = () => query({ studentNumber: '202400001', name: 'Juan', email: 'juan@dlsud.edu.ph' });
  Student.find = () => query([]);
});

describe('office admins', () => {
  test('POLCA counts only its own inbox', async () => {
    const res = await call(a, 'GET', '/api/messages/admin/unread', { user: 'polca' });
    assert.equal(res.status, 200);
    const [, filter] = calls.find(c => c[0] === 'count');
    assert.deepEqual(filter, { readAt: null, from: 'student', inbox: 'POLCA' });
  });

  test('the AdSO counts its inbox (and older messages without one) and the duty offices', async () => {
    await call(a, 'GET', '/api/messages/admin/unread', { user: 'adso' });
    const [, filter] = calls.find(c => c[0] === 'count');
    assert.deepEqual(filter.$or[0].inbox, { $in: [null, 'LSO'] });
    assert.deepEqual(filter.$or[1], { from: 'office' });
  });

  test('POLCA opens a conversation in its own inbox only', async () => {
    Application.find = () => query([]);
    const res = await call(a, 'GET', '/api/messages/admin/threads/202400001', { user: 'polca' });
    assert.equal(res.status, 200);
    const [, filter] = calls.find(c => c[0] === 'find');
    assert.equal(filter.inbox, 'POLCA');
  });

  test('duty-office conversations stay the AdSO\'s', async () => {
    const res = await call(a, 'GET', '/api/messages/admin/offices/Library', { user: 'polca' });
    assert.equal(res.status, 403);
  });
});

describe('office to office', () => {
  test('POLCA reads its conversation with the AdSO', async () => {
    const res = await call(a, 'GET', '/api/messages/admin/peers/lso', { user: 'polca' });
    assert.equal(res.status, 200, res.body.error);
    const [, filter] = calls.find(c => c[0] === 'find');
    assert.equal(filter.peer, 'LSO|POLCA');
  });

  test('an office can\'t open a conversation with itself', async () => {
    const res = await call(a, 'GET', '/api/messages/admin/peers/POLCA', { user: 'polca' });
    assert.equal(res.status, 404);
  });

  test('their messages are shown as the other office\'s', async () => {
    Message.find = () => query([{ _id: 'm1', peer: 'LSO|POLCA', fromOffice: 'LSO', from: 'adso', authorName: 'Ana', body: 'hi', attachments: [], createdAt: new Date() }]);
    const res = await call(a, 'GET', '/api/messages/admin/peers/LSO', { user: 'polca' });
    assert.equal(res.body.messages[0].from, 'office');
    assert.match(res.body.messages[0].authorName, /AdSO/);
  });
});

describe('students', () => {
  test('reading a conversation with POLCA', async () => {
    const res = await call(a, 'GET', '/api/messages/mine?office=polca', { user: 'stud' });
    assert.equal(res.status, 200, res.body.error);
    const [, filter] = calls.find(c => c[0] === 'find');
    assert.equal(filter.inbox, 'POLCA');
  });

  test('without an office it is the AdSO', async () => {
    await call(a, 'GET', '/api/messages/mine', { user: 'stud' });
    const [, filter] = calls.find(c => c[0] === 'find');
    assert.deepEqual(filter.inbox, { $in: [null, 'LSO'] });
  });

  test('an unknown office is refused', async () => {
    const res = await call(a, 'GET', '/api/messages/mine?office=NOPE', { user: 'stud' });
    assert.equal(res.status, 400);
  });
});
