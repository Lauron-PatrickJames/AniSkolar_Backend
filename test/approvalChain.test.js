// The AdSO approval chain (npm test): Associate → Head → Director.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { takeStep, decisionBlock, afterDecision, stageOf } = require('../utils/approvalChain');

const admin = adsoRole => ({ email: `${adsoRole || 'adso'}@dlsud.edu.ph`, name: 'Staff', office: 'LSO', adsoRole: adsoRole || null });
const app = extra => ({ status: 'Under Evaluation', office: 'LSO', scholarshipId: 's2', approvalSteps: [], ...extra });

describe('taking steps', () => {
  test('a new application starts with the Associate', () => {
    assert.equal(stageOf(app()), 'associate');
  });

  test('Associate → Head → Director, each recorded', () => {
    const a = app();
    assert.deepEqual(takeStep(a, 'endorse', admin('associate')), { ok: true });
    assert.equal(a.approvalStage, 'head');
    assert.deepEqual(takeStep(a, 'recommendApproval', admin('head'), 'Complete documents.'), { ok: true });
    assert.equal(a.approvalStage, 'director');
    assert.deepEqual(a.approvalSteps.map(s => [s.action, s.role]), [['endorse', 'associate'], ['recommendApproval', 'head']]);
  });

  test('only the role of the current step can act', () => {
    const a = app();
    assert.equal(takeStep(a, 'endorse', admin('head')).status, 403);
    assert.equal(takeStep(a, 'recommendApproval', admin('head')).status, 409); // still with the Associate
  });

  test('an account without a role can act at each step', () => {
    const a = app();
    takeStep(a, 'endorse', admin());
    takeStep(a, 'recommendRejection', admin(), 'Incomplete income documents.');
    assert.equal(a.approvalStage, 'director');
  });

  test('recommending rejection and returning need a note', () => {
    const a = app({ approvalStage: 'head' });
    assert.equal(takeStep(a, 'recommendRejection', admin('head')).status, 400);
    assert.equal(takeStep(a, 'returnToAssociate', admin('head')).status, 400);
    assert.deepEqual(takeStep(a, 'returnToAssociate', admin('head'), 'Check the COR.'), { ok: true });
    assert.equal(a.approvalStage, 'associate');
  });

  test('the Director can return it to the Head', () => {
    const a = app({ approvalStage: 'director' });
    assert.deepEqual(takeStep(a, 'returnToHead', admin('director'), 'Recheck the GPA.'), { ok: true });
    assert.equal(a.approvalStage, 'head');
  });

  test('partner office scholarships and decided applications are not in the chain', () => {
    assert.equal(takeStep(app({ office: 'POLCA' }), 'endorse', admin('associate')).status, 409);
    assert.equal(takeStep(app({ status: 'Approved' }), 'endorse', admin('associate')).status, 409);
  });
});

describe('the final decision', () => {
  test('waits for the Director’s step', () => {
    assert.equal(decisionBlock(app(), admin('director'), 'Approved', null).code, 'approval_chain');
    assert.equal(decisionBlock(app({ approvalStage: 'head' }), admin(), 'Rejected', null).code, 'approval_chain');
    assert.equal(decisionBlock(app({ approvalStage: 'director' }), admin('director'), 'Approved', null), null);
  });

  test('is the Director’s only', () => {
    assert.equal(decisionBlock(app({ approvalStage: 'director' }), admin('head'), 'Approved', null).status, 403);
    assert.equal(decisionBlock(app({ status: 'Approved' }), admin('associate'), 'Rejected', null).status, 403);
  });

  test('changing an earlier decision is open to the Director at any time', () => {
    assert.equal(decisionBlock(app({ status: 'Approved' }), admin('director'), 'Rejected', null), null);
  });

  test('anyone in the chain can ask the student for a revision', () => {
    assert.equal(decisionBlock(app(), admin('associate'), 'Needs Revision', null), null);
  });

  test('partner offices decide their own applications', () => {
    assert.equal(decisionBlock(app({ office: 'POLCA' }), admin(), 'Approved', 'POLCA'), null);
    assert.equal(decisionBlock(app({ office: 'POLCA' }), admin('associate'), 'Approved', null), null);
  });

  test('a revision starts the chain over; a decision is recorded', () => {
    const a = app({ approvalStage: 'director' });
    afterDecision(a, admin('associate'), 'Needs Revision', 'Upload the COR.');
    assert.equal(a.approvalStage, 'associate');
    const b = app({ approvalStage: 'director' });
    afterDecision(b, admin('director'), 'Approved');
    assert.equal(b.approvalSteps.at(-1).action, 'approve');
  });
});
