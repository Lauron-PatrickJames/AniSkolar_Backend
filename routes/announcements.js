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
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'The image must be under 10MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

function storeImage(file) {
  return new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(file.originalname, {
      metadata: { kind: 'announcement-image', mimetype: file.mimetype },
    });
    Readable.from(file.buffer).pipe(upload).on('error', reject).on('finish', () => resolve(upload.id));
  });
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
      doc.fbImageFileId = null;
      doc.fbStatus = 'not_posted';
    } else {
      const message = facebook.composeMessage(doc);
      const imageId = doc.imageFileId ? String(doc.imageFileId) : null;
      const postedImageId = doc.fbImageFileId ? String(doc.fbImageFileId) : null;

      if (doc.fbPostId && imageId === postedImageId) {
        // Same image (or none): edit the text in place, only if it changed.
        if (doc.fbMessage !== message) await facebook.updatePost(doc.fbPostId, message);
      } else {
        // New post, or the image changed — Facebook can't swap a photo
        // post's image, so the old post is deleted and a new one created.
        if (doc.fbPostId) {
          await facebook.deletePost(doc.fbPostId);
          doc.fbPostId = null;
          doc.fbPermalink = null;
        }
        const image = doc.imageFileId
          ? { buffer: await readImage(doc.imageFileId), filename: doc.imageFilename || 'image.jpg', mimetype: doc.imageMimetype || 'image/jpeg' }
          : undefined;
        const { postId, permalink } = await facebook.publishPost({ message, image });
        doc.fbPostId = postId;
        doc.fbPermalink = permalink;
        doc.fbImageFileId = doc.imageFileId || null;
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

// GET /api/announcements/:id/image — the announcement's image, if any.
router.get('/:id/image', async (req, res) => {
  try {
    const objectId = toObjectId(req.params.id);
    if (!objectId) return res.status(400).json({ error: 'Invalid announcement id.' });
    const doc = await Announcement.findById(objectId).select('imageFileId imageMimetype');
    if (!doc?.imageFileId) return res.status(404).json({ error: 'Image not found.' });
    res.set('Content-Type', doc.imageMimetype || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    getBucket()
      .openDownloadStream(doc.imageFileId)
      .on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Image not found.' }); else res.end(); })
      .pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load image.' });
  }
});

// POST /api/announcements
// JSON or multipart (with an optional "image" JPG). Fields: title,
// description, content, category, isPinned, status ('draft' | 'published'),
// fbEnabled ("Also post to Facebook"). Facebook is only posted to when the
// announcement is published.
router.post('/', requireAdso, withImageUpload, async (req, res) => {
  let newImageId = null;
  try {
    const { title, description, content, category, status } = req.body;
    if (!title || !description || !content) {
      return res.status(400).json({ error: 'Title, description, and content are required.' });
    }
    const willPublish = status === 'published';
    if (req.file) newImageId = await storeImage(req.file);

    const doc = new Announcement({
      title,
      description,
      content,
      category: category || 'General',
      isPinned: parseBool(req.body.isPinned) ?? false,
      status: willPublish ? 'published' : 'draft',
      publishedAt: willPublish ? new Date() : null,
      createdBy: req.adminUser.email || req.adminUser.id,
      fbEnabled: parseBool(req.body.fbEnabled) ?? false,
      imageFileId: newImageId,
      imageFilename: req.file?.originalname,
      imageMimetype: req.file?.mimetype,
    });

    const validationError = await doc.validate().then(() => null, err => err);
    if (validationError) {
      await deleteImage(newImageId);
      return res.status(400).json({ error: validationMessage(validationError) });
    }

    const facebookResult = await saveAndSync(doc);
    sendSaved(res, 201, doc, facebookResult);
  } catch (err) {
    console.error('Create announcement error:', err);
    if (newImageId) {
      const saved = await Announcement.exists({ imageFileId: newImageId }).catch(() => null);
      if (!saved) await deleteImage(newImageId);
    }
    res.status(500).json({ error: 'Failed to create announcement.' });
  }
});

// PATCH /api/announcements/:id
// Partial update (JSON or multipart). Besides the POST fields it accepts a
// new "image" file or removeImage=true. Draft -> published stamps
// publishedAt. The Facebook post follows: text edits update it, a changed
// image recreates it, unpublishing or turning fbEnabled off deletes it.
router.patch('/:id', requireAdso, withImageUpload, async (req, res) => {
  let newImageId = null;
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

    const oldImageId = existing.imageFileId;
    if (req.file) {
      newImageId = await storeImage(req.file);
      existing.imageFileId = newImageId;
      existing.imageFilename = req.file.originalname;
      existing.imageMimetype = req.file.mimetype;
    } else if (parseBool(req.body.removeImage)) {
      existing.imageFileId = null;
      existing.imageFilename = undefined;
      existing.imageMimetype = undefined;
    }

    const validationError = await existing.validate().then(() => null, err => err);
    if (validationError) {
      await deleteImage(newImageId);
      return res.status(400).json({ error: validationMessage(validationError) });
    }

    const facebookResult = await saveAndSync(existing);
    if (oldImageId && String(oldImageId) !== String(existing.imageFileId || '')) {
      await deleteImage(oldImageId);
    }
    sendSaved(res, 200, existing, facebookResult);
  } catch (err) {
    console.error('Update announcement error:', err);
    if (newImageId) {
      const saved = await Announcement.exists({ imageFileId: newImageId }).catch(() => null);
      if (!saved) await deleteImage(newImageId);
    }
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
// Deletes the announcement, its image, and its Facebook post. If Facebook
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
    await deleteImage(doc.imageFileId);
    res.json({ success: true, facebookWarning });
  } catch (err) {
    console.error('Delete announcement error:', err);
    res.status(500).json({ error: 'Failed to delete announcement.' });
  }
});

module.exports = router;
