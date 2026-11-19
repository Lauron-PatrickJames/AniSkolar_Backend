// The AdSO's own automations (npm test): validation, when a schedule is
// due, what an event automation emails, and the routes.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, adsoAdmin, query, app, call } = require('./helpers');

const Application = require('../models/Application');
const CustomAutomation = require('../models/CustomAutomation');
const OutboxEmail = require('../models/OutboxEmail');
const Student = require('../models/Student');
const AutomationSetting = require('../models/AutomationSetting');
const { parseAutomation, runCustom, isDue, periodOf, fill } = require('../utils/customAutomations');

const NOW = new Date('2026-11-19T02:00:00Z'); // Thursday, 10 AM in Manila
const SCHEDULE = {
  name: 'Monthly check-in', trigger: 'schedule', frequency: 'monthly', dayOfMonth: 1, hour: 9,
  audience: 'students', emailTarget: { mode: 'scholars', scholarshipIds: ['s1'] },
  subject: 'Hello {firstName}', body: 'A reminder from the office.',
};
const EVENT = {
  name: 'Approval follow-up', trigger: 'event', event: 'applicationApproved', scholarshipIds: ['s1'],
  subject: 'Your {scholarship} is {status}', body: 'Hi {firstName}, welcome aboard.',
};

describe('parseAutomation', () => {
  test('a schedule and an event automation are accepted', () => {
    const s = parseAutomation(SCHEDULE, { now: NOW });
    assert.equal(s.error, undefined);
    assert.equal(s.value.dayOfMonth, 1);
    assert.equal(s.value.emailTarget.mode, 'scholars');
    const e = parseAutomation(EVENT, { now: NOW });
    assert.equal(e.error, undefined);
    assert.deepEqual(e.value.scholarshipIds, ['s1']);
  });

  test('refuses what can’t be sent', () => {
    const bad = [
      { ...SCHEDULE, name: ' ' },
      { ...SCHEDULE, subject: '' },
      { ...SCHEDULE, trigger: 'whenever' },
      { ...SCHEDULE, frequency: 'hourly' },
      { ...SCHEDULE, dayOfMonth: 31 },
      { ...SCHEDULE, hour: 24 },
      { ...SCHEDULE, frequency: 'once', date: '2026-11-18' },   // yesterday
      { ...SCHEDULE, frequency: 'weekly', weekday: 7 },
      { ...SCHEDULE, audience: 'everyone' },
      { ...EVENT, event: 'graduated' },
      { ...EVENT, scholarshipIds: ['nope'] },
    ];
    for (const b of bad) assert.ok(parseAutomation(b, { now: NOW }).error, JSON.stringify(b));
    assert.equal(parseAutomation({ ...SCHEDULE, frequency: 'once', date: '2026-11-19' }, { now: NOW }).error, undefined);
  });
});

describe('schedules', () => {
  const clock = { date: '2026-11-19', hour: 10, weekday: 'Thu' };
  test('due at or after its hour, on its day', () => {
    assert.equal(isDue({ frequency: 'daily', hour: 8 }, clock), true);
    assert.equal(isDue({ frequency: 'daily', hour: 11 }, clock), false);
    assert.equal(isDue({ frequency: 'weekly', weekday: 4, hour: 8 }, clock), true);
    assert.equal(isDue({ frequency: 'weekly', weekday: 1, hour: 8 }, clock), false);
    assert.equal(isDue({ frequency: 'monthly', dayOfMonth: 19, hour: 8 }, clock), true);
    assert.equal(isDue({ frequency: 'once', date: '2026-11-19', hour: 8 }, clock), true);
    assert.equal(isDue({ frequency: 'once', date: '2026-11-20', hour: 8 }, clock), false);
  });

  test('one run per day, week or month', () => {
    assert.equal(periodOf({ frequency: 'daily' }, clock), '2026-11-19');
    assert.equal(periodOf({ frequency: 'weekly' }, clock), '2026-W47');
    assert.equal(periodOf({ frequency: 'monthly' }, clock), '2026-11');
  });

  test('placeholders', () => {
    assert.equal(fill('Hi {firstName}, your {scholarship}', { firstName: 'Juan', scholarship: 'SFAG' }), 'Hi Juan, your SFAG');
    assert.equal(fill('Hi {firstName} {nope}', {}), 'Hi there {nope}');
  });
});

describe('event automations', () => {
  let apps;
  beforeEach(() => {
    apps = [];
    Application.find = () => query(apps);
    Student.find = () => query([{ studentNumber: '202399001', email: 'Juan@dlsud.edu.ph', firstName: 'JUAN' }]);
    OutboxEmail.distinct = async () => [];
  });

  test('emails the student behind each change since it was switched on, once', async () => {
    apps = [{ _id: 'a1', studentNumber: '202399001', scholarshipId: 's1', scholarshipName: 'Student Financial Aid Grant (SFAG)', status: 'Approved', reviewedAt: new Date('2026-11-18T00:00:00Z') }];
    const a = { _id: 'c1', ...parseAutomation(EVENT, { now: NOW }).value, activeSince: new Date('2026-11-17T00:00:00Z') };
    const preview = await runCustom(a, { now: NOW, dryRun: true });
    assert.equal(preview.emails, 1);
    assert.deepEqual(preview.sample, [{ to: 'juan@dlsud.edu.ph', subject: 'Your Student Financial Aid Grant (SFAG) is Approved' }]);
    assert.equal(preview.queued, 0);

    // Already queued: skipped.
    OutboxEmail.distinct = async () => [`custom:c1:application:a1:Approved:${apps[0].reviewedAt.getTime()}`];
    assert.equal((await runCustom(a, { now: NOW, dryRun: true })).emails, 0);
  });
});

describe('routes', () => {
  const a = app(require('../routes/automation'), '/api/automation');
  let created;
  beforeEach(() => {
    users.adso = adsoAdmin();
    users.office = clerkUser('polca@dlsud.edu.ph', { metadata: { role: 'admin', office: 'POLCA' } });
    created = null;
    CustomAutomation.countDocuments = async () => 0;
    CustomAutomation.create = async doc => { created = doc; return doc; };
    CustomAutomation.find = () => query([]);
    AutomationSetting.current = async () => ({ lastRuns: {} });
    OutboxEmail.countDocuments = async () => 0;
  });

  test('the AdSO adds one; switching it on starts it from now', async () => {
    const res = await call(a, 'POST', '/api/automation/custom', { user: 'adso', body: { ...EVENT, enabled: true } });
    assert.equal(res.status, 201, res.body.error);
    assert.equal(created.event, 'applicationApproved');
    assert.ok(created.activeSince instanceof Date);
    assert.equal(created.createdBy, 'adso@dlsud.edu.ph');
  });

  test('a bad one is refused, and other offices can’t add any', async () => {
    assert.equal((await call(a, 'POST', '/api/automation/custom', { user: 'adso', body: { ...EVENT, event: '' } })).status, 400);
    assert.equal((await call(a, 'POST', '/api/automation/custom', { user: 'office', body: EVENT })).status, 403);
    assert.equal(created, null);
  });

  test('at most 30', async () => {
    CustomAutomation.countDocuments = async () => 30;
    assert.equal((await call(a, 'POST', '/api/automation/custom', { user: 'adso', body: EVENT })).status, 400);
  });
});
