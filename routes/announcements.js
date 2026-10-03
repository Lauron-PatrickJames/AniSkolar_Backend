const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Readable } = require('stream');
const { ObjectId } = require('mongodb');
const Announcement = require('../models/Announcement');
const { requireAdso } = require('../middleware/requireAdmin');
const { announcementImageUpload } = require('../middleware/uploadConfig');
const { getBucket } = require('../utils/gridfs');
const facebook = require('../services/facebook');
const { findScholarship } = require('../data/scholarships');

// Announcements are managed by the AdSO only (requireAdso = requireAdmin +
// office ADSO). POLCA / Alumni admins and students get 403. The published
// feed (GET /feed) and announcement images are readable by anyone.
//
// Mounted at both /api/announcements and /api/admin/announcements (see
// server.js), so the Facebook retry endpoint is also reachable at
// POST /api/admin/announcements/:id/facebook/retry.
//
// Facebook cross-posting: AniSkolar is the source of truth. A post exists
// on the Page while the announcement is published AND fbEnabled ("Also post
// to Facebook"). Every write saves to MongoDB first, then syncs Facebook; a
// Facebook failure never loses the admin's content — the announcement is
// kept with fbStatus 'failed' and fbError, and can be retried.

// --- Helpers --------------------------------------------------------------

// '' or null clears the link; anything else must be a known scholarship.
// Returns { value } or { error }.
function parseScholarshipId(value) {
  if (value === null || value === '' || value === 'null') return { value: null };
  if (typeof value !== 'string' || !findScholarship(value)) return { error: 'Unknown related scholarship.' };
  return { value };
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// Runs multer for multipart requests (image uploads); JSON bodies pass
// through untouched since express.json() already parsed them.
function withImageUpload(req, res, next) {
  announcementImageUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be under 10MB.'
        : tooMany ? `An announcement can have up to ${Announcement.MAX_IMAGES} images.` : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Image ids to keep on PATCH: a JSON array of file ids, in display order.
// Returns { value } (undefined when not sent) or { error }.
function parseKeepImageIds(value) {
  if (value === undefined) return { value: undefined };
  let ids = value;
  if (typeof value === 'string') {
    try { ids = JSON.parse(value); } catch { return { error: 'Invalid image list.' }; }
  }
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return { error: 'Invalid image list.' };
  return { value: ids };
}

function storeImage(file) {
  return new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(file.originalname, {
      metadata: { kind: 'announcement-image', mimetype: file.mimetype },
    });
    Readable.from(file.buffer).pipe(upload).on('error', reject).on('finish', () => resolve(upload.id));
  });
}

// Stores uploaded files in GridFS, pushing each entry onto `stored` as it
// lands so the caller can clean up if a later one fails.
async function storeImages(files, stored) {
  for (const file of files || []) {
    const fileId = await storeImage(file);
    stored.push({ fileId, filename: file.originalname, mimetype: file.mimetype });
  }
  return stored;
}

// Deletes newly stored images that didn't end up on a saved announcement.
async function discardUnsaved(stored) {
  for (const { fileId } of stored) {
    const saved = await Announcement.exists({ 'images.fileId': fileId }).catch(() => null);
    if (!saved) await deleteImage(fileId);
  }
}

function readImage(fileId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    getBucket()
      .openDownloadStream(fileId)
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function deleteImage(fileId) {
  if (!fileId) return;
  try {
    await getBucket().delete(fileId);
  } catch (err) {
    console.error('Failed to delete announcement image from GridFS:', err.message);
  }
}

// Announcements currently being synced with Facebook, so two overlapping
// requests (double click, two tabs) can't publish the same post twice.
const syncing = new Set();

function facebookFailure(err) {
  if (!(err instanceof facebook.FacebookError)) {
    console.error('Unexpected Facebook sync error:', err);
  }
  return {
    ok: false,
    error: err instanceof facebook.FacebookError ? err.message : 'Something went wrong while updating the Facebook post. Retry in a moment.',
    tokenExpired: err instanceof facebook.FacebookError && err.isTokenError,
  };
}

/**
 * Brings the Facebook post in line with the announcement and records the
 * outcome on the document (not saved here). Returns null when Facebook
 * wasn't involved, otherwise { ok, error?, tokenExpired? }.
 */
async function syncFacebook(doc) {
  const shouldExist = doc.status === 'published' && doc.fbEnabled;

  if (!shouldExist && !doc.fbPostId) {
    const changed = doc.fbStatus !== 'not_posted';
    doc.fbStatus = 'not_posted';
    doc.fbError = null;
    return changed ? { ok: true } : null;
  }

  try {
    if (!shouldExist) {
      // Unpublished, or "Also post to Facebook" turned off: take it down.
      await facebook.deletePost(doc.fbPostId);
      doc.fbPostId = null;
      doc.fbPermalink = null;
      doc.fbMessage = null;
      doc.fbImageFileIds = [];
      doc.fbStatus = 'not_posted';
    } else {
      const message = facebook.composeMessage(doc);
      const imageIds = doc.images.map(img => String(img.fileId)).join(',');
      const postedImageIds = (doc.fbImageFileIds || []).map(String).join(',');

      if (doc.fbPostId && imageIds === postedImageIds) {
        // Same images (or none): edit the text in place, only if it changed.
        if (doc.fbMessage !== message) await facebook.updatePost(doc.fbPostId, message);
      } else {
        // New post, or the images changed — Facebook can't swap a photo
        // post's images, so the old post is deleted and a new one created.
        if (doc.fbPostId) {
          await facebook.deletePost(doc.fbPostId);
          doc.fbPostId = null;
          doc.fbPermalink = null;
        }
        const images = [];
        for (const img of doc.images) {
          images.push({ buffer: await readImage(img.fileId), filename: img.filename || 'image.jpg', mimetype: img.mimetype || 'image/jpeg' });
        }
        const { postId, permalink } = await facebook.publishPost({ message, images });
        doc.fbPostId = postId;
        doc.fbPermalink = permalink;
        doc.fbImageFileIds = doc.images.map(img => img.fileId);
      }
      doc.fbMessage = message;
      doc.fbStatus = 'posted';
    }
    doc.fbError = null;
    doc.fbLastSyncedAt = new Date();
    return { ok: true };
  } catch (err) {
    const result = facebookFailure(err);
    doc.fbStatus = 'failed';
    doc.fbError = result.error;
    doc.fbLastSyncedAt = new Date();
    return result;
  }
}

// Saves, syncs Facebook, saves the Facebook outcome. Returns the sync
// result for the response.
async function saveAndSync(doc) {
  await doc.save();
  const id = String(doc._id);
  if (syncing.has(id)) {
    // Another request is mid-sync for this announcement. Mark this change
    // as not yet on Facebook so it can be retried instead of double-posting.
    const error = 'Another update to this announcement was still being sent to Facebook. Retry to sync this change.';
    doc.fbStatus = 'failed';
    doc.fbError = error;
    await doc.save();
    return { ok: false, error };
  }
  syncing.add(id);
  try {
    const result = await syncFacebook(doc);
    if (result) await doc.save();
    return result;
  } finally {
    syncing.delete(id);
  }
}

function sendSaved(res, statusCode, doc, facebookResult) {
  res.status(statusCode).json({ announcement: doc.toClientShape(), facebook: facebookResult });
}

function validationMessage(err) {
  if (err?.name === 'ValidationError') {
    return Object.values(err.errors).map(e => e.message).join(' ');
  }
  return null;
}

// --- Routes -----------------------------------------------------------------

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
// Student-facing feed: published only, pinned first, newest first. Shaped
// like the frontend Announcement type, plus imageUrl and fbPermalink.
router.get('/feed', async (req, res) => {
  try {
    const docs = await Announcement.find({ status: 'published' }).sort({ isPinned: -1, publishedAt: -1 });
    res.json({ announcements: docs.map(d => d.toFeedShape()) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load announcements.' });
  }
});

// Streams one of an announcement's images; fileId null means the first.
async function sendImage(req, res, fileId) {
  try {
    const objectId = toObjectId(req.params.id);
    if (!objectId) return res.status(400).json({ error: 'Invalid announcement id.' });
    const doc = await Announcement.findById(objectId).select('images imageFileId imageFilename imageMimetype');
    const image = fileId ? doc?.images.find(img => String(img.fileId) === fileId) : doc?.images[0];
    if (!image) return res.status(404).json({ error: 'Image not found.' });
    res.set('Content-Type', image.mimetype || 'image/jpeg');
    // Each file id's bytes never change, so the URL can be cached for long.
    res.set('Cache-Control', fileId ? 'public, max-age=86400, immutable' : 'public, max-age=300');
    getBucket()
      .openDownloadStream(image.fileId)
      .on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Image not found.' }); else res.end(); })
      .pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load image.' });
  }
}

// GET /api/announcements/:id/images/:fileId — one of the announcement's images.
router.get('/:id/images/:fileId', (req, res) => sendImage(req, res, req.params.fileId));

// GET /api/announcements/:id/image — the first image (pre-multi-image URL).
router.get('/:id/image', (req, res) => sendImage(req, res, null));

// POST /api/announcements
// JSON or multipart (with optional "images" JPGs, up to MAX_IMAGES). Fields: title,
// description, content, category, scholarshipId (related scholarship, optional),
// isPinned, status ('draft' | 'published'),
// fbEnabled ("Also post to Facebook"). Facebook is only posted to when the
// announcement is published.
router.post('/', requireAdso, withImageUpload, async (req, res) => {
  const newImages = [];
  try {
    const { title, description, content, category, status } = req.body;
    if (!title || !description || !content) {
      return res.status(400).json({ error: 'Title, description, and content are required.' });
    }
    const related = req.body.scholarshipId === undefined ? { value: null } : parseScholarshipId(req.body.scholarshipId);
    if (related.error) return res.status(400).json({ error: related.error });
    const willPublish = status === 'published';
    await storeImages(req.files, newImages);

    const doc = new Announcement({
      title,
      description,
      content,
      category: category || 'General',
      scholarshipId: related.value,
      isPinned: parseBool(req.body.isPinned) ?? false,
      status: willPublish ? 'published' : 'draft',
      publishedAt: willPublish ? new Date() : null,
      createdBy: req.adminUser.email || req.adminUser.id,
      fbEnabled: parseBool(req.body.fbEnabled) ?? false,
      images: newImages,
    });

    const validationError = await doc.validate().then(() => null, err => err);
    if (validationError) {
      await discardUnsaved(newImages);
      return res.status(400).json({ error: validationMessage(validationError) });
    }

    const facebookResult = await saveAndSync(doc);
    sendSaved(res, 201, doc, facebookResult);
  } catch (err) {
    console.error('Create announcement error:', err);
    await discardUnsaved(newImages);
    res.status(500).json({ error: 'Failed to create announcement.' });
  }
});

// PATCH /api/announcements/:id
// Partial update (JSON or multipart). Besides the POST fields it accepts
// keepImageIds (JSON array of existing image ids to keep, in order; omitted
// keeps them all) and new "images" files, which are added after the kept
// ones. Draft -> published stamps publishedAt. The Facebook post follows:
// text edits update it, changed images recreate it, unpublishing or turning
// fbEnabled off deletes it.
router.patch('/:id', requireAdso, withImageUpload, async (req, res) => {
  const newImages = [];
  try {
    const objectId = toObjectId(req.params.id);
    if (!objectId) return res.status(400).json({ error: 'Invalid announcement id.' });
    const existing = await Announcement.findById(objectId);
    if (!existing) return res.status(404).json({ error: 'Announcement not found.' });

    const { title, description, content, category, status } = req.body;
    if (title !== undefined) existing.title = title;
    if (description !== undefined) existing.description = description;
    if (content !== undefined) existing.content = content;
    if (category !== undefined) existing.category = category;
    if (req.body.scholarshipId !== undefined) {
      const related = parseScholarshipId(req.body.scholarshipId);
      if (related.error) return res.status(400).json({ error: related.error });
      existing.scholarshipId = related.value;
    }
    const isPinned = parseBool(req.body.isPinned);
    if (isPinned !== undefined) existing.isPinned = isPinned;
    const fbEnabled = parseBool(req.body.fbEnabled);
    if (fbEnabled !== undefined) existing.fbEnabled = fbEnabled;

    if (status !== undefined && status !== existing.status) {
      existing.status = status;
      if (status === 'published' && !existing.publishedAt) {
        existing.publishedAt = new Date();
      }
    }

    const keep = parseKeepImageIds(req.body.keepImageIds);
    if (keep.error) return res.status(400).json({ error: keep.error });
    const oldImages = existing.images.map(img => img.toObject());
    if (keep.value !== undefined || req.files?.length) {
      const kept = keep.value === undefined
        ? oldImages
        : keep.value.map(id => oldImages.find(img => String(img.fileId) === id)).filter(Boolean);
      if (kept.length + (req.files?.length || 0) > Announcement.MAX_IMAGES) {
        return res.status(400).json({ error: `An announcement can have up to ${Announcement.MAX_IMAGES} images.` });
      }
      await storeImages(req.files, newImages);
      existing.images = [...kept, ...newImages];
    }

    const validationError = await existing.validate().then(() => null, err => err);
    if (validationError) {
      await discardUnsaved(newImages);
      return res.status(400).json({ error: validationMessage(validationError) });
    }

    const facebookResult = await saveAndSync(existing);
    const remaining = new Set(existing.images.map(img => String(img.fileId)));
    for (const img of oldImages) {
      if (!remaining.has(String(img.fileId))) await deleteImage(img.fileId);
    }
    sendSaved(res, 200, existing, facebookResult);
  } catch (err) {
    console.error('Update announcement error:', err);
    await discardUnsaved(newImages);
    res.status(500).json({ error: 'Failed to update announcement.' });
  }
});

// POST /api/announcements/:id/facebook/retry
// (also /api/admin/announcements/:id/facebook/retry)
// Retries a failed Facebook publish, edit or delete.
router.post('/:id/facebook/retry', requireAdso, async (req, res) => {
  try {
    const objectId = toObjectId(req.params.id);
    if (!objectId) return res.status(400).json({ error: 'Invalid announcement id.' });
    const doc = await Announcement.findById(objectId);
    if (!doc) return res.status(404).json({ error: 'Announcement not found.' });
    if (doc.fbStatus !== 'failed') {
      return res.status(400).json({ error: 'There is no failed Facebook update to retry for this announcement.' });
    }
    const facebookResult = await saveAndSync(doc);
    sendSaved(res, 200, doc, facebookResult);
  } catch (err) {
    console.error('Retry Facebook post error:', err);
    res.status(500).json({ error: 'Failed to retry the Facebook post.' });
  }
});

// DELETE /api/announcements/:id
// Deletes the announcement, its images, and its Facebook post. If Facebook
// can't delete the post, the announcement is still deleted and the
// response carries facebookWarning so the admin can remove it by hand.
router.delete('/:id', requireAdso, async (req, res) => {
  try {
    const objectId = toObjectId(req.params.id);
    if (!objectId) return res.status(400).json({ error: 'Invalid announcement id.' });
    const doc = await Announcement.findById(objectId);
    if (!doc) return res.status(404).json({ error: 'Announcement not found.' });

    let facebookWarning = null;
    if (doc.fbPostId) {
      try {
        await facebook.deletePost(doc.fbPostId);
      } catch (err) {
        const { error } = facebookFailure(err);
        facebookWarning = `The announcement was deleted, but its Facebook post couldn't be removed: ${error} Remove it on the Page (${doc.fbPermalink}).`;
      }
    }

    await doc.deleteOne();
    for (const img of doc.images) await deleteImage(img.fileId);
    res.json({ success: true, facebookWarning });
  } catch (err) {
    console.error('Delete announcement error:', err);
    res.status(500).json({ error: 'Failed to delete announcement.' });
  }
});

module.exports = router;
