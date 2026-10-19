const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdmin } = require('../middleware/requireAdmin');
const ReplyTemplate = require('../models/ReplyTemplate');

// Saved replies for the admin's office (models/ReplyTemplate.js).
//   GET    /api/reply-templates          the office's templates (most used first)
//   POST   /api/reply-templates          { title, body, context, decision? }
//   PUT    /api/reply-templates/:id      edit
//   DELETE /api/reply-templates/:id      delete
//   POST   /api/reply-templates/:id/used count a use (sorts it higher)
// An office gets a starter set the first time it opens its templates.

const { CONTEXTS, DECISIONS } = ReplyTemplate;
const APPLICATION_DECISIONS = ['Approved', 'Rejected', 'Needs Revision'];
const RENEWAL_DECISIONS = ['Renewed', 'Not Renewed', 'Needs Revision'];

const STARTERS = [
  { context: 'application', decision: 'Needs Revision', title: 'Blurry or unreadable document', body: 'Hi {firstName}, one of your documents for the {scholarship} ({referenceCode}) is blurry or cut off, so we can\'t read it: [which document]. Please upload a clear photo or scan of the whole page and resubmit.' },
  { context: 'application', decision: 'Needs Revision', title: 'Missing document', body: 'Hi {firstName}, your {scholarship} application ({referenceCode}) is missing a required document: [which document]. Please upload it and resubmit.' },
  { context: 'application', decision: 'Needs Revision', title: "Details don't match the documents", body: 'Hi {firstName}, some details in your {scholarship} application ({referenceCode}) don\'t match your documents: [what doesn\'t match]. Please correct them and resubmit.' },
  { context: 'application', decision: 'Rejected', title: 'GPA below the requirement', body: 'Hi {firstName}, thank you for applying for the {scholarship}. We\'re unable to approve your application because your GPA is below the scholarship\'s requirement. You\'re welcome to apply again next cycle.' },
  { context: 'application', decision: 'Rejected', title: 'Slots filled', body: 'Hi {firstName}, thank you for applying for the {scholarship}. All slots for this cycle have been filled, so we\'re unable to approve your application. You\'re welcome to apply again next cycle.' },
  { context: 'application', decision: 'Approved', title: 'Approved: next steps', body: 'Congratulations, {firstName}! Your {scholarship} application ({referenceCode}) has been approved. Please watch your school email and AniSkolar announcements for the orientation schedule.' },
  { context: 'renewal', decision: 'Needs Revision', title: 'Grades unreadable or incomplete', body: 'Hi {firstName}, the grades you uploaded for your {term} renewal are unreadable or incomplete. Please upload a clear copy of the whole document and resubmit.' },
  { context: 'renewal', decision: 'Needs Revision', title: "GPA doesn't match the grades", body: 'Hi {firstName}, the GPA you entered for your {term} renewal doesn\'t match your grades. Please check it and resubmit.' },
  { context: 'renewal', decision: 'Not Renewed', title: 'GPA below the minimum', body: 'Hi {firstName}, we\'re unable to renew your {scholarship} for the {term} because your GPA is below the required minimum. If you have questions, message the office in AniSkolar.' },
  { context: 'renewal', decision: 'Not Renewed', title: 'Duty hours not completed', body: 'Hi {firstName}, we\'re unable to renew your {scholarship} for the {term} because last semester\'s required duty hours weren\'t completed. If you have questions, message the office in AniSkolar.' },
  { context: 'renewal', decision: 'Renewed', title: 'Renewed', body: 'Congratulations, {firstName}! Your {scholarship} has been renewed for the {term}. Keep it up!' },
  { context: 'message', title: 'Document received', body: 'Hi {firstName}, we received your document. We\'ll update you here once it has been checked.' },
  { context: 'message', title: 'Please visit the office', body: 'Hi {firstName}, please visit our office on a weekday, 8:00 AM–5:00 PM, and bring [what to bring].' },
];

const officeOf = req => req.adminUser.office;
const view = t => ({ _id: String(t._id), title: t.title, body: t.body, context: t.context, decision: t.decision ?? null, usedCount: t.usedCount ?? 0, updatedAt: t.updatedAt });

function parse(body) {
  const title = typeof body?.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!title) return { error: 'Give the template a name.' };
  if (title.length > 80) return { error: 'The name is too long (80 characters at most).' };
  if (!text) return { error: 'Write the message.' };
  if (text.length > 2000) return { error: 'The message is too long (2,000 characters at most).' };
  if (!CONTEXTS.includes(body.context)) return { error: 'Choose where it\'s used.' };
  let decision = body.decision || undefined;
  if (decision !== undefined) {
    const allowed = body.context === 'application' ? APPLICATION_DECISIONS : body.context === 'renewal' ? RENEWAL_DECISIONS : [];
    if (!DECISIONS.includes(decision) || !allowed.includes(decision)) return { error: 'That decision doesn\'t apply here.' };
  }
  return { value: { title, body: text, context: body.context, decision } };
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const office = officeOf(req);
    if (!(await ReplyTemplate.exists({ office }))) {
      await ReplyTemplate.insertMany(STARTERS.map(t => ({ ...t, office, starter: true, createdBy: 'AniSkolar' })));
    }
    const list = await ReplyTemplate.find({ office, deletedAt: null }).sort({ usedCount: -1, title: 1 }).lean();
    res.json({ templates: list.map(view) });
  } catch (err) {
    console.error('Load reply templates error:', err);
    res.status(500).json({ error: 'Failed to load the templates.' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { value, error } = parse(req.body);
    if (error) return res.status(400).json({ error });
    if (await ReplyTemplate.countDocuments({ office: officeOf(req), deletedAt: null }) >= 200) return res.status(400).json({ error: 'At most 200 templates per office.' });
    const by = req.adminUser.email || req.adminUser.id;
    const t = await ReplyTemplate.create({ ...value, office: officeOf(req), createdBy: by, updatedBy: by });
    res.status(201).json({ template: view(t) });
  } catch (err) {
    console.error('Create reply template error:', err);
    res.status(500).json({ error: 'Failed to save the template.' });
  }
});

async function findOwn(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid template.' }); return null; }
  const t = await ReplyTemplate.findOne({ _id: req.params.id, office: officeOf(req), deletedAt: null });
  if (!t) res.status(404).json({ error: 'Template not found.' });
  return t;
}

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const t = await findOwn(req, res);
    if (!t) return;
    const { value, error } = parse(req.body);
    if (error) return res.status(400).json({ error });
    Object.assign(t, value, { updatedBy: req.adminUser.email || req.adminUser.id });
    if (!value.decision) t.decision = undefined;
    await t.save();
    res.json({ template: view(t) });
  } catch (err) {
    console.error('Update reply template error:', err);
    res.status(500).json({ error: 'Failed to save the template.' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const t = await findOwn(req, res);
    if (!t) return;
    t.deletedAt = new Date();
    t.updatedBy = req.adminUser.email || req.adminUser.id;
    await t.save();
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete reply template error:', err);
    res.status(500).json({ error: 'Failed to delete the template.' });
  }
});

router.post('/:id/used', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid template.' });
    await ReplyTemplate.updateOne({ _id: req.params.id, office: officeOf(req) }, { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
