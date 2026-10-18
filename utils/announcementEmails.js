const Announcement = require('../models/Announcement');
const { sendMail, mailEnabled } = require('./mailer');
const { recipientEmails, targetOf } = require('./emailTarget');
const { readFile } = require('./gridfs');
const { renderEmail } = require('./emailTemplate');

// Phone photos can be 5–10 MB; emails have a size limit, and the email only
// needs a screen-sized copy. The first image is the "poster": resized to at
// most 1200 px wide, JPEG (PNG kept as PNG when small, e.g. a poster with
// text). The next 4 become 2×2 thumbnails, cropped to the same shape; any
// beyond that are "+N more photos" with a link. So the email stays about
// the same length however many photos the post has. The stored originals
// (AniSkolar, Facebook) aren't touched.
const MAX_THUMBS = 4;
const MAX_EMAIL_IMAGES_BYTES = 6 * 1024 * 1024;
async function emailCopy(buffer, mimetype, { thumb = false } = {}) {
  const sharp = require('sharp');
  const resized = sharp(buffer, { failOn: 'none' }).rotate().resize(
    thumb ? { width: 560, height: 420, fit: 'cover' } : { width: 1200, withoutEnlargement: true }
  );
  if (thumb) return { buffer: await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 75, mozjpeg: true }).toBuffer(), contentType: 'image/jpeg', ext: 'jpg' };
  if (mimetype === 'image/png') {
    const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= 1024 * 1024) return { buffer: png, contentType: 'image/png', ext: 'png' };
  }
  return { buffer: await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer(), contentType: 'image/jpeg', ext: 'jpg' };
}

// The announcement's images for the email: { inline (attachments), hero
// (contentId or null), thumbs (contentIds), more (how many aren't shown) }.
// One that can't be read is skipped, not the rest.
async function emailImages(doc) {
  const inline = [];
  let hero = null;
  const thumbs = [];
  let total = 0;
  const images = doc.images || [];
  let used = 0;
  for (const img of images) {
    if (hero && thumbs.length >= MAX_THUMBS) break;
    used++;
    try {
      const original = await readFile(img.fileId);
      if (!original) continue;
      const copy = await emailCopy(original, img.mimetype, { thumb: !!hero });
      if (total + copy.buffer.length > MAX_EMAIL_IMAGES_BYTES) continue;
      total += copy.buffer.length;
      const contentId = `image${inline.length + 1}`;
      const base = (img.filename || contentId).replace(/\.[^.]+$/, '');
      inline.push({ contentId, name: `${base}.${copy.ext}`, contentType: copy.contentType, buffer: copy.buffer });
      if (!hero) hero = contentId; else thumbs.push(contentId);
    } catch (err) {
      console.error(`Announcement ${doc._id}: image ${img.fileId} left out of the email:`, err.message);
    }
  }
  return { inline, hero, thumbs, more: images.length - used };
}

// Emails a published announcement to students' Outlook (school email) when
// the AdSO ticked "Also email students". Sent once per announcement — edits
// after it went out don't resend. Recipients get it in BCC batches of 50,
// a few batches a minute (ANNOUNCEMENT_EMAIL_BATCHES_PER_MINUTE, default 2),
// because the email service limits how many it sends per minute and hour.
// processEmailQueue() runs every minute from server.js and right after an
// announcement is published; it picks up where it stopped.
//
// Who gets it: emailTarget (utils/emailTarget.js) — all students,
// applicants or scholars of chosen scholarships, or specific students,
// narrowed by college and year level. emailStatus: not_sent → queued →
// (sending) → sent | failed.

const BATCH_SIZE = 50;
const batchesPerRun = () => Math.max(1, Number(process.env.ANNOUNCEMENT_EMAIL_BATCHES_PER_MINUTE) || 2);
const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';

function recipientsFor(doc) {
  return recipientEmails(targetOf(doc));
}

// After an announcement is saved: queue its email when it's published with
// email on and not sent yet; un-queue it if email was turned off before it
// started. Returns true when the document changed (caller saves).
function updateEmailQueue(doc) {
  if (doc.status === 'published' && doc.emailEnabled && doc.emailStatus === 'not_sent') {
    doc.emailStatus = 'queued';
    doc.emailQueuedAt = new Date();
    doc.emailError = null;
    return true;
  }
  if (!doc.emailEnabled && doc.emailStatus === 'queued' && !doc.emailSent) {
    doc.emailStatus = 'not_sent';
    doc.emailQueuedAt = null;
    return true;
  }
  return false;
}

let running = false;
async function processEmailQueue() {
  if (running) return;
  running = true;
  try {
    let batchesLeft = batchesPerRun();
    while (batchesLeft > 0) {
      // Claim one announcement (a stuck "sending" one after 10 minutes).
      const doc = await Announcement.findOneAndUpdate(
        { $or: [{ emailStatus: 'queued' }, { emailStatus: 'sending', emailLockedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }] },
        { $set: { emailStatus: 'sending', emailLockedAt: new Date() } },
        { sort: { emailQueuedAt: 1 }, returnDocument: 'after' }
      );
      if (!doc) return;
      if (!mailEnabled()) {
        await Announcement.updateOne({ _id: doc._id }, { $set: { emailStatus: 'failed', emailError: "Email isn't set up on the server yet (ACS_EMAIL_CONNECTION_STRING / ACS_EMAIL_SENDER)." } });
        continue;
      }
      try {
        const recipients = await recipientsFor(doc);
        let sent = doc.emailSent || 0;
        const subject = `AniSkolar: ${doc.title}`;
        const gallery = await emailImages(doc);
        const inlineImages = gallery.inline;
        const { html, text } = renderEmail({
          heading: doc.title,
          intro: doc.description,
          body: doc.content,
          gallery: { hero: gallery.hero, thumbs: gallery.thumbs, more: gallery.more },
          button: { url: appUrl(), label: 'View on AniSkolar' },
        });
        while (sent < recipients.length && batchesLeft > 0) {
          const batch = recipients.slice(sent, sent + BATCH_SIZE);
          const ok = await sendMail({ to: process.env.ACS_EMAIL_SENDER, bcc: batch, subject, text, html, inlineImages, wait: true });
          if (!ok) throw new Error('The email service refused the message. Check the server log.');
          sent += batch.length;
          batchesLeft--;
          await Announcement.updateOne({ _id: doc._id }, { $set: { emailSent: sent, emailTotal: recipients.length, emailLockedAt: new Date() } });
        }
        const done = sent >= recipients.length;
        await Announcement.updateOne({ _id: doc._id }, {
          $set: done
            ? { emailStatus: 'sent', emailSentAt: new Date(), emailTotal: recipients.length, emailSent: sent }
            : { emailStatus: 'queued', emailTotal: recipients.length },
        });
        if (!done) return; // the rest next minute
      } catch (err) {
        await Announcement.updateOne({ _id: doc._id }, { $set: { emailStatus: 'failed', emailError: err.message } });
      }
    }
  } finally {
    running = false;
  }
}

module.exports = { updateEmailQueue, processEmailQueue, recipientsFor, emailImages };
