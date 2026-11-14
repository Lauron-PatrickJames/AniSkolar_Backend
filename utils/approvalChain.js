// The AdSO's approval chain for its own scholarships (not the partner
// offices'): the Scholarship Associate checks and endorses an application,
// the Head of the Recruitment and Scholarship Unit evaluates it and
// recommends approval or rejection, and the Director gives the final
// decision. Any of them can send it back to the student for revision.
//
// Each AdSO account's role is publicMetadata.adsoRole in Clerk
// ('associate' | 'head' | 'director'; middleware/requireAdmin.js). An AdSO
// account without a role can act at every step, one step at a time (a
// single account running the office, or a demo).
//
// The steps are kept in application.approvalSteps and the current step in
// application.approvalStage; students never see either (they see "Under
// Evaluation" until the Director decides).

const STAGES = ['associate', 'head', 'director'];
const STAGE_LABEL = {
  associate: 'Scholarship Associate',
  head: 'Head of the Recruitment and Scholarship Unit',
  director: 'Director',
};

const ACTIONS = {
  endorse: { at: 'associate', to: 'head' },
  recommendApproval: { at: 'head', to: 'director' },
  recommendRejection: { at: 'head', to: 'director', noteRequired: 'Say why you recommend rejecting it.' },
  returnToAssociate: { at: 'head', to: 'associate', noteRequired: 'Say what the Associate should check.' },
  returnToHead: { at: 'director', to: 'head', noteRequired: 'Say what the Head should look at again.' },
};

// Applications that go through the chain: the AdSO's own scholarships.
const inChain = application => !application.office || application.office === 'LSO';
const stageOf = application => (STAGES.includes(application.approvalStage) ? application.approvalStage : 'associate');
// Whether this AdSO account may act at a step.
const canAct = (adminUser, stage) => !adminUser?.adsoRole || adminUser.adsoRole === stage;

function record(application, adminUser, step) {
  if (!Array.isArray(application.approvalSteps)) application.approvalSteps = [];
  application.approvalSteps.push({
    ...step,
    by: adminUser.email || adminUser.id,
    byName: adminUser.name,
    role: adminUser.adsoRole || null,
    at: new Date(),
  });
  if (typeof application.markModified === 'function') application.markModified('approvalSteps');
}

// Moves an application one step along the chain. Returns { error, status }
// when it can't be done (the caller saves on success).
function takeStep(application, action, adminUser, note = '') {
  const def = ACTIONS[action];
  if (!def) return { error: 'Unknown step.', status: 400 };
  if (!inChain(application)) return { error: 'Partner office scholarships don’t use the AdSO approval chain.', status: 409 };
  if (application.status !== 'Under Evaluation') return { error: 'Only applications under evaluation move along the approval chain.', status: 409 };
  const stage = stageOf(application);
  if (stage !== def.at) return { error: `This application is with the ${STAGE_LABEL[stage]} now.`, status: 409 };
  if (!canAct(adminUser, def.at)) return { error: `Only the ${STAGE_LABEL[def.at]} can do this step.`, status: 403 };
  const text = String(note || '').trim().slice(0, 2000);
  if (def.noteRequired && !text) return { error: def.noteRequired, status: 400 };
  record(application, adminUser, { action, fromStage: stage, toStage: def.to, note: text || undefined });
  application.approvalStage = def.to;
  return { ok: true };
}

// Why this admin can't give this decision now, or null. Only the final
// decisions (Approved / Rejected) on chain applications are limited:
// sending an application back to the student is open to every step.
function decisionBlock(application, adminUser, status, office) {
  if (office || !inChain(application) || !['Approved', 'Rejected'].includes(status)) return null;
  if (!canAct(adminUser, 'director')) return { error: 'Only the Director gives the final decision. Use the approval chain to pass it on.', status: 403 };
  // A first decision waits for the Head's recommendation; changing an
  // earlier decision is the Director's call at any time.
  if (application.status === 'Under Evaluation' && stageOf(application) !== 'director') {
    return { error: `This application is with the ${STAGE_LABEL[stageOf(application)]}. The Director decides once the Head has recommended it.`, status: 409, code: 'approval_chain' };
  }
  return null;
}

// After a final decision or a request for revision: the decision is
// recorded on the chain, and a revision starts the chain over.
function afterDecision(application, adminUser, status, note) {
  if (!inChain(application)) return;
  record(application, adminUser, { action: status === 'Needs Revision' ? 'revision' : status === 'Approved' ? 'approve' : 'reject', fromStage: stageOf(application), note: note || undefined });
  application.approvalStage = status === 'Needs Revision' ? 'associate' : 'director';
}

module.exports = { STAGES, STAGE_LABEL, ACTIONS, inChain, stageOf, canAct, takeStep, decisionBlock, afterDecision };
