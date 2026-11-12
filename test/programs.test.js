// Scholarships open only to some programs (npm test). The college student
// governments' scholarships are for their own college's students by
// default; the office's saved rules replace that list.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const Application = require('../models/Application');

// scholarship -> [a program in its college, a program outside it]
const LIMITED = {
  s13: ['BSA', 'BSIT'],      // CBAASG Achie: CBAA
  s14: ['BSBA-MM', 'BSCS'],  // CBAASG officers: CBAA
  s15: ['BSIT', 'BSA'],      // CICSSG Padayon Pioneers: CICS
  s16: ['BSCE', 'BSIT'],     // CEATSG: CEAT
  s17: ['BSCrim', 'BSCE'],   // CCJESG officers: CCJE
};

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
    Application.distinct = () => query([]);                     // no current scholars: slots free
  });

  const apply = id => call(a, 'POST', '/api/applications', { user: 's1', body: { scholarshipId: id } });

  for (const [id, [inside, outside]] of Object.entries(LIMITED)) {
    test(`${id}: a ${outside} student is refused`, async () => {
      program = outside;
      const res = await apply(id);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /certain programs/);
    });

    test(`${id}: a ${inside} student gets past the check`, async () => {
      program = inside;
      const res = await apply(id);
      assert.notEqual(res.status, 403, res.body.error);         // fails later only on the (empty) form
    });
  }

  test('a student with no program yet is refused', async () => {
    program = undefined;
    const res = await apply('s15');
    assert.equal(res.status, 403);
  });

  test('the office\'s saved rules replace the built-in list', async () => {
    setting = { status: 'Open', rules: { applicantType: 'continuing' } };   // "All programs"
    const res = await apply('s13');
    assert.notEqual(res.status, 403, res.body.error);
  });

  test('the office can also change the list', async () => {
    setting = { status: 'Open', rules: { programs: ['BSIT'] } };
    program = 'BSIT';
    assert.notEqual((await apply('s16')).status, 403);
    program = 'BSCE';
    assert.equal((await apply('s16')).status, 403);
  });

  test('scholarships without a list are open to every program', async () => {
    setting = { status: 'Open' };
    const res = await apply('s11');
    assert.notEqual(res.status, 403, res.body.error);
  });

  test('a closed scholarship is refused before the program check', async () => {
    setting = null;                                             // never opened: its default is Closed
    program = 'BSA';
    const res = await apply('s13');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /closed/i);
  });
});
