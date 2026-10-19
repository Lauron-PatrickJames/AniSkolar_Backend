const express = require('express');
const router = express.Router();
const { requireAdso } = require('../middleware/requireAdmin');
const AutomationSetting = require('../models/AutomationSetting');
const OutboxEmail = require('../models/OutboxEmail');
const { runJob, JOB_NAMES } = require('../utils/automation');
const { outboxCounts, processOutbox } = require('../utils/outbox');

// The AdSO's Automation page (utils/automation.js).
//   GET  /api/automation                  settings, last runs, outbox counts
//   PUT  /api/automation                  { dutyReminders, …, adsoDigestTo, keepLastOffice }
//   POST /api/automation/:job/preview     what the job would do now (nothing sent or changed)
//   POST /api/automation/:job/run         run it now (emails nobody twice)
//   GET  /api/automation/outbox?status=queued|failed   recent emails
//   POST /api/automation/outbox/retry     send the failed ones again

const BOOL_FIELDS = [...JOB_NAMES, 'keepLastOffice'];

async function view() {
  const settings = await AutomationSetting.current();
  const lastRuns = settings.lastRuns instanceof Map ? Object.fromEntries(settings.lastRuns) : (settings.lastRuns ?? {});
  return {
    settings: {
      ...Object.fromEntries(BOOL_FIELDS.map(k => [k, !!settings[k]])),
      adsoDigestTo: settings.adsoDigestTo ?? [],
      updatedBy: settings.updatedBy ?? null,
      updatedAt: settings.updatedAt ?? null,
    },
    lastRuns,
    outbox: await outboxCounts(),
  };
}

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
    if (body.adsoDigestTo !== undefined) {
      if (!Array.isArray(body.adsoDigestTo)) return res.status(400).json({ error: 'List the emails for the summary.' });
      const emails = [...new Set(body.adsoDigestTo.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
      if (emails.length > 10) return res.status(400).json({ error: 'At most 10 people get the summary.' });
      const bad = emails.find(e => !/^[^\s@]+@dlsud\.edu\.ph$/.test(e));
      if (bad) return res.status(400).json({ error: `${bad} isn't a @dlsud.edu.ph address.` });
      $set.adsoDigestTo = emails;
    }
    await AutomationSetting.updateOne({ _id: 'automation' }, { $set }, { upsert: true, runValidators: true });
    res.json(await view());
  } catch (err) {
    console.error('Save automation error:', err);
    res.status(500).json({ error: 'Failed to save the automation settings.' });
  }
});

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
    const status = OutboxEmail.STATUSES.includes(req.query.status) ? req.query.status : 'failed';
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
