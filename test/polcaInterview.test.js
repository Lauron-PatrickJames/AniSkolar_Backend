// POLCA interviews (npm test): every applicant is interviewed before
// approval. The office records the schedule and result; the student sees
// only the schedule; approving needs a passed interview.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const Student = require('../models/Student');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const { parseAssessment, studentInterview, requiresInterview } = require('../data/officeForms');

const ID = '64b7f0c2a1b2c3d4e5f60718';

describe('the interview record', () => {
  test('only POLCA requires an interview', () => {
    assert.equal(requiresInterview('s3'), true);
    for (const id of ['s1', 's2', 's4', 's15', 's16']) assert.equal(requiresInterview(id), false, id);
  });

  test('a full schedule and result are accepted', () => {
    const res = parseAssessment('s3', { interviewDate: '2026-11-20', interviewTime: '14:30', interviewVenue: 'POLCA Office, ICTC Bldg.', interviewResult: 'passed' });
    assert.equal(res.error, undefined);
    assert.equal(res.value.interviewResult, 'passed');
  });

  test('the result is passed or failed only', () => {
    assert.ok(parseAssessment('s3', { interviewResult: 'maybe' }).error);
  });

  test('the place or meeting link is at most 500 characters', () => {
    assert.equal(parseAssessment('s3', { interviewVenue: `https://teams.microsoft.com/l/meetup-join/${'x'.repeat(400)}` }).error, undefined);
    assert.ok(parseAssessment('s3', { interviewVenue: 'x'.repeat(501) }).error);
  });

  test('the student sees the schedule, never the result', () => {
    const seen = studentInterview('s3', { interviewMode: 'onsite', interviewDate: '2026-11-20', interviewTime: '14:30', interviewVenue: 'POLCA Office', interviewResult: 'failed', updatedBy: 'polca@dlsud.edu.ph' });
    assert.deepEqual(seen, { mode: 'onsite', date: '2026-11-20', time: '14:30', venue: 'POLCA Office' });
  });

  test('the format is onsite or online only', () => {
    assert.equal(parseAssessment('s3', { interviewMode: 'online' }).error, undefined);
    assert.ok(parseAssessment('s3', { interviewMode: 'hybrid' }).error);
  });

  test('nothing is shown before a date is set, or for other scholarships', () => {
    assert.equal(studentInterview('s3', { interviewVenue: 'POLCA Office' }), undefined);
    assert.equal(studentInterview('s15', { interviewDate: '2026-11-20' }), undefined);
  });
});

describe('approving a POLCA applicant', () => {
  const a = app(require('../routes/applications'), '/api/applications');
  const application = assessment => ({
    _id: ID, status: 'Under Evaluation', office: 'POLCA', scholarshipId: 's3', scholarshipName: 'POLCA Scholarship (PSEF)',
    studentNumber: '202300001', history: [], officeAssessment: assessment,
    markModified() {}, async save() {},
  });
  beforeEach(() => {
    users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
    ScholarshipSetting.findOne = () => query(null);
    Student.findOne = () => query(null);              // no college on file: no slot limit
    Student.find = () => query([]);
    Application.find = () => query([]);
  });
  const approve = () => call(a, 'PATCH', `/api/applications/${ID}/status`, { user: 'polca', body: { status: 'Approved', acknowledgeOtherScholarship: true } });

  test('is refused before the interview', async () => {
    Application.findOne = () => query(application(undefined));
    const res = await approve();
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'interview_required');
  });

  test('is refused while the interview is only scheduled', async () => {
    Application.findOne = () => query(application({ interviewDate: '2026-11-20', interviewTime: '14:30' }));
    const res = await approve();
    assert.equal(res.body.code, 'interview_required');
  });

  test('is refused after a failed interview', async () => {
    Application.findOne = () => query(application({ interviewDate: '2026-11-20', interviewResult: 'failed' }));
    const res = await approve();
    assert.equal(res.body.code, 'interview_required');
    assert.match(res.body.error, /didn’t pass/);
  });

  test('goes ahead after a passed interview', async () => {
    Application.findOne = () => query(application({ interviewDate: '2026-11-20', interviewResult: 'passed' }));
    const res = await approve();
    assert.notEqual(res.body.code, 'interview_required');
  });

  test('rejecting needs no interview', async () => {
    Application.findOne = () => query(application(undefined));
    const res = await call(a, 'PATCH', `/api/applications/${ID}/status`, { user: 'polca', body: { status: 'Rejected', reviewNote: 'Incomplete documents.' } });
    assert.notEqual(res.body.code, 'interview_required');
  });
});
