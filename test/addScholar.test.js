// Adding a scholar by hand (npm test): POST /api/applications/direct-award
// for scholarships students apply for, e.g. someone POLCA awarded on a
// paper application. A note on why is required; the document is optional.
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

test('an office adds a scholar to its own scholarship with a note', async () => {
  const res = await add('polca', { scholarshipId: 's3', note: 'Approved on a paper application.' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'Approved');
  assert.equal(created[0].awardedDirectly, true);
  assert.equal(created[0].office, 'POLCA');
  assert.deepEqual(created[0].documents, []);
  assert.equal(created[0].officeAssessment, undefined);
});

test('a note on why is required', async () => {
  const res = await add('polca', { scholarshipId: 's3', note: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /why/);
  assert.equal(created.length, 0);
});

test('not another office’s scholarship', async () => {
  const res = await add('polca', { scholarshipId: 's1', note: 'Approved on paper.' });
  assert.equal(res.status, 403);
});

test('the SFAG needs the grant percentage', async () => {
  const missing = await add('adso', { scholarshipId: 's1', note: 'Approved on paper.' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /percentage/);
  const res = await add('adso', { scholarshipId: 's1', note: 'Approved on paper.', sfagPercentage: '75' });
  assert.equal(res.status, 201, res.body.error);
  assert.equal(created[0].sfagPercentage, 75);
});

test('scholarships with the office’s own form still need it (SDO)', async () => {
  users.sdo = clerkUser('sdo@dlsud.edu.ph', { metadata: { role: 'admin', office: 'SDO' } });
  const res = await add('sdo', { scholarshipId: 's7', note: 'Varsity.' });
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});
