const mongoose = require('mongoose');

// The AdSO's own state for a conversation in their Messages inbox: pinned,
// archived, marked unread, or deleted. Students and office heads never see
// it (their copy and the "Seen" receipts stay as they are). One per
// conversation: a student's (key = student number) or a duty office's
// (key = the office name as stored on Message.office). See routes/messages.js.

const messageThreadSchema = new mongoose.Schema({
  kind: { type: String, enum: ['student', 'office'], required: true },
  key: { type: String, required: true },
  pinnedAt: { type: Date, default: null },
  // Archived until the student or office writes again.
  archivedAt: { type: Date, default: null },
  // Shown as unread until the AdSO opens it again.
  markedUnread: { type: Boolean, default: false },
  // Deleted: messages up to this time are hidden from the AdSO. A new
  // message brings the conversation back with only what came after.
  clearedAt: { type: Date, default: null },
}, { timestamps: true });

messageThreadSchema.index({ kind: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('MessageThread', messageThreadSchema);
