// The status rules (npm test): which changes each status allows. Real
// route code through Express; Clerk and the database are stubs.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Student = require('../models/Student');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const DutyLog = require('../models/DutyLog');
const DutyEvent = require('../models/DutyEvent');
const DutySetting = require('../models/DutySetting');
const { todayInManila } = require('../utils/dutyHours');

const ID = '64b7f0c2a1b2c3d4e5f60718';

// --- An ended scholarship keeps its decision --------------------------------
describe('application decisions', () => {
  const a = app(require('../routes/applications'), '/api/applications');
  let saved;
  const application = extra => ({
    _id: ID, status: 'Approved', office: 'LSO', scholarshipId: 's2', studentNumber: '202300001', history: [],
    markModified() {}, async save() { saved = this.status; }, ...extra,
  });
  beforeEach(() => { saved = undefined; users.admin = adsoAdmin(); });

  test('a graduated scholar’s application can’t be rejected', async () => {
    Application.findOne = () => query(application({ endedAt: new Date(), endReason: 'Graduated' }));
    const res = await call(a, 'PATCH', `/api/applications/${ID}/status`, { user: 'admin', body: { status: 'Rejected', reviewNote: 'Changed my mind' } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /ended \(graduated\)/);
    assert.equal(saved, undefined);
  });

  test('a current scholar’s decision can still be changed', async () => {
    Application.findOne = () => query(application({ endedAt: null }));
    const res = await call(a, 'PATCH', `/api/applications/${ID}/status`, { user: 'admin', body: { status: 'Rejected', reviewNote: 'Documents were not genuine' } });
    assert.notEqual(res.status, 409, res.body.error);
  });
});

// --- A scholar's "Not Continuing" -------------------------------------------
describe('renewal decisions on "Not Continuing"', () => {
  const a = app(require('../routes/renewals'), '/api/renewals');
  let saved;
  const renewal = () => ({
    _id: ID, status: 'Not Continuing', scholarshipId: 's2', periodId: ID, studentNumber: '202300001', history: [],
    async save() { saved = this.status; },
  });
  beforeEach(() => { saved = undefined; users.admin = adsoAdmin(); Renewal.findById = () => query(renewal()); });

  for (const status of ['Renewed', 'Not Renewed']) {
    test(`can’t be changed to ${status}`, async () => {
      const res = await call(a, 'PATCH', `/api/renewals/admin/${ID}/status`, { user: 'admin', body: { status, reviewNote: 'Overriding' } });
      assert.equal(res.status, 409);
      assert.equal(saved, undefined);
    });
  }

  test('can be sent back to the scholar (Needs Revision)', async () => {
    const res = await call(a, 'PATCH', `/api/renewals/admin/${ID}/status`, { user: 'admin', body: { status: 'Needs Revision', reviewNote: 'Did you mean to stop?' } });
    assert.notEqual(res.status, 409, res.body.error);
    assert.equal(saved, 'Needs Revision');
  });
});

// --- Duty hours: who may log, and duty identity ------------------------------
describe('duty hours', () => {
  const a = app(require('../routes/dutyHours'), '/api/duty-hours');
  const today = todayInManila();
  const TERM = { academicYear: 2026, term: '1st Semester' };
  let update;
  const sfagApproved = { scholarshipId: 's1', scholarshipName: 'SFAG', status: 'Approved', createdAt: new Date(), reviewedAt: new Date() };

  beforeEach(() => {
    update = undefined;
    users.s1 = clerkUser('scholar@dlsud.edu.ph');
    Student.findOne = () => query({ studentNumber: '202300001' });
    Student.find = () => query([]);
    Application.exists = async () => true;
    Application.find = () => query([sfagApproved]);
    Renewal.exists = async () => false;
    Renewal.find = () => query([]);
    DutyEvent.find = () => query([]);
    DutySetting.deadlineFor = async () => null;
    DutySetting.findOne = () => query(null);                    // no offices with heads, no settings
    DutyLog.findOneAndUpdate = (filter, u) => { update = u; return query({ ...filter, specialEvents: [], eventClaims: [], ...u.$set }); };
  });

  const put = entries => call(a, 'PUT', '/api/duty-hours/mine', { user: 's1', body: { ...TERM, entries } });

  test('a scholar who declined the SFAG can’t log duties', async () => {
    Application.find = () => query([{ ...sfagApproved, endedAt: new Date() }]);
    DutyLog.findOne = () => query({ officeAssigned: 'Registrar', entries: [] });
    const res = await put([{ date: today, timeIn: '13:00', timeOut: '15:00' }]);
    assert.equal(res.status, 403);
    assert.equal(update, undefined);
  });

  test('a current scholar can', async () => {
    DutyLog.findOne = () => query({ officeAssigned: 'Registrar', entries: [] });
    const res = await put([{ date: today, timeIn: '13:00', timeOut: '15:00' }]);
    assert.equal(res.status, 200, res.body.error);
    assert.ok(update, 'saved');
  });

  const saved = (status, date = '2026-10-05') => ({ _id: { toString: () => ID }, date, timeIn: '13:00', timeOut: '15:00', status, loggedAt: new Date('2026-10-05') });

  test('an unchanged duty keeps its review', async () => {
    DutyLog.findOne = () => query({ officeAssigned: 'Registrar', entries: [saved('confirmed')] });
    await put([{ _id: ID, date: '2026-10-05', timeIn: '13:00', timeOut: '15:00' }]);
    assert.equal(update.$set.entries[0].status, 'confirmed');
  });

  test('a confirmed duty from another day can’t be edited', async () => {
    DutyLog.findOne = () => query({ officeAssigned: 'Registrar', entries: [saved('confirmed')] });
    const res = await put([{ _id: ID, date: '2026-10-05', timeIn: '13:00', timeOut: '17:00' }]);
    assert.equal(res.status, 400);
    assert.equal(update, undefined);
  });

  test('a flagged duty corrected on its date keeps its id and waits for review', async () => {
    DutyLog.findOne = () => query({ officeAssigned: 'Registrar', entries: [saved('flagged')] });
    await put([{ _id: ID, date: '2026-10-05', timeIn: '13:00', timeOut: '14:30' }]);
    const [entry] = update.$set.entries;
    assert.equal(String(entry._id), ID);
    assert.equal(entry.timeOut, '14:30');
    assert.equal(entry.status, undefined);
  });
});

// --- One rule for "can this be applied for now" ------------------------------
describe('applyBlock', () => {
  const { applyBlock } = require('../utils/scholarshipDates');
  const june15 = new Date('2026-06-15T04:00:00Z');
  const sept15 = new Date('2026-09-15T04:00:00Z');

  test('closed by its office', () => {
    assert.match(applyBlock({ id: 's2' }, { status: 'Closed' }, june15), /closed/);
  });
  test('before and after its period', () => {
    assert.match(applyBlock({ id: 's2', opensOn: '2026-07-01' }, null, june15), /open on July 1, 2026/);
    assert.match(applyBlock({ id: 's2', closesOn: '2026-06-10' }, null, june15), /closed on June 10, 2026/);
  });
  test('the SFAG only in June and July', () => {
    assert.equal(applyBlock({ id: 's1' }, null, june15), null);
    assert.match(applyBlock({ id: 's1' }, null, sept15), /June and July/);
  });
  test('the SFAG\'s own dates replace June and July', () => {
    assert.equal(applyBlock({ id: 's1' }, { opensOn: '2026-09-01', closesOn: '2026-09-30' }, sept15), null);
    assert.match(applyBlock({ id: 's1' }, { opensOn: '2026-10-01', closesOn: '2026-10-31' }, sept15), /open on October 1, 2026/);
  });
  test('open', () => {
    assert.equal(applyBlock({ id: 's2', opensOn: '2026-06-01', closesOn: '2026-06-30' }, null, june15), null);
  });
});
