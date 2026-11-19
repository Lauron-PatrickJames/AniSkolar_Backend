// The office head's evaluation (npm test), as on the office's form: 19
// items, Commendations, Recommendations, and "continue in our office" or
// "grow in another office" (which Random assign uses next term).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { users, clerkUser, query, app, call } = require('./helpers');

const DutyLog = require('../models/DutyLog');
const DutySetting = require('../models/DutySetting');
const RenewalPeriod = require('../models/RenewalPeriod');
const evaluations = require('../utils/evaluations');
const { EVALUATION_ITEMS } = require('../utils/renewals');

// Hours complete: ready to evaluate.
evaluations.summariesFor = async logs => new Map(logs.map(l => [String(l._id), { completed: 55, required: 55 }]));
const a = app(require('../routes/office'), '/api/office');

const LOG = { _id: 'l1', studentNumber: '202399001', academicYear: 2026, term: '1st Semester', officeAssigned: 'Information Technology Department' };
const scores = Object.fromEntries(EVALUATION_ITEMS.map(i => [i.key, 5]));
let saved;
beforeEach(() => {
  saved = null;
  users.head = clerkUser('itd@dlsud.edu.ph');
  DutySetting.findById = () => query({ officeSlots: [{ office: 'Information Technology Department', slots: 2, headEmail: 'itd@dlsud.edu.ph', headName: 'Test Head' }] });
  DutyLog.find = () => query([LOG]);
  DutyLog.updateOne = async (filter, update) => { saved = update.$set.evaluation; return { modifiedCount: 1 }; };
  RenewalPeriod.find = () => query([]);
});

const ANSWERS = { commendations: 'Always on time.', recommendations: 'Keep it up.' };
const evaluate = body => call(a, 'PUT', '/api/office/evaluations/202399001', { user: 'head', body: { academicYear: 2026, term: '1st Semester', scores, ...body } });

test('the form has 19 items', () => {
  assert.equal(EVALUATION_ITEMS.length, 19);
  assert.deepEqual(EVALUATION_ITEMS.slice(-4).map(i => i.label), ['Completion of tasks', 'Adherence to work schedule', 'Promptness in reporting to work', 'Overall performance']);
});

test('"Continue in our office": saved with the commendations and recommendations', async () => {
  const res = await evaluate({ ...ANSWERS, requestAgain: true });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(saved.requestAgain, true);
  assert.equal(saved.commendations, 'Always on time.');
  assert.equal(saved.recommendations, 'Keep it up.');
  assert.equal(saved.average, 5);
});

test('"Let them grow in another office" is saved as false', async () => {
  const res = await evaluate({ ...ANSWERS, requestAgain: false });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(saved.requestAgain, false);
});

test('the choice, commendations and recommendations are required', async () => {
  for (const body of [{ ...ANSWERS }, { ...ANSWERS, commendations: ' ', requestAgain: true }, { ...ANSWERS, recommendations: '', requestAgain: false }, { ...ANSWERS, requestAgain: 'yes' }]) {
    const res = await evaluate(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(saved, null);
});

test('all 19 items must be rated', async () => {
  const { overallPerformance, ...fifteenPlus } = scores;
  const res = await call(a, 'PUT', '/api/office/evaluations/202399001', { user: 'head', body: { academicYear: 2026, term: '1st Semester', scores: fifteenPlus, ...ANSWERS, requestAgain: true } });
  assert.equal(res.status, 400);
});
