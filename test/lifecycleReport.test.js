// GET /api/renewals/admin/all (npm test): every renewal an office can see,
// for the Scholars page's lifecycle report.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Renewal = require('../models/Renewal');

describe('GET /api/renewals/admin/all', () => {
  const a = app(require('../routes/renewals'), '/api/renewals');
  const renewal = (studentNumber, scholarshipId, academicYear, term, status) =>
    ({ studentNumber, scholarshipId, scholarshipName: scholarshipId, academicYear, term, status, continuing: true });
  let stored;
  beforeEach(() => {
    stored = [
      renewal('202312345', 's1', 2026, '1st Semester', 'Renewed'),   // SFAG (AdSO)
      renewal('202312345', 's1', 2026, '2nd Semester', 'Not Renewed'),
      renewal('202398765', 's13', 2026, '1st Semester', 'Renewed'),  // CBAASG
    ];
    Renewal.find = () => query(stored);
    users.adso = adsoAdmin();
    users.cbaa = clerkUser('cbaasg@dlsud.edu.ph', { metadata: { role: 'admin', office: 'CBAASG' } });
    users.student = clerkUser('student@dlsud.edu.ph');
  });

  test('the AdSO sees the renewals of its own scholarships', async () => {
    const res = await call(a, 'GET', '/api/renewals/admin/all', { user: 'adso' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.renewals.map(r => `${r.scholarshipId} ${r.term}`), ['s1 1st Semester', 's1 2nd Semester']);
  });

  test('an office sees only its own scholarships', async () => {
    const res = await call(a, 'GET', '/api/renewals/admin/all', { user: 'cbaa' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.renewals.map(r => r.studentNumber), ['202398765']);
  });

  test('students can’t use it', async () => {
    const res = await call(a, 'GET', '/api/renewals/admin/all', { user: 'student' });
    assert.ok([401, 403].includes(res.status), `status ${res.status}`);
  });
});
