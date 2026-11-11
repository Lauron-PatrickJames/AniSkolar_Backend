// Office announcements go through the AdSO first (npm test). Real route
// code through Express; Clerk and the database are stubs.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Announcement = require('../models/Announcement');
const ID = '64b7f0c2a1b2c3d4e5f60718';

const polcaAdmin = () => clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });

let saved;
beforeEach(() => {
  saved = undefined;
  users.adso = adsoAdmin();
  users.polca = polcaAdmin();
  Announcement.prototype.save = async function save() { saved = this; return this; };
  // The email sender looks for queued announcements: none here.
  Announcement.findOneAndUpdate = () => query(null);
});

const BODY = { title: 'Orientation', description: 'For new scholars', content: 'Orientation is on Friday.', createdBy: 'polca@dlsud.edu.ph' };

describe('posting', () => {
  const a = app(require('../routes/announcements'), '/api/announcements');

  test('an office’s "publish" waits for the AdSO', async () => {
    const res = await call(a, 'POST', '/api/announcements', { user: 'polca', body: { ...BODY, status: 'published' } });
    assert.equal(res.status, 201, res.body.error);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.review.requestedStatus, 'published');
    assert.equal(saved.publishedAt, null);
  });

  test('an office’s draft stays a draft', async () => {
    await call(a, 'POST', '/api/announcements', { user: 'polca', body: { ...BODY, status: 'draft' } });
    assert.equal(saved.status, 'draft');
  });

  test('the AdSO publishes directly', async () => {
    await call(a, 'POST', '/api/announcements', { user: 'adso', body: { ...BODY, status: 'published' } });
    assert.equal(saved.status, 'published');
  });

  test('no one can set "pending" themselves', async () => {
    const res = await call(a, 'POST', '/api/announcements', { user: 'adso', body: { ...BODY, status: 'pending' } });
    assert.equal(res.status, 400);
  });
});

describe('editing', () => {
  const a = app(require('../routes/announcements'), '/api/announcements');
  const doc = status => new Announcement({ _id: ID, ...BODY, office: 'POLCA', status, publishedAt: status === 'published' ? new Date() : null });

  test('an office editing a published announcement sends it back for approval', async () => {
    Announcement.findById = async () => doc('published');
    const res = await call(a, 'PATCH', `/api/announcements/${ID}`, { user: 'polca', body: { content: 'Orientation moved to Monday.' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.review.requestedStatus, 'published');
  });

  test('an office can take a pending one back to a draft', async () => {
    Announcement.findById = async () => { const d = doc('pending'); d.review = { requestedStatus: 'published', requestedAt: new Date() }; return d; };
    await call(a, 'PATCH', `/api/announcements/${ID}`, { user: 'polca', body: { status: 'draft' } });
    assert.equal(saved.status, 'draft');
    assert.equal(saved.review.requestedStatus, undefined);
  });
});

describe('the AdSO’s review', () => {
  const a = app(require('../routes/announcements'), '/api/announcements');
  const pending = (extra = {}) => {
    const d = new Announcement({ _id: ID, ...BODY, office: 'POLCA', status: 'pending', ...extra });
    d.review = { requestedStatus: extra.scheduledFor ? 'scheduled' : 'published', requestedAt: new Date(), requestedBy: 'polca@dlsud.edu.ph' };
    return d;
  };

  test('only the AdSO sees and decides', async () => {
    Announcement.findById = async () => pending();
    assert.equal((await call(a, 'POST', `/api/announcements/${ID}/approve`, { user: 'polca' })).status, 403);
    Announcement.find = () => query([]);
    assert.equal((await call(a, 'GET', '/api/announcements/review', { user: 'polca' })).status, 403);
  });

  test('approving publishes it and queues its email', async () => {
    Announcement.findById = async () => pending({ emailEnabled: true, emailTarget: { mode: 'scholars', scholarshipIds: ['s3'] } });
    const res = await call(a, 'POST', `/api/announcements/${ID}/approve`, { user: 'adso' });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(saved.status, 'published');
    assert.ok(saved.publishedAt);
    assert.equal(saved.emailStatus, 'queued');
    assert.equal(saved.review.decision, 'approved');
  });

  test('approving a scheduled one keeps its schedule', async () => {
    const later = new Date(Date.now() + 3 * 86400000);
    Announcement.findById = async () => pending({ scheduledFor: later });
    await call(a, 'POST', `/api/announcements/${ID}/approve`, { user: 'adso' });
    assert.equal(saved.status, 'scheduled');
  });

  test('returning needs a note, and makes it a draft', async () => {
    Announcement.findById = async () => pending();
    assert.equal((await call(a, 'POST', `/api/announcements/${ID}/return`, { user: 'adso', body: {} })).status, 400);
    const res = await call(a, 'POST', `/api/announcements/${ID}/return`, { user: 'adso', body: { note: 'Add the venue.' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(saved.status, 'draft');
    assert.equal(saved.review.note, 'Add the venue.');
  });

  test('a decided one can’t be decided again', async () => {
    Announcement.findById = async () => new Announcement({ _id: ID, ...BODY, office: 'POLCA', status: 'published' });
    assert.equal((await call(a, 'POST', `/api/announcements/${ID}/approve`, { user: 'adso' })).status, 409);
  });
});
