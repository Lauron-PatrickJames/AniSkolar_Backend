const express = require('express');
const router = express.Router();
const Application = require('../models/Application');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const { SCHOLARSHIPS, findScholarship } = require('../data/scholarships');
const { requireAdso } = require('../middleware/requireAdmin');

// Scholarship management. The scholarship list is defined in code
// (data/scholarships.js); the AdSO can override its content — status
// (Open / Closing Soon / Closed), deadline, description, benefits,
// eligibility text, process steps and submission note — which is stored in
// ScholarshipSetting and merged over the code defaults by the frontend.
//
//   GET   /api/scholarships          public: every scholarship's overrides
//   GET   /api/scholarships/admin    AdSO: scholarships + overrides + application counts
//   PATCH /api/scholarships/:id      AdSO: update one scholarship's overrides

const { STATUSES } = ScholarshipSetting;
const LIST_FIELDS = ['benefits', 'eligibility', 'process'];
const TEXT_LIMITS = { deadline: 200, description: 4000, submissionNote: 500, schedule: 300 };
const LIST_ITEM_LIMIT = 1000;
const LIST_MAX_ITEMS = 30;

router.get('/', async (req, res) => {
  try {
    const settings = await ScholarshipSetting.find({});
    res.json({ scholarships: settings.map(s => s.toOverrides()) });
  } catch (err) {
    console.error('Load scholarship settings error:', err);
    res.status(500).json({ error: 'Failed to load scholarships.' });
  }
});

// Counts cover every application for each scholarship, including POLCA and
// Alumni ones their office hasn't approved yet: the AdSO sees the numbers
// but reviews those applications only once the office approves them.
router.get('/admin', requireAdso, async (req, res) => {
  try {
    const [settings, counts] = await Promise.all([
      ScholarshipSetting.find({}),
      Application.aggregate([
        { $group: { _id: { scholarshipId: '$scholarshipId', status: '$status' }, count: { $sum: 1 } } },
      ]),
    ]);
    const overridesById = new Map(settings.map(s => [s.scholarshipId, s.toOverrides()]));
    const countsById = {};
    for (const { _id, count } of counts) {
      const entry = (countsById[_id.scholarshipId] ??= { total: 0, byStatus: {} });
      entry.total += count;
      entry.byStatus[_id.status] = count;
    }
    res.json({
      scholarships: SCHOLARSHIPS.map(s => ({
        id: s.id,
        name: s.name,
        office: s.office,
        formType: s.formType,
        applicationMode: s.applicationMode || 'online',
        overrides: overridesById.get(s.id) || { id: s.id },
        applications: countsById[s.id] || { total: 0, byStatus: {} },
      })),
    });
  } catch (err) {
    console.error('Load admin scholarships error:', err);
    res.status(500).json({ error: 'Failed to load scholarships.' });
  }
});

// Body: any of the editable fields. Send null (or '' / []) to clear an
// override and fall back to the default in code.
router.patch('/:id', requireAdso, async (req, res) => {
  try {
    const scholarship = findScholarship(req.params.id);
    if (!scholarship) return res.status(404).json({ error: 'Scholarship not found.' });

    const body = req.body || {};
    const set = {};
    const unset = {};

    if (body.status !== undefined) {
      if (body.status === null || body.status === '') unset.status = '';
      else if (!STATUSES.includes(body.status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
      else set.status = body.status;
    }

    for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
      if (body[field] === undefined) continue;
      if (body[field] === null || (typeof body[field] === 'string' && !body[field].trim())) { unset[field] = ''; continue; }
      if (typeof body[field] !== 'string') return res.status(400).json({ error: `${field} must be text.` });
      if (body[field].trim().length > limit) return res.status(400).json({ error: `${field} must be at most ${limit} characters.` });
      set[field] = body[field].trim();
    }

    for (const field of LIST_FIELDS) {
      if (body[field] === undefined) continue;
      if (body[field] === null) { unset[field] = ''; continue; }
      if (!Array.isArray(body[field]) || body[field].some(item => typeof item !== 'string')) {
        return res.status(400).json({ error: `${field} must be a list of text items.` });
      }
      const items = body[field].map(item => item.trim()).filter(Boolean);
      if (items.length > LIST_MAX_ITEMS || items.some(item => item.length > LIST_ITEM_LIMIT)) {
        return res.status(400).json({ error: `${field} can have at most ${LIST_MAX_ITEMS} items of ${LIST_ITEM_LIMIT} characters.` });
      }
      if (items.length === 0) unset[field] = '';
      else set[field] = items;
    }

    set.updatedBy = req.adminUser.email || req.adminUser.id;
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;

    const saved = await ScholarshipSetting.findOneAndUpdate(
      { scholarshipId: scholarship.id },
      update,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ scholarship: saved.toOverrides() });
  } catch (err) {
    console.error('Update scholarship error:', err);
    res.status(500).json({ error: 'Failed to update scholarship.' });
  }
});

module.exports = router;
