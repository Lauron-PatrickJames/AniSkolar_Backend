const mongoose = require('mongoose');

// Something an admin deleted, kept for 30 days so it can be restored
// (utils/trash.js, routes/trash.js). The item is removed from its own
// collection and a full copy kept here, so the rest of the app never sees
// deleted items. Its files (announcement images, attendance sheets) are
// kept until it's deleted for good; so is an announcement's Facebook post.
//
//   kind      announcement | dutyEvent | attendanceSheet | fseReport |
//             scholarship | replyTemplate | student (utils/studentDelete.js:
//             the profile in data, its linked records in extra)
//   office    whose Trash it's in (an office code; the AdSO sees all)
//   data      the item as it was (restored as is, same id)
//   extra     what else the delete changed, to put back on restore
//             (e.g. scholars' pending claims for a deleted event)
//   files     file ids deleted with it for good
//   purgeAt   when it's deleted for good

const trashItemSchema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ['announcement', 'dutyEvent', 'attendanceSheet', 'fseReport', 'scholarship', 'replyTemplate', 'student'] },
  title: { type: String, required: true, maxlength: 300 },
  office: { type: String, required: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  extra: { type: mongoose.Schema.Types.Mixed },
  files: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  deletedAt: { type: Date, required: true, default: Date.now },
  deletedBy: String,
  deletedByName: String,
  purgeAt: { type: Date, required: true, index: true },
}, { minimize: false });

trashItemSchema.index({ office: 1, deletedAt: -1 });

module.exports = mongoose.model('TrashItem', trashItemSchema);
