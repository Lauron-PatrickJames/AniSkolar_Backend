// Adding a scholar by hand (npm test): POST /api/applications/direct-award.
// Only the AdSO's Scholarship Associate, Head and Director, the SDO and the
// ROTC Office can. For scholarships students apply for (someone awarded on
// a paper application) a note on why is required; the document is optional.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const Student = require('../models/Student');
const Counter = require('../models/Counter');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const OutboxEmail = require('../models/OutboxEmail');
const a = app(require('../routes/applications'), '/api/applications');

let created;
beforeEach(() => {
  created = [];
  users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
  users.associate = clerkUser('adsoassociate@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO', adsoRole: 'associate' } });
  users.head = clerkUser('adsohead@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO', adsoRole: 'head' } });
  users.director = clerkUser('adsodirector@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO', adsoRole: 'director' } });
  users.adso = adsoAdmin();
  Student.findOne = () => query({ studentNumber: '202312345', firstName: 'Juan', lastName: 'Dela Cruz', name: 'JUAN DELA CRUZ', email: 'jdc@dlsud.edu.ph', programCode: 'BSIT' });
  Application.find = () => query([]);
  Renewal.find = () => query([]);
  ScholarshipSetting.findOne = () => query(null);
  Counter.findOneAndUpdate = async () => ({ seq: 7 });
  Application.create = async doc => { created.push(doc); return { _id: 'x', ...doc, markModified() {}, async save() {} }; };
  OutboxEmail.insertMany = async () => [];
  OutboxEmail.bulkWrite = async () => ({});
  OutboxEmail.find = () => query([]);
});

const add = (user, body) => call(a, 'POST', '/api/applications/direct-award', {
  user, body: { studentNumber: '202312345', directorApproved: 'true', ...body },
});

test('the Scholarship Associate adds a scholar with a note', async () => {
  const res = await add('associate', { scholarshipId: 's2', note: 'Approved on a paper application.' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'Approved');
  assert.equal(created[0].awardedDirectly, true);
  assert.equal(created[0].office, 'LSO');
  assert.deepEqual(created[0].documents, []);
  assert.equal(created[0].officeAssessment, undefined);
});

test('the Head and the Director can too', async () => {
  for (const user of ['head', 'director']) {
    const res = await add(user, { scholarshipId: 's2', note: 'Approved on a paper application.' });
    assert.equal(res.status, 201, `${user}: ${res.body.error}`);
  }
});

test('no other office, and no AdSO account without a role', async () => {
  for (const [user, scholarshipId] of [['polca', 's3'], ['adso', 's2']]) {
    const res = await add(user, { scholarshipId, note: 'Approved on a paper application.' });
    assert.equal(res.status, 403, user);
    assert.match(res.body.error, /Scholarship Associate, Head and Director/);
    const search = await call(a, 'GET', '/api/applications/direct-award/students?q=juan', { user });
    assert.equal(search.status, 403, `${user} search`);
  }
  assert.equal(created.length, 0);
});

test('a note on why is required', async () => {
  const res = await add('associate', { scholarshipId: 's2', note: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /why/);
  assert.equal(created.length, 0);
});

test('only the office’s own scholarships', async () => {
  const res = await add('associate', { scholarshipId: 's3', note: 'Approved on paper.' });
  assert.equal(res.status, 403);
});

test('the SFAG needs the grant percentage', async () => {
  const missing = await add('head', { scholarshipId: 's1', note: 'Approved on paper.' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /percentage/);
  const res = await add('head', { scholarshipId: 's1', note: 'Approved on paper.', sfagPercentage: '75' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(created[0].sfagPercentage, 75);
});

test('scholarships with the office’s own form still need it (SDO)', async () => {
  users.sdo = clerkUser('sdo@dlsud.edu.ph', { metadata: { role: 'admin', office: 'SDO' } });
  const res = await add('sdo', { scholarshipId: 's7', note: 'Varsity.' });
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});
