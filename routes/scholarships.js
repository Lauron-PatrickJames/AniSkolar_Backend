const express = require('express');
const router = express.Router();
const Application = require('../models/Application');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const { SCHOLARSHIPS, allScholarships, findScholarship } = require('../data/scholarships');
const { DOCUMENT_KEYS, parseRules } = require('../data/requirementCatalog');
const customScholarships = require('../utils/customScholarships');
const { requireAdso } = require('../middleware/requireAdmin');
const { inSfagApplicationWindow } = require('../utils/academicYear');

// The SFAG takes new applications in June and July only (renewals the rest
// of the year), so it can only be open then.
const SFAG_ID = 's1';

// Scholarship management. The built-in scholarships are defined in code
// (data/scholarships.js); the AdSO can override their content — status
// (Open / Closing Soon / Closed), deadline, description, benefits, process
// steps, submission note, and the eligibility rules and documents picked
// from the shared catalog (data/requirementCatalog.js) — stored in
// ScholarshipSetting and merged over the code defaults by the frontend.
// The AdSO can also create scholarships of their own (standard form or
// info only).
//
//   GET    /api/scholarships          public: every scholarship's overrides (and created ones)
//   GET    /api/scholarships/admin    AdSO: scholarships + overrides + application counts
//   POST   /api/scholarships          AdSO: create a scholarship { name, office, category, applicationMode, referenceCode? }
//   PATCH  /api/scholarships/:id      AdSO: update one scholarship's overrides
//   DELETE /api/scholarships/:id      AdSO: delete a created scholarship with no applications

const { STATUSES } = ScholarshipSetting;
const LIST_FIELDS = ['benefits', 'process'];
// Lists where an empty list is a choice ("none"), not "use the default".
const CHOICE_LIST_FIELDS = ['customEligibility', 'customDocuments'];
const CATEGORIES = ['Academic', 'Financial', 'Athletic', 'Leadership', 'Others'];
const OFFICES = ['LSO', 'POLCA', 'ALUMNI'];
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
      scholarships: allScholarships().map(s => ({
        id: s.id,
        name: s.name,
        office: s.office,
        formType: s.formType,
        applicationMode: s.applicationMode || 'online',
        custom: !!s.custom,
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
      // Its default status is Open, so clearing it counts as opening too.
      if (scholarship.id === SFAG_ID && body.status !== 'Closed' && !inSfagApplicationWindow()) {
        return res.status(409).json({ error: 'The SFAG can only be open in June and July, before the 1st semester enrollment. The rest of the year is for renewals (Review → Renewals).' });
      }
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

    if (body.rules !== undefined) {
      if (body.rules === null) unset.rules = '';
      else {
        const parsed = parseRules(body.rules);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        set.rules = parsed.value;
      }
    }
    for (const field of CHOICE_LIST_FIELDS) {
      if (body[field] === undefined) continue;
      if (body[field] === null) { unset[field] = ''; continue; }
      if (!Array.isArray(body[field]) || body[field].some(item => typeof item !== 'string')) {
        return res.status(400).json({ error: `${field} must be a list of text items.` });
      }
      const items = [...new Set(body[field].map(item => item.trim()).filter(Boolean))];
      if (items.length > LIST_MAX_ITEMS || items.some(item => item.length > LIST_ITEM_LIMIT)) {
        return res.status(400).json({ error: `${field} can have at most ${LIST_MAX_ITEMS} items of ${LIST_ITEM_LIMIT} characters.` });
      }
      set[field] = items;
    }
    if (body.documentKeys !== undefined) {
      if (body.documentKeys === null) unset.documentKeys = '';
      else {
        if (!Array.isArray(body.documentKeys) || body.documentKeys.some(k => !DOCUMENT_KEYS.includes(k))) {
          return res.status(400).json({ error: 'Unknown document in the list.' });
        }
        set.documentKeys = [...new Set(body.documentKeys)];
      }
    }
    // POLCA and Alumni upload against fixed slots in their own forms.
    if ((set.documentKeys || set.customDocuments) && scholarship.documentSlots?.length) {
      return res.status(400).json({ error: `The ${scholarship.name} documents are set by its application form.` });
    }

    // Created scholarships: their fixed details can be edited too.
    if (scholarship.custom) {
      const fixed = parseCustomFields(body, { partial: true, excludeId: scholarship.id });
      if (fixed.error) return res.status(400).json({ error: fixed.error });
      Object.assign(set, fixed.value);
    }

    set.updatedBy = req.adminUser.email || req.adminUser.id;
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;

    const saved = await ScholarshipSetting.findOneAndUpdate(
      { scholarshipId: scholarship.id },
      update,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true }
    );
    if (scholarship.custom) await customScholarships.load();
    res.json({ scholarship: saved.toOverrides() });
  } catch (err) {
    console.error('Update scholarship error:', err);
    res.status(500).json({ error: 'Failed to update scholarship.' });
  }
});

// The fixed details of a created scholarship. `partial` (PATCH) only
// checks what's sent. Returns { value } or { error }.
function parseCustomFields(body, { partial = false, excludeId = null } = {}) {
  const value = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) return { error: 'Enter the scholarship name.' };
    if (name.length > 150) return { error: 'The name must be at most 150 characters.' };
    const clash = allScholarships().find(s => s.id !== excludeId && s.name.toLowerCase() === name.toLowerCase());
    if (clash) return { error: 'A scholarship with this name already exists.' };
    value.name = name;
  }
  if (!partial || body.office !== undefined) {
    if (!OFFICES.includes(body.office)) return { error: 'Choose the office that reviews it.' };
    value.office = body.office;
  }
  if (!partial || body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) return { error: 'Choose a category.' };
    value.category = body.category;
  }
  if (!partial || body.applicationMode !== undefined) {
    if (!['online', 'info'].includes(body.applicationMode)) return { error: 'Choose whether students apply online.' };
    value.applicationMode = body.applicationMode;
  }
  if (body.availNote !== undefined) {
    if (body.availNote !== null && typeof body.availNote !== 'string') return { error: 'The note must be text.' };
    value.availNote = (body.availNote || '').trim().slice(0, 500) || undefined;
  }
  if (!partial || body.referenceCode !== undefined) {
    const code = typeof body.referenceCode === 'string' ? body.referenceCode.trim().toUpperCase() : '';
    if (!/^[A-Z]{2,8}$/.test(code)) return { error: 'The reference code must be 2–8 letters, e.g. CSG.' };
    const taken = allScholarships().find(s => s.id !== excludeId && (s.referenceCode || '').toUpperCase() === code);
    if (taken) return { error: `The reference code ${code} is already used by the ${taken.name}.` };
    value.referenceCode = code;
  }
  return { value };
}

router.post('/', requireAdso, async (req, res) => {
  try {
    const parsed = parseCustomFields(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const slug = parsed.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'scholarship';
    const scholarshipId = `c-${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const saved = await ScholarshipSetting.create({
      scholarshipId,
      ...parsed.value,
      custom: true,
      // New scholarships start closed, with nothing required yet.
      status: 'Closed',
      rules: { applicantType: 'any' },
      customEligibility: [],
      documentKeys: [],
      customDocuments: [],
      createdBy: req.adminUser.email || req.adminUser.id,
      updatedBy: req.adminUser.email || req.adminUser.id,
    });
    await customScholarships.load();
    res.status(201).json({ scholarship: saved.toOverrides() });
  } catch (err) {
    console.error('Create scholarship error:', err);
    res.status(500).json({ error: 'Failed to create the scholarship.' });
  }
});

router.delete('/:id', requireAdso, async (req, res) => {
  try {
    const scholarship = findScholarship(req.params.id);
    if (!scholarship) return res.status(404).json({ error: 'Scholarship not found.' });
    if (!scholarship.custom) return res.status(400).json({ error: 'Built-in scholarships can\'t be deleted. Close it instead.' });
    if (await Application.exists({ scholarshipId: scholarship.id })) {
      return res.status(409).json({ error: 'It has applications, so it can\'t be deleted. Close it instead.' });
    }
    await ScholarshipSetting.deleteOne({ scholarshipId: scholarship.id, custom: true });
    await customScholarships.load();
    res.json({ deleted: scholarship.id });
  } catch (err) {
    console.error('Delete scholarship error:', err);
    res.status(500).json({ error: 'Failed to delete the scholarship.' });
  }
});

module.exports = router;
