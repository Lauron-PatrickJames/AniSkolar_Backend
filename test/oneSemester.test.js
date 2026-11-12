// One-semester grants (npm test): the USG's SFAG, Padayon Pioneers, the
// CEAT Financial Aid Scholarship and the CCJESG officers' grant end with
// the semester they were approved for, and have no renewals.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const { semesterEnd } = require('../utils/semester');
const { findHeldScholarships } = require('../utils/exclusivity');
const { SCHOLARSHIPS } = require('../data/scholarships');

const ONE_SEMESTER = ['s8', 's10', 's11', 's15', 's16', 's17'];
// The ones students apply for (the ROTC's officers are added by the office).
const APPLIED_FOR = ['s8', 's11', 's15', 's16', 's17'];
// Manila midnight is 16:00 UTC the day before.
const at = iso => new Date(iso);

describe('semesterEnd', () => {
  test('a 2nd-semester grant (January–May) ends June 1', () => {
    assert.equal(semesterEnd(at('2026-04-10T03:00:00Z')).toISOString(), '2026-05-31T16:00:00.000Z');
    assert.equal(semesterEnd(at('2026-01-05T00:00:00Z')).toISOString(), '2026-05-31T16:00:00.000Z');
  });

  test('a 1st-semester grant (June–December) ends with the year', () => {
    assert.equal(semesterEnd(at('2026-06-15T03:00:00Z')).toISOString(), '2026-12-31T16:00:00.000Z');
    assert.equal(semesterEnd(at('2026-11-20T03:00:00Z')).toISOString(), '2026-12-31T16:00:00.000Z');
  });

  test('uses Philippine time at the edges', () => {
    // 11:59 PM on Dec 31 in Manila is still the 1st semester...
    assert.equal(semesterEnd(at('2026-12-31T15:59:00Z')).toISOString(), '2026-12-31T16:00:00.000Z');
    // ...a minute after midnight is the 2nd.
    assert.equal(semesterEnd(at('2026-12-31T16:01:00Z')).toISOString(), '2027-05-31T16:00:00.000Z');
    // May 31, 11 PM UTC is already June 1 in Manila.
    assert.equal(semesterEnd(at('2026-05-31T23:00:00Z')).toISOString(), '2026-12-31T16:00:00.000Z');
  });
});

describe('the scholarship list', () => {
  test('the one-semester grants have no renewals', () => {
    for (const s of SCHOLARSHIPS) {
      assert.equal(!!s.oneSemester, ONE_SEMESTER.includes(s.id), `${s.id} oneSemester`);
      if (s.oneSemester) assert.equal(s.noRenewal, true, `${s.id} noRenewal`);
    }
  });

  test('the CBAASG scholarships keep their renewals', () => {
    for (const id of ['s13', 's14']) assert.ok(!SCHOLARSHIPS.find(s => s.id === id).noRenewal);
  });
});

describe('held scholarships', () => {
  let approved;
  beforeEach(() => {
    approved = [];
    Application.find = () => query(approved);
    Renewal.find = () => query([]);
  });
  const grant = (scholarshipId, reviewedAt, extra = {}) => ({ scholarshipId, scholarshipName: scholarshipId, createdAt: reviewedAt, reviewedAt, ...extra });
  const held = async now => (await findHeldScholarships('202312345', { now: at(now) })).map(h => h.scholarshipId);

  test('a USG grant counts during its semester only', async () => {
    approved = [grant('s11', '2026-04-15T03:00:00Z')];
    assert.deepEqual(await held('2026-05-20T03:00:00Z'), ['s11']);
    assert.deepEqual(await held('2026-06-02T03:00:00Z'), []);
  });

  test('a 1st-semester grant counts until the year ends', async () => {
    approved = [grant('s16', '2026-08-20T03:00:00Z')];
    assert.deepEqual(await held('2026-12-15T03:00:00Z'), ['s16']);
    assert.deepEqual(await held('2027-01-10T03:00:00Z'), []);
  });

  test('a grant approved again next semester counts again', async () => {
    approved = [grant('s11', '2026-04-15T03:00:00Z'), grant('s11', '2026-09-01T03:00:00Z')];
    assert.deepEqual(await held('2026-10-01T03:00:00Z'), ['s11']);
  });

  test('stopping it ends it early', async () => {
    approved = [grant('s17', '2026-08-20T03:00:00Z', { endedAt: '2026-10-01T03:00:00Z' })];
    assert.deepEqual(await held('2026-11-01T03:00:00Z'), []);
  });

  test('scholarships kept until graduation are unchanged (POLCA)', async () => {
    approved = [grant('s3', '2024-08-20T03:00:00Z')];
    assert.deepEqual(await held('2026-11-01T03:00:00Z'), ['s3']);
  });
});

describe('renewal periods', () => {
  const renewals = require('../routes/renewals');
  const a = app(renewals, '/api/renewals');
  const OFFICE = { s8: 'VICISSITUDE', s11: 'USG', s15: 'CICSSG', s16: 'CEATSG', s17: 'CCJESG' };

  for (const id of APPLIED_FOR) {
    test(`${id}: no renewal period can be opened`, async () => {
      users[`a-${id}`] = clerkUser(`${OFFICE[id].toLowerCase()}@dlsud.edu.ph`, { metadata: { role: 'admin', office: OFFICE[id] } });
      const res = await call(a, 'POST', '/api/renewals/admin/periods', { user: `a-${id}`, body: { scholarshipId: id } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /one-semester grant/);
    });
  }
});
