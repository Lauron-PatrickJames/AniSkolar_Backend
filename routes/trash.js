const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdmin } = require('../middleware/requireAdmin');
const { scopedOffice } = require('../utils/officeScope');
const TrashItem = require('../models/TrashItem');
const { restore, purge, KEEP_DAYS } = require('../utils/trash');

// The Trash (utils/trash.js): what was deleted in the last 30 days.
// Each office sees its own; the AdSO sees everything.
//   GET    /api/trash               the items, newest first
//   POST   /api/trash/:id/restore   put it back
//   DELETE /api/trash/:id           delete it for good now

const view = item => ({
  id: String(item._id),
  kind: item.kind,
  title: item.title,
  office: item.office,
  deletedAt: item.deletedAt,
  deletedBy: item.deletedByName || item.deletedBy || null,
  purgeAt: item.purgeAt,
});

const scope = req => {
  const office = scopedOffice(req.adminUser);
  return office ? { office } : {};
};

async function findOwn(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'Invalid item.' }); return null; }
  const item = await TrashItem.findOne({ _id: req.params.id, ...scope(req) });
  if (!item) res.status(404).json({ error: 'It’s no longer in the Trash.' });
  return item;
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const items = await TrashItem.find(scope(req)).select('-data -extra').sort({ deletedAt: -1 }).limit(500).lean();
    res.json({ items: items.map(view), keepDays: KEEP_DAYS });
  } catch (err) {
    console.error('Load trash error:', err);
    res.status(500).json({ error: 'Failed to load the Trash.' });
  }
});

router.post('/:id/restore', requireAdmin, async (req, res) => {
  try {
    const item = await findOwn(req, res);
    if (!item) return;
    const result = await restore(item);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ restored: true, kind: item.kind });
  } catch (err) {
    console.error('Restore from trash error:', err);
    res.status(500).json({ error: 'Failed to restore it.' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const item = await findOwn(req, res);
    if (!item) return;
    await purge(item);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete from trash error:', err);
    res.status(500).json({ error: 'Failed to delete it.' });
  }
});

module.exports = router;
