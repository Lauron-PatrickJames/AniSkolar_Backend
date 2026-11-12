// Trash: deleting an announcement, duty event, attendance sheet, FSE
// report, created scholarship or message template moves it here
// (models/TrashItem.js). It can be restored for 30 days, then it's deleted
// for good with its files (and an announcement's Facebook post).

const TrashItem = require('../models/TrashItem');

const KEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const modelOf = kind => ({
  announcement: () => require('../models/Announcement'),
  dutyEvent: () => require('../models/DutyEvent'),
  fseReport: () => require('../models/FseReport'),
  scholarship: () => require('../models/ScholarshipSetting'),
  replyTemplate: () => require('../models/ReplyTemplate'),
})[kind]?.();

// Moves a document into the Trash: a full copy is kept and the original
// removed. `doc` is a mongoose document or a plain object with _id.
// Returns the trash item.
async function moveToTrash({ kind, doc, title, office, files = [], extra, by }) {
  const data = typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : doc;
  const now = new Date();
  const item = await TrashItem.create({
    kind, title: String(title || 'Untitled').slice(0, 300), office: office || 'LSO', data, extra,
    files: files.filter(Boolean),
    deletedAt: now, deletedBy: by?.email || by?.id, deletedByName: by?.name,
    purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY),
  });
  const Model = modelOf(kind);
  // Message templates stay as hidden records (deletedAt): an office whose
  // templates are all gone would otherwise get the starter set again.
  if (kind === 'replyTemplate') await Model.updateOne({ _id: data._id }, { $set: { deletedAt: now } });
  else if (Model) await Model.deleteOne({ _id: data._id });
  return item;
}

// Puts an item back where it was. { error, status } when it can't be.
async function restore(item) {
  const data = { ...item.data };
  if (item.kind === 'attendanceSheet') {
    const DutyEvent = require('../models/DutyEvent');
    const event = await DutyEvent.findById(item.extra?.eventId);
    if (!event) return { error: 'Its event is gone. Restore the event first.', status: 409 };
    if (!event.sheets.some(s => String(s.fileId) === String(data.fileId))) {
      event.sheets.push(data);
      await event.save();
    }
  } else if (item.kind === 'replyTemplate') {
    await modelOf('replyTemplate').updateOne({ _id: data._id }, { $set: { deletedAt: null } });
  } else {
    const Model = modelOf(item.kind);
    // A scheduled announcement whose time passed while in the Trash comes
    // back as a draft instead of publishing right away.
    if (item.kind === 'announcement' && data.status === 'scheduled' && data.scheduledFor && new Date(data.scheduledFor) <= new Date()) {
      data.status = 'draft';
      data.scheduledFor = null;
    }
    try {
      await Model.collection.insertOne(data);
    } catch (err) {
      if (err?.code === 11000) {
        return { error: item.kind === 'fseReport' ? 'A report for this term was saved after this one was deleted. Delete that one first.' : 'Something with the same name or id exists now.', status: 409 };
      }
      throw err;
    }
    // Scholars' pending claims for a deleted event come back with it.
    if (item.kind === 'dutyEvent' && Array.isArray(item.extra?.claims)) {
      const DutyLog = require('../models/DutyLog');
      for (const c of item.extra.claims) {
        await DutyLog.updateOne({ _id: c.logId, 'eventClaims.event': { $ne: data._id } }, { $push: { eventClaims: c.claim } });
      }
    }
    if (item.kind === 'scholarship') await require('./customScholarships').load();
  }
  await TrashItem.deleteOne({ _id: item._id });
  return { restored: true };
}

// Deletes an item for good: its files, and an announcement's Facebook post.
async function purge(item) {
  const { deleteFile } = require('./gridfs');
  for (const fileId of item.files || []) {
    await deleteFile(fileId).catch(err => console.error('Trash: failed to delete a file:', err.message));
  }
  if (item.kind === 'announcement' && item.data?.fbPostId) {
    try {
      await require('../services/facebook').deletePost(item.data.fbPostId);
    } catch (err) {
      console.error('Trash: the Facebook post could not be removed:', err.message);
    }
  }
  await TrashItem.deleteOne({ _id: item._id });
}

// Items past their 30 days (run every hour, server.js).
async function purgeExpired(now = new Date()) {
  const due = await TrashItem.find({ purgeAt: { $lte: now } }).limit(200);
  for (const item of due) await purge(item);
  return due.length;
}

module.exports = { moveToTrash, restore, purge, purgeExpired, KEEP_DAYS };
