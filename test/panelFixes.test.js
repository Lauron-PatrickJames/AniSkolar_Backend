// The panel's November 2026 fixes (npm test): automatic replies, the
// members-only offices' member list, a scholarship ending when it isn't
// renewed, and duties waiting while an office head is on leave.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const AutoReply = require('../models/AutoReply');
const DutyLog = require('../models/DutyLog');
const DutySetting = require('../models/DutySetting');
const Message = require('../models/Message');
const OutboxEmail = require('../models/OutboxEmail');
const Renewal = require('../models/Renewal');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const Counter = require('../models/Counter');
const Student = require('../models/Student');
const { inOfficeHours, parseSettings, replyAfter } = require('../utils/autoReplies');

const ID = '64b7f0c2a1b2c3d4e5f60718';

describe('automatic replies', () => {
  test('office hours are weekdays, 8 AM to 5 PM in Manila', () => {
    assert.equal(inOfficeHours(new Date('2026-11-19T02:00:00Z')), true);   // Thu 10 AM
    assert.equal(inOfficeHours(new Date('2026-11-19T10:00:00Z')), false);  // Thu 6 PM
    assert.equal(inOfficeHours(new Date('2026-11-21T02:00:00Z')), false);  // Sat 10 AM
  });

  test('settings need their text when on, and each quick question its answer', () => {
    assert.ok(parseSettings({ welcome: { enabled: true, text: ' ' } }).error);
    assert.ok(parseSettings({ away: { enabled: true } }).error);
    assert.ok(parseSettings({ faqs: [{ question: 'When?', answer: '' }] }).error);
    assert.ok(parseSettings({ faqs: Array.from({ length: 11 }, () => ({ question: 'q', answer: 'a' })) }).error);
    const ok = parseSettings({ welcome: { enabled: true, text: 'Hi!' }, away: { enabled: false }, faqs: [{ question: 'When?', answer: 'Monday.' }, { question: '', answer: '' }] });
    assert.equal(ok.error, undefined);
    assert.equal(ok.value.faqs.length, 1);
    assert.equal(ok.value.away.mode, 'outsideHours');
  });

  describe('after a student writes', () => {
    let created;
    const settings = { welcome: { enabled: true, text: 'Thanks for writing!' }, away: { enabled: true, mode: 'outsideHours', text: 'We’re out of the office.' } };
    beforeEach(() => {
      created = [];
      AutoReply.findById = () => query(settings);
      Message.create = async doc => { created.push(doc); return { _id: 'auto', ...doc }; };
      Message.exists = async () => null;
      Message.findOne = () => query(null);
    });

    test('a new conversation in office hours gets the welcome', async () => {
      await replyAfter('LSO', '202399001', { _id: 'm1' }, new Date('2026-11-19T02:00:00Z'));
      assert.deepEqual(created.map(m => [m.auto, m.from, m.body]), [['welcome', 'adso', 'Thanks for writing!']]);
    });

    test('after hours the away message instead, once every 12 hours', async () => {
      await replyAfter('LSO', '202399001', { _id: 'm1' }, new Date('2026-11-19T12:00:00Z'));
      assert.deepEqual(created.map(m => m.auto), ['away']);
      Message.exists = async () => ({ _id: 'earlier' });
      created = [];
      await replyAfter('LSO', '202399001', { _id: 'm2' }, new Date('2026-11-19T13:00:00Z'));
      assert.deepEqual(created, []);
    });

    test('an ongoing conversation gets no welcome', async () => {
      Message.findOne = () => query({ createdAt: new Date('2026-11-18T02:00:00Z') });
      await replyAfter('LSO', '202399001', { _id: 'm1' }, new Date('2026-11-19T02:00:00Z'));
      assert.deepEqual(created, []);
    });
  });
});

describe('member list upload', () => {
  const a = app(require('../routes/applications'), '/api/applications');
  let created;
  beforeEach(() => {
    created = [];
    users.heraldo = clerkUser('heraldo@dlsud.edu.ph', { metadata: { role: 'admin', office: 'HERALDO' } });
    users.polca = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
    Student.find = () => query([{ studentNumber: '202399001', firstName: 'JUAN', lastName: 'DELA CRUZ', name: 'JUAN DELA CRUZ', email: 'juan@dlsud.edu.ph' }]);
    Application.find = () => query([{ studentNumber: '202399002', reviewedAt: new Date(), createdAt: new Date() }]);
    Application.create = async doc => { created.push(doc); return { _id: `a${created.length}`, ...doc, markModified() {}, async save() {} }; };
    Application.findOne = () => query(null);
    Application.updateMany = async () => ({});
    Student.findOne = () => query(null);
    let seq = 0;
    Counter.findOneAndUpdate = async () => ({ seq: ++seq });
    ScholarshipSetting.findOne = () => query(null);
    OutboxEmail.insertMany = async () => [];
    OutboxEmail.find = () => query([]);
    OutboxEmail.distinct = async () => [];
  });

  test('adds every member, skipping current scholars and incomplete rows', async () => {
    const res = await call(a, 'POST', '/api/applications/direct-award/bulk', {
      user: 'heraldo',
      body: {
        scholarshipId: 's12', approved: true,
        members: [
          { studentNumber: '202399001' },                     // signed in: added
          { studentNumber: '202399002' },                     // already a scholar
          { studentNumber: '202399003' },                     // not signed in, no email
          { studentNumber: '202399004', firstName: 'Ana', lastName: 'Reyes', email: 'ana@dlsud.edu.ph' },
          { studentNumber: '2023' },
        ],
      },
    });
    assert.equal(res.status, 201, res.body.error);
    assert.deepEqual(res.body.added, ['202399001', '202399004']);
    assert.deepEqual(res.body.skipped.map(s => s.studentNumber), ['202399002', '202399003', '2023']);
    assert.ok(created.every(c => c.awardedDirectly && c.status === 'Approved' && c.scholarshipId === 's12'));
  });

  test('needs the approval, and only the members-only offices can upload', async () => {
    assert.equal((await call(a, 'POST', '/api/applications/direct-award/bulk', { user: 'heraldo', body: { scholarshipId: 's12', members: [{ studentNumber: '202399001' }] } })).status, 400);
    assert.equal((await call(a, 'POST', '/api/applications/direct-award/bulk', { user: 'polca', body: { scholarshipId: 's3', approved: true, members: [{ studentNumber: '202399001' }] } })).status, 403);
    assert.equal(created.length, 0);
  });
});

describe('not renewed', () => {
  const a = app(require('../routes/renewals'), '/api/renewals');
  let ended;
  let reopened;
  beforeEach(() => {
    ended = null;
    reopened = null;
    users.admin = adsoAdmin();
    Application.findOne = () => ({ sort: () => Promise.resolve({ _id: 'app1', async save() { ended = { endedAt: this.endedAt, endReason: this.endReason }; } }) });
    Application.updateMany = async (q, u) => { reopened = [q, u]; return {}; };
  });

  test('ends the scholarship, and renewing it after all reopens it', async () => {
    let status = 'Under Evaluation';
    Renewal.findById = () => query({ _id: ID, status, scholarshipId: 's1', periodId: ID, studentNumber: '202399001', history: [], async save() { status = this.status; } });
    const res = await call(a, 'PATCH', `/api/renewals/admin/${ID}/status`, { user: 'admin', body: { status: 'Not Renewed', reviewNote: 'GPA below the minimum.' } });
    assert.equal(res.status, 200, res.body.error);
    assert.equal(ended.endReason, 'Not Renewed');
    assert.ok(ended.endedAt instanceof Date);

    require('../models/RenewalPeriod').findById = () => query({ requiresEvaluation: false });
    const back = await call(a, 'PATCH', `/api/renewals/admin/${ID}/status`, { user: 'admin', body: { status: 'Renewed', reviewNote: 'Grades corrected.' } });
    assert.equal(back.status, 200, back.body.error);
    assert.equal(reopened[0].endReason, 'Not Renewed');
    assert.ok(reopened[1].$unset.endedAt);
  });
});

describe('office head on leave', () => {
  const { expireUnreviewedDuties } = require('../utils/dutyExpiry');
  const NOW = new Date('2026-11-19T02:00:00Z');
  const old = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
  let pulled;
  beforeEach(() => {
    pulled = 0;
    DutyLog.find = () => query([{ _id: 'l1', studentNumber: '202399001', academicYear: 2026, term: '1st Semester', officeAssigned: 'IT Department', entries: [{ _id: 'e1', date: '2026-11-16', timeIn: '08:00', timeOut: '10:00', loggedAt: old }] }]);
    DutyLog.updateOne = async () => { pulled += 1; return { modifiedCount: 1 }; };
    Student.findOne = () => query(null);
  });
  const settings = leaves => { DutySetting.findById = () => query({ officeSlots: [{ office: 'IT Department', slots: 2, headEmail: 'itd@dlsud.edu.ph' }], leaves }); };

  test('unchecked duties wait while the head is on leave', async () => {
    settings([{ office: 'it department', since: old }]);
    assert.equal(await expireUnreviewedDuties(NOW), 0);
    assert.equal(pulled, 0);
  });

  test('back from leave: 48 hours from the return', async () => {
    settings([{ office: 'it department', since: old, endedAt: new Date(NOW.getTime() - 60 * 60 * 1000) }]);
    assert.equal(await expireUnreviewedDuties(NOW), 0);
    settings([{ office: 'it department', since: old, endedAt: new Date(NOW.getTime() - 50 * 60 * 60 * 1000) }]);
    assert.equal(await expireUnreviewedDuties(NOW), 1);
  });

  test('without a leave, they expire as before', async () => {
    settings(undefined);
    assert.equal(await expireUnreviewedDuties(NOW), 1);
  });
});

describe('AdSO-added scholars follow the approval chain', () => {
  const a = app(require('../routes/applications'), '/api/applications');
  const Counter = require('../models/Counter');
  let created;
  const body = { scholarshipId: 's2', studentNumber: '202399001', note: 'Approved on a paper application.', directorApproved: 'true', acknowledgeOtherScholarship: 'true' };
  beforeEach(() => {
    created = null;
    for (const role of ['associate', 'head', 'director']) users[role] = clerkUser(`${role}@dlsud.edu.ph`, { metadata: { role: 'admin', office: 'ADSO', adsoRole: role } });
    Student.findOne = () => query({ studentNumber: '202399001', firstName: 'JUAN', lastName: 'DELA CRUZ', name: 'JUAN DELA CRUZ', email: 'juan@dlsud.edu.ph' });
    Application.find = () => query([]);
    Application.create = async doc => { created = doc; return { _id: 'a1', ...doc, markModified() {}, async save() {} }; };
    Counter.findOneAndUpdate = async () => ({ seq: 1 });
    OutboxEmail.insertMany = async () => [];
    OutboxEmail.find = () => query([]);
    OutboxEmail.distinct = async () => [];
  });

  test('the Associate’s add goes to the Head, the Head’s to the Director', async () => {
    let res = await call(a, 'POST', '/api/applications/direct-award', { user: 'associate', body });
    assert.equal(res.status, 201, res.body.error);
    assert.equal(created.status, 'Under Evaluation');
    assert.equal(created.approvalStage, 'head');
    assert.equal(res.body.awaiting, 'head');
    res = await call(a, 'POST', '/api/applications/direct-award', { user: 'head', body });
    assert.equal(created.approvalStage, 'director');
    assert.deepEqual(created.approvalSteps.map(s => s.action), ['endorse', 'recommendApproval']);
  });

  test('the Director’s add is the final approval', async () => {
    const res = await call(a, 'POST', '/api/applications/direct-award', { user: 'director', body });
    assert.equal(res.status, 201, res.body.error);
    assert.equal(created.status, 'Approved');
    assert.equal(res.body.awaiting, undefined);
  });
});

describe('typed quick questions', () => {
  const { matchFaq } = require('../utils/autoReplies');
  const faqs = [{ question: 'How do I renew my scholarship?', answer: 'renew' }, { question: 'What are your office hours?', answer: 'hours' }];
  test('nearly the same question gets its answer', () => {
    assert.equal(matchFaq('how do i renew my scholarship po?', faqs)?.answer, 'renew');
    assert.equal(matchFaq('Office hours?', faqs)?.answer, 'hours');
  });
  test('greetings and other messages get none', () => {
    assert.equal(matchFaq('hello', faqs), null);
    assert.equal(matchFaq('I have a problem with my duty hours log yesterday', faqs), null);
  });
});
