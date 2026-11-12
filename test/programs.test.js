// Scholarships open only to some programs (npm test). The CBAASG's
// scholarships are for CBAA students by default; the office's saved rules
// replace that list.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const ScholarshipSetting = require('../models/ScholarshipSetting');

describe('POST /api/applications: program-limited scholarships', () => {
  const applications = require('../routes/applications');
  const a = app(applications, '/api/applications');
  let program;
  let setting;

  beforeEach(() => {
    users.s1 = clerkUser('student@dlsud.edu.ph');
    program = 'BSIT';
    setting = { status: 'Open' };                               // opened, rules untouched
    Student.findOne = () => query({ studentNumber: '202312345', programCode: program });
    ScholarshipSetting.findOne = () => query(setting);
  });

  const apply = id => call(a, 'POST', '/api/applications', { user: 's1', body: { scholarshipId: id } });

  for (const id of ['s13', 's14']) {
    test(`${id}: a non-CBAA student is refused`, async () => {
      const res = await apply(id);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /certain programs/);
    });

    test(`${id}: a CBAA student gets past the check`, async () => {
      program = 'BSA';
      const res = await apply(id);
      assert.notEqual(res.status, 403, res.body.error);         // fails later only on the (empty) form
    });
  }

  test('the office\'s saved rules replace the built-in list', async () => {
    setting = { status: 'Open', rules: { applicantType: 'continuing' } };   // "All programs"
    const res = await apply('s13');
    assert.notEqual(res.status, 403, res.body.error);
  });

  test('scholarships without a list are open to every program', async () => {
    setting = { status: 'Open' };
    const res = await apply('s11');
    assert.notEqual(res.status, 403, res.body.error);
  });
});
