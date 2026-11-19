const express = require('express');
const router = express.Router();
const { requireAdso } = require('../middleware/requireAdmin');
const AutomationSetting = require('../models/AutomationSetting');
const OutboxEmail = require('../models/OutboxEmail');
const { runJob, JOB_NAMES } = require('../utils/automation');
const { outboxCounts, processOutbox } = require('../utils/outbox');
const CustomAutomation = require('../models/CustomAutomation');
const { parseAutomation, runCustom } = require('../utils/customAutomations');

// The AdSO's Automation page (utils/automation.js).
//   GET  /api/automation                  settings, last runs, outbox counts
//   PUT  /api/automation                  { dutyReminders, officeHeadReminders, deadlineReminders }
//   POST /api/automation/:job/preview     what the job would do now (nothing sent or changed)
//   POST /api/automation/:job/run         run it now (emails nobody twice)
//   GET  /api/automation/outbox?status=queued|failed   recent emails
//   POST /api/automation/outbox/retry     send the failed ones again
// The AdSO's own automations (utils/customAutomations.js), also in GET's `custom`:
//   POST   /api/automation/custom                  add one
//   PUT    /api/automation/custom/:id              change it (all fields)
//   PATCH  /api/automation/custom/:id              { enabled } switch it on or off
//   DELETE /api/automation/custom/:id
//   POST   /api/automation/custom/:id/preview|run  like the built-in jobs

const BOOL_FIELDS = [...JOB_NAMES];

async function view() {
  const settings = await AutomationSetting.current();
  const lastRuns = settings.lastRuns instanceof Map ? Object.fromEntries(settings.lastRuns) : (settings.lastRuns ?? {});
  return {
    settings: {
      ...Object.fromEntries(BOOL_FIELDS.map(k => [k, !!settings[k]])),
      updatedBy: settings.updatedBy ?? null,
      updatedAt: settings.updatedAt ?? null,
    },
    lastRuns,
    outbox: await outboxCounts(),
    custom: await CustomAutomation.find({}).sort({ createdAt: 1 }).lean(),
  };
}

const findCustom = id => (/^[a-f\d]{24}$/i.test(id) ? CustomAutomation.findById(id) : null);

router.get('/', requireAdso, async (req, res) => {
  try {
    res.json(await view());
  } catch (err) {
    console.error('Load automation error:', err);
    res.status(500).json({ error: 'Failed to load the automation settings.' });
  }
});

router.put('/', requireAdso, async (req, res) => {
  try {
    const body = req.body || {};
    const $set = { updatedBy: req.adminUser.email || req.adminUser.id };
    for (const k of BOOL_FIELDS) if (body[k] !== undefined) $set[k] = body[k] === true;
    await AutomationSetting.updateOne({ _id: 'automation' }, { $set }, { upsert: true, runValidators: true });
    res.json(await view());
  } catch (err) {
    console.error('Save automation error:', err);
    res.status(500).json({ error: 'Failed to save the automation settings.' });
  }
});

// --- The AdSO's own automations ------------------------------------------

router.post('/custom', requireAdso, async (req, res) => {
  try {
    if (await CustomAutomation.countDocuments() >= CustomAutomation.MAX_AUTOMATIONS) {
      return res.status(400).json({ error: `You can have at most ${CustomAutomation.MAX_AUTOMATIONS} automations. Delete one you no longer use.` });
    }
    const { value, error } = parseAutomation(req.body);
    if (error) return res.status(400).json({ error });
    const by = req.adminUser.email || req.adminUser.id;
    await CustomAutomation.create({ ...value, ...(value.enabled ? { activeSince: new Date() } : {}), createdBy: by, updatedBy: by });
    res.status(201).json(await view());
  } catch (err) {
    console.error('Add automation error:', err);
    res.status(500).json({ error: 'Failed to add the automation.' });
  }
});

router.put('/custom/:id', requireAdso, async (req, res) => {
  try {
    const doc = await findCustom(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Automation not found.' });
    const { value, error } = parseAutomation(req.body);
    if (error) return res.status(400).json({ error });
    const switchedOn = value.enabled === true && !doc.enabled;
    // Fields of the other trigger are cleared.
    for (const k of ['frequency', 'date', 'weekday', 'dayOfMonth', 'audience', 'emailTarget', 'event']) doc[k] = undefined;
    doc.set({ ...value, scholarshipIds: value.scholarshipIds ?? [], updatedBy: req.adminUser.email || req.adminUser.id });
    if (switchedOn) doc.activeSince = new Date();
    await doc.save();
    res.json(await view());
  } catch (err) {
    console.error('Save automation error:', err);
    res.status(500).json({ error: 'Failed to save the automation.' });
  }
});

router.patch('/custom/:id', requireAdso, async (req, res) => {
  try {
    const doc = await findCustom(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Automation not found.' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Say whether it’s on or off.' });
    if (req.body.enabled && doc.trigger === 'schedule' && doc.frequency === 'once' && doc.lastRun?.period === doc.date) {
      return res.status(409).json({ error: 'This one-time email was already sent. Edit it and pick a new date to send it again.' });
    }
    if (req.body.enabled && !doc.enabled) doc.activeSince = new Date();
    doc.enabled = req.body.enabled;
    doc.updatedBy = req.adminUser.email || req.adminUser.id;
    await doc.save();
    res.json(await view());
  } catch (err) {
    console.error('Switch automation error:', err);
    res.status(500).json({ error: 'Failed to save the automation.' });
  }
});

router.delete('/custom/:id', requireAdso, async (req, res) => {
  try {
    const doc = await findCustom(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Automation not found.' });
    await doc.deleteOne();
    res.json(await view());
  } catch (err) {
    console.error('Delete automation error:', err);
    res.status(500).json({ error: 'Failed to delete the automation.' });
  }
});

router.post('/custom/:id/:action', requireAdso, async (req, res) => {
  const { action } = req.params;
  if (!['preview', 'run'].includes(action)) return res.status(404).json({ error: 'Not found.' });
  try {
    const doc = await findCustom(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Automation not found.' });
    const a = doc.toObject();
    // An event automation that's off looks back from now (nothing yet).
    if (a.trigger === 'event' && !a.enabled) a.activeSince = a.activeSince || new Date();
    const result = await runCustom(a, { dryRun: action === 'preview' });
    if (action === 'run') {
      await CustomAutomation.updateOne({ _id: doc._id }, { $set: { lastRun: { period: 'manual', at: new Date(), queued: result.queued, summary: `Sent now: ${result.queued} email${result.queued === 1 ? '' : 's'}.` } } });
      processOutbox().catch(err => console.error('Sending emails failed:', err));
    }
    res.json({ result, ...(action === 'run' ? await view() : {}) });
  } catch (err) {
    console.error(`Custom automation ${action} error:`, err);
    res.status(500).json({ error: `Failed to ${action === 'run' ? 'run' : 'preview'} it.` });
  }
});

// --- Built-in jobs ---------------------------------------------------------

router.post('/:job/:action', requireAdso, async (req, res) => {
  const { job, action } = req.params;
  if (!JOB_NAMES.includes(job) || !['preview', 'run'].includes(action)) return res.status(404).json({ error: 'Not found.' });
  try {
    const result = await runJob(job, { dryRun: action === 'preview' });
    if (action === 'run') processOutbox().catch(err => console.error('Sending emails failed:', err));
    res.json({ result, ...(action === 'run' ? await view() : {}) });
  } catch (err) {
    console.error(`Automation ${job} ${action} error:`, err);
    res.status(500).json({ error: `Failed to ${action === 'run' ? 'run' : 'preview'} it.` });
  }
});

router.get('/outbox', requireAdso, async (req, res) => {
  try {
    const status = OutboxEmail.STATUSES.find(s => s === req.query.status) ?? 'failed';
    const emails = await OutboxEmail.find({ status }).select('kind to subject status attempts error createdAt sentAt').sort({ updatedAt: -1 }).limit(100).lean();
    res.json({ emails });
  } catch (err) {
    console.error('Load outbox error:', err);
    res.status(500).json({ error: 'Failed to load the emails.' });
  }
});

router.post('/outbox/retry', requireAdso, async (req, res) => {
  try {
    const r = await OutboxEmail.updateMany({ status: 'failed' }, { $set: { status: 'queued', attempts: 0, nextAttemptAt: new Date() }, $unset: { error: '' } });
    processOutbox().catch(err => console.error('Sending emails failed:', err));
    res.json({ retried: r.modifiedCount, ...(await view()) });
  } catch (err) {
    console.error('Retry outbox error:', err);
    res.status(500).json({ error: 'Failed to retry.' });
  }
});

module.exports = router;
