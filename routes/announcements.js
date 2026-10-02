const express = require('express');
const router = express.Router();
const Announcement = require('../models/Announcement');
const { requireAdso } = require('../middleware/requireAdmin');

// Announcements are managed by the AdSO only (requireAdso: an admin whose
// Clerk office is ADSO). POLCA / Alumni admins and students get 403.
// The published feed (GET /feed) is readable by anyone, for students.

// GET /api/announcements
// Admin view: everything (draft + published), pinned first, newest first.
// Optional ?status=draft|published filter.
router.get('/', requireAdso, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status === 'draft' || req.query.status === 'published') {
      filter.status = req.query.status;
    }
    const docs = await Announcement.find(filter).sort({ isPinned: -1, createdAt: -1 });
    res.json({ announcements: docs.map(d => d.toClientShape()) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load announcements.' });
  }
});

// GET /api/announcements/feed
// Student-facing feed: published only, pinned first, newest first.
// Returns objects shaped exactly like the frontend `Announcement` type
// (id, title, date, description, content, category) — safe to drop
// straight into <Announcements announcements={...} />.
router.get('/feed', async (req, res) => {
  try {
    const docs = await Announcement.find({ status: 'published' }).sort({ isPinned: -1, publishedAt: -1 });
    res.json({ announcements: docs.map(d => d.toClientShape()) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load announcements.' });
  }
});

// POST /api/announcements
// Create a new announcement (draft by default; pass status: 'published' to
// publish immediately).
router.post('/', requireAdso, async (req, res) => {
  try {
    const { title, description, content, category, isPinned, status } = req.body;
    if (!title || !description || !content) {
      return res.status(400).json({ error: 'Title, description, and content are required.' });
    }
    const createdBy = req.adminUser.email || req.adminUser.id;
    const willPublish = status === 'published';
    const doc = await Announcement.create({
      title,
      description,
      content,
      category: category || 'General',
      isPinned: !!isPinned,
      status: willPublish ? 'published' : 'draft',
      publishedAt: willPublish ? new Date() : null,
      createdBy
    });
    res.status(201).json({ announcement: doc.toClientShape() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create announcement.' });
  }
});

// PATCH /api/announcements/:id
// Partial update — edits fields and/or flips status. Draft -> published
// stamps publishedAt if it isn't already set.
router.patch('/:id', requireAdso, async (req, res) => {
  try {
    const existing = await Announcement.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Announcement not found.' });

    const { title, description, content, category, isPinned, status } = req.body;

    if (title !== undefined) existing.title = title;
    if (description !== undefined) existing.description = description;
    if (content !== undefined) existing.content = content;
    if (category !== undefined) existing.category = category;
    if (isPinned !== undefined) existing.isPinned = isPinned;

    if (status !== undefined && status !== existing.status) {
      existing.status = status;
      if (status === 'published' && !existing.publishedAt) {
        existing.publishedAt = new Date();
      }
    }

    await existing.save();
    res.json({ announcement: existing.toClientShape() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update announcement.' });
  }
});

// DELETE /api/announcements/:id
router.delete('/:id', requireAdso, async (req, res) => {
  try {
    const deleted = await Announcement.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Announcement not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete announcement.' });
  }
});

module.exports = router;