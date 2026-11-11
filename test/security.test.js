// Security regression tests (npm test). They run the real route code
// through Express, with Clerk and the database replaced by stubs, so no
// MongoDB or Clerk account is needed and nothing real is touched.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');

// --- Finding 1: claiming a student number an office already added ----------
describe('complete-profile: a student number with office-added records', () => {
  const students = require('../routes/students');
  const a = app(students, '/api/students');
  const OFFICE_ADDED = [{ standardInfo: { email: 'player@dlsud.edu.ph' } }];

  beforeEach(() => {
    Student.findOne = () => query(null);                       // no profile yet, number unclaimed
    Student.findOneAndUpdate = () => query(null);              // nothing to re-link
    ApplicationDraft.updateMany = () => query(null);
    Application.find = () => query(OFFICE_ADDED);
  });

  test('someone else who knows the number is refused', async () => {
    users.u1 = clerkUser('classmate@dlsud.edu.ph');
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'u1', body: { studentNumber: '202312345' } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /different DLSU-D email/);
  });

  test('the person the office added gets past the check', async () => {
    users.u2 = clerkUser('Player@dlsud.edu.ph');
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'u2', body: { studentNumber: '202312345' } });
    assert.notEqual(res.status, 409, res.body.error);           // fails later only on the (empty) form fields
  });

  test('a number with no records is unaffected', async () => {
    Application.find = () => query([]);
    users.u3 = clerkUser('newstudent@dlsud.edu.ph');
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'u3', body: { studentNumber: '202312345' } });
    assert.notEqual(res.status, 409, res.body.error);
  });

  test('an unverified email is refused', async () => {
    users.u4 = clerkUser('player@dlsud.edu.ph', { verified: false });
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'u4', body: { studentNumber: '202312345' } });
    assert.equal(res.status, 403);
  });
});

// --- Finding 2: resubmitting an application that doesn't need revision -----
describe('PATCH /api/applications/:id: resubmitting', () => {
  const applications = require('../routes/applications');
  const a = app(applications, '/api/applications');
  const ID = '64b7f0c2a1b2c3d4e5f60718';
  let saved;
  const existing = status => ({
    _id: ID, status, studentNumber: '202300001', scholarshipId: 's2', applicationFormType: 'standard',
    documents: [], history: [], markModified() {}, toObject() { return { ...this }; },
    async save() { saved = this.status; },
  });

  beforeEach(() => {
    saved = undefined;
    users.s1 = clerkUser('student@dlsud.edu.ph');
    Student.findOne = () => query({ studentNumber: '202300001' });
  });

  for (const status of ['Rejected', 'Approved', 'Under Evaluation']) {
    test(`a ${status} application can't be resubmitted`, async () => {
      Application.findOne = () => query(existing(status));
      const res = await call(a, 'PATCH', `/api/applications/${ID}`, { user: 's1', body: { documentLabels: '[]' } });
      assert.equal(res.status, 409);
      assert.equal(saved, undefined, 'nothing is saved');
    });
  }

  test('a Needs Revision application can be resubmitted', async () => {
    Application.findOne = () => query(existing('Needs Revision'));
    const res = await call(a, 'PATCH', `/api/applications/${ID}`, { user: 's1', body: { documentLabels: '[]' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(saved, 'Under Evaluation');
  });
});
