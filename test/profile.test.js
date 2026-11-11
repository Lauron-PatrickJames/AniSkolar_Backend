// Onboarding, partial profile updates and profile completion (npm test).
// Real route code through Express; Clerk and the database are stubs.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');
const { computeProfileCompletion } = require('../utils/profileCompletion');

const CORE = { studentNumber: '202312345', programCode: 'BSIT', yearLevel: '2nd Year', gpa: 3.25 };
const PERSONAL = { firstName: 'Juan Miguel', lastName: 'Dela Cruz', middleName: 'Santos', dateOfBirth: new Date('2005-03-01'), placeOfBirth: 'Dasmariñas', nationality: 'Filipino', civilStatus: 'Single' };
const CONTACT = { homeAddress: '12 Rizal St.', province: 'Cavite', cityMunicipality: 'Dasmariñas City', zipCode: '4114', mobileNumber: '09171234567' };

describe('profile completion', () => {
  const section = (c, key) => c.sections.find(s => s.key === key);

  test('a new student with just the core', () => {
    const c = computeProfileCompletion(CORE);
    assert.equal(c.coreComplete, true);
    assert.equal(c.complete, false);
    assert.ok(c.percent > 0 && c.percent < 100);
    assert.deepEqual(section(c, 'academic').missing, ['section']);
    assert.equal(section(c, 'personal').complete, false);
  });

  test('the core needs program, year level and GPA', () => {
    assert.equal(computeProfileCompletion({ studentNumber: '202312345', programCode: 'BSIT', yearLevel: '2nd Year' }).coreComplete, false);
    // 1st years have no GPA yet.
    assert.equal(computeProfileCompletion({ studentNumber: '202312345', programCode: 'BSIT', yearLevel: '1st Year' }).coreComplete, true);
  });

  test('telephone and suffix never count; a guardian only without two living parents', () => {
    const family = { fatherName: 'Jose Dela Cruz', fatherContactNo: '09170000001', motherName: 'Maria Dela Cruz', motherContactNo: '09170000002' };
    const full = computeProfileCompletion({ ...CORE, section: 'BIT21', ...PERSONAL, ...CONTACT, ...family });
    assert.equal(full.complete, true);
    assert.equal(full.percent, 100);
    const fatherDeceased = computeProfileCompletion({ ...CORE, section: 'BIT21', ...PERSONAL, ...CONTACT, ...family, fatherDeceased: true, fatherContactNo: undefined });
    assert.deepEqual(section(fatherDeceased, 'family').missing, ['guardianType']);
  });
});

describe('onboarding (POST /api/students/complete-profile)', () => {
  const a = app(require('../routes/students'), '/api/students');
  let saved;
  beforeEach(() => {
    saved = undefined;
    users.n1 = clerkUser('newstudent@dlsud.edu.ph');
    Student.findOne = () => query(null);
    Student.findOneAndUpdate = () => query(null);
    ApplicationDraft.updateMany = () => query(null);
    Application.find = () => query([]);
    Student.prototype.save = async function save() { saved = this; return this; };
  });

  test('saves with only the core, and reports what’s left', async () => {
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'n1', body: { studentNumber: '202312345', programCode: 'BSIT', yearLevel: '2nd Year', gpa: '3.25' } });
    assert.equal(res.status, 201, res.body.error);
    assert.equal(saved.studentNumber, '202312345');
    assert.equal(res.body.student.completion.coreComplete, true);
    assert.equal(res.body.student.completion.complete, false);
    assert.equal(saved.identityConfirmedAt, undefined, 'identity not confirmed yet');
  });

  test('refuses without the year level', async () => {
    const res = await call(a, 'POST', '/api/students/complete-profile', { user: 'n1', body: { studentNumber: '202312345', programCode: 'BSIT', gpa: '3.25' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /year level/);
  });
});

describe('PATCH /api/students/me', () => {
  const a = app(require('../routes/students'), '/api/students');
  let doc;
  const student = extra => {
    const s = new Student({ clerkId: 'u1', email: 'juan@dlsud.edu.ph', name: 'Juan Dela Cruz', firstName: 'Juan', lastName: 'Miguel Dela Cruz', ...CORE, ...extra });
    s.save = async function save() { return this; };
    return s;
  };
  beforeEach(() => {
    users.u1 = clerkUser('juan@dlsud.edu.ph');
    Student.findOne = () => query(doc);
  });

  test('one section at a time: contact only', async () => {
    doc = student();
    const res = await call(a, 'PATCH', '/api/students/me', { user: 'u1', body: { homeAddress: '12 Rizal St.', mobileNumber: '0917 123 4567' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(doc.homeAddress, '12 Rizal St.');
    assert.equal(doc.mobileNumber, '09171234567');
    assert.ok(res.body.student.completion);
  });

  test('a new student can correct a name the directory split wrongly', async () => {
    doc = student();
    const res = await call(a, 'PATCH', '/api/students/me', { user: 'u1', body: { firstName: 'Juan Miguel', lastName: 'Dela Cruz' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(doc.name, 'Juan Miguel Dela Cruz');
  });

  test('a complete Personal section confirms identity, which then locks', async () => {
    doc = student();
    const body = { ...PERSONAL, dateOfBirth: '2005-03-01' };
    const first = await call(a, 'PATCH', '/api/students/me', { user: 'u1', body });
    assert.equal(first.status, 200, first.body.error);
    assert.ok(doc.identityConfirmedAt, 'confirmed');
    const again = await call(a, 'PATCH', '/api/students/me', { user: 'u1', body: { lastName: 'Cruz' } });
    assert.equal(again.status, 409);
  });
});
