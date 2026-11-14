// The Director's batch approval (npm test): approves the AdSO applications
// the Head recommended for approval, skipping any that can't be approved.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const Student = require('../models/Student');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const a = app(require('../routes/applications'), '/api/applications');

const ID1 = '64b7f0c2a1b2c3d4e5f60711';
const ID2 = '64b7f0c2a1b2c3d4e5f60712';
const ID3 = '64b7f0c2a1b2c3d4e5f60713';
const recommended = [{ action: 'endorse' }, { action: 'recommendApproval', note: 'Complete.' }];
let saved;
const doc = (id, extra) => ({
  _id: id, status: 'Under Evaluation', office: 'LSO', scholarshipId: 's2', scholarshipName: 'Entrance Scholarship',
  studentNumber: '202300001', history: [], approvalStage: 'director', approvalSteps: [...recommended],
  markModified() {}, async save() { saved.push(this); }, ...extra,
});
let docs;

beforeEach(() => {
  saved = [];
  users.director = clerkUser('director@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO', adsoRole: 'director' } });
  users.head = clerkUser('head@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO', adsoRole: 'head' } });
  users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
  docs = {};
  Application.findOne = filter => query(docs[String(filter._id)] ?? null);
  Application.find = () => query([]);
  Renewal.find = () => query([]);
  Student.findOne = () => query(null);
  Student.find = () => query([]);
  ScholarshipSetting.findOne = () => query(null);
});

const batch = (user, ids) => call(a, 'POST', '/api/applications/batch-approve', { user, body: { ids } });

test('approves the recommended ones and skips the rest, with reasons', async () => {
  docs[ID1] = doc(ID1);
  docs[ID2] = doc(ID2, { approvalStage: 'head', approvalSteps: [{ action: 'endorse' }] });
  docs[ID3] = doc(ID3, { approvalSteps: [{ action: 'endorse' }, { action: 'recommendRejection', note: 'Incomplete.' }] });
  const res = await batch('director', [ID1, ID2, ID3]);
  assert.equal(res.status, 200, res.body.error);
  assert.deepEqual(res.body.approved, [ID1]);
  assert.match(res.body.skipped.find(s => s.id === ID2).reason, /not with the Director yet/);
  assert.match(res.body.skipped.find(s => s.id === ID3).reason, /didn’t recommend approval/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'Approved');
  assert.equal(saved[0].approvalSteps.at(-1).action, 'approve');
  assert.equal(saved[0].history.at(-1).status, 'Approved');
});

test('an SFAG application takes the percentage the student applied for', async () => {
  docs[ID1] = doc(ID1, { scholarshipId: 's1', scholarshipName: 'SFAG', sfagPercentageRequested: 75 });
  docs[ID2] = doc(ID2, { scholarshipId: 's1', scholarshipName: 'SFAG' });
  const res = await batch('director', [ID1, ID2]);
  assert.deepEqual(res.body.approved, [ID1]);
  assert.equal(saved[0].sfagPercentage, 75);
  assert.match(res.body.skipped[0].reason, /no grant percentage/);
});

test('only the Director, and only the AdSO', async () => {
  docs[ID1] = doc(ID1);
  assert.equal((await batch('head', [ID1])).status, 403);
  assert.equal((await batch('polca', [ID1])).status, 403);
  assert.equal(saved.length, 0);
});
