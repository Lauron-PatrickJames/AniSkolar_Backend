const express = require('express');
const router = express.Router();
const { getAuth } = require('@clerk/express');
const Student = require('../models/Student');
const ApplicationDraft = require('../models/ApplicationDraft');
const { findScholarship } = require('../data/scholarships');
const { isGrantFormType } = require('../utils/grantForms');

// Saved-for-later drafts of grant applications (POLCA / Alumni). Every
// route resolves the caller's Student record from their Clerk session, so
// a student can only ever read or write their own drafts.
//
//   GET    /api/application-drafts/:scholarshipId   -> { draft: { data, updatedAt } | null }
//   PUT    /api/application-drafts/:scholarshipId   body { data } -> { draft }
//   DELETE /api/application-drafts/:scholarshipId

async function resolveContext(req, res) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated.' });
    return null;
  }
  const scholarship = findScholarship(req.params.scholarshipId);
  if (!scholarship || !isGrantFormType(scholarship.formType)) {
    res.status(404).json({ error: 'Drafts are not available for this scholarship.' });
    return null;
  }
  const student = await Student.findOne({ clerkId: userId }).select('studentNumber');
  if (!student) {
    res.status(404).json({ error: 'Profile not yet completed.' });
    return null;
  }
  return { clerkId: userId, studentNumber: student.studentNumber, scholarshipId: scholarship.id };
}

function toResponse(draft) {
  return draft ? { data: draft.data, updatedAt: draft.updatedAt } : null;
}

router.get('/:scholarshipId', async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;
    const draft = await ApplicationDraft.findOne({ clerkId: ctx.clerkId, scholarshipId: ctx.scholarshipId });
    res.json({ draft: toResponse(draft) });
  } catch (err) {
    console.error('Fetch draft error:', err);
    res.status(500).json({ error: 'Failed to load draft.' });
  }
});

router.put('/:scholarshipId', async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;
    const { data } = req.body || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Draft data must be an object.' });
    }
    const draft = await ApplicationDraft.findOneAndUpdate(
      { clerkId: ctx.clerkId, scholarshipId: ctx.scholarshipId },
      { $set: { data, studentNumber: ctx.studentNumber } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    res.json({ draft: toResponse(draft) });
  } catch (err) {
    console.error('Save draft error:', err);
    res.status(500).json({ error: 'Failed to save draft.' });
  }
});

router.delete('/:scholarshipId', async (req, res) => {
  try {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;
    await ApplicationDraft.deleteOne({ clerkId: ctx.clerkId, scholarshipId: ctx.scholarshipId });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete draft error:', err);
    res.status(500).json({ error: 'Failed to delete draft.' });
  }
});

module.exports = router;
