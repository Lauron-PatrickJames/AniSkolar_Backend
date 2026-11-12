// The Trash (npm test): deleting moves things there, restoring puts them
// back, and deleting for good removes their files. The database is faked.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { query } = require('./helpers');

const TrashItem = require('../models/TrashItem');
const Announcement = require('../models/Announcement');
const ReplyTemplate = require('../models/ReplyTemplate');
const gridfs = require('../utils/gridfs');
const { moveToTrash, restore, purge } = require('../utils/trash');

let created; let removed; let inserted; let updated; let filesDeleted;
beforeEach(() => {
  created = []; removed = []; inserted = []; updated = []; filesDeleted = [];
  TrashItem.create = async doc => { created.push(doc); return { ...doc, _id: 't1' }; };
  TrashItem.deleteOne = async q => { removed.push(['trash', q]); };
  Announcement.deleteOne = async q => { removed.push(['announcement', q]); };
  Announcement.collection.insertOne = async doc => { inserted.push(doc); };
  ReplyTemplate.updateOne = async (q, u) => { updated.push([q, u]); };
  gridfs.deleteFile = async id => { filesDeleted.push(id); };
});

const announcement = extra => ({ _id: 'a1', title: 'Renewal is open', status: 'published', images: [{ fileId: 'f1' }], ...extra });

describe('moving to the Trash', () => {
  test('keeps a full copy for 30 days and removes the original', async () => {
    await moveToTrash({ kind: 'announcement', doc: announcement(), title: 'Renewal is open', office: 'LSO', files: ['f1'], by: { email: 'adso@dlsud.edu.ph', name: 'AdSO' } });
    assert.equal(created.length, 1);
    assert.equal(created[0].data.title, 'Renewal is open');
    assert.deepEqual(created[0].files, ['f1']);
    const days = (created[0].purgeAt - created[0].deletedAt) / 86400000;
    assert.equal(days, 30);
    assert.deepEqual(removed, [['announcement', { _id: 'a1' }]]);
    assert.equal(filesDeleted.length, 0, 'files stay until it is deleted for good');
  });

  test('a message template stays as a hidden record', async () => {
    await moveToTrash({ kind: 'replyTemplate', doc: { _id: 'r1', title: 'Missing document', office: 'POLCA' }, title: 'Template', office: 'POLCA' });
    assert.equal(removed.length, 0);
    assert.ok(updated[0][1].$set.deletedAt instanceof Date);
  });
});

describe('restoring', () => {
  test('puts it back as it was, with the same id', async () => {
    await restore({ _id: 't1', kind: 'announcement', data: announcement() });
    assert.equal(inserted[0]._id, 'a1');
    assert.equal(inserted[0].status, 'published');
    assert.deepEqual(removed, [['trash', { _id: 't1' }]]);
  });

  test('a scheduled announcement whose time passed comes back as a draft', async () => {
    await restore({ _id: 't1', kind: 'announcement', data: announcement({ status: 'scheduled', scheduledFor: new Date('2020-01-01') }) });
    assert.equal(inserted[0].status, 'draft');
    assert.equal(inserted[0].scheduledFor, null);
  });

  test('a message template is un-hidden', async () => {
    await restore({ _id: 't1', kind: 'replyTemplate', data: { _id: 'r1' } });
    assert.deepEqual(updated[0], [{ _id: 'r1' }, { $set: { deletedAt: null } }]);
  });

  test('an attendance sheet needs its event', async () => {
    const DutyEvent = require('../models/DutyEvent');
    DutyEvent.findById = async () => null;
    const res = await restore({ _id: 't1', kind: 'attendanceSheet', data: { fileId: 'f9' }, extra: { eventId: 'e1' } });
    assert.match(res.error, /Restore the event first/);
  });
});

describe('deleting for good', () => {
  test('removes its files and the Trash item', async () => {
    await purge({ _id: 't1', kind: 'dutyEvent', data: { _id: 'e1' }, files: ['s1', 's2'] });
    assert.deepEqual(filesDeleted, ['s1', 's2']);
    assert.deepEqual(removed, [['trash', { _id: 't1' }]]);
  });
});

// The Trash list is scoped: an office sees only its own items.
describe('GET /api/trash', () => {
  const { users, clerkUser, adsoAdmin, app, call } = require('./helpers');
  const a = app(require('../routes/trash'), '/api/trash');
  let filter;
  beforeEach(() => { TrashItem.find = f => { filter = f; return query([]); }; });

  test('the AdSO sees every office\'s', async () => {
    users.adso = adsoAdmin();
    await call(a, 'GET', '/api/trash', { user: 'adso' });
    assert.deepEqual(filter, {});
  });

  test('a partner office sees only its own', async () => {
    users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
    await call(a, 'GET', '/api/trash', { user: 'polca' });
    assert.deepEqual(filter, { office: 'POLCA' });
  });
});
