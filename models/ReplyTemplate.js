const mongoose = require('mongoose');

// Saved replies: messages the office sends often (decision messages,
// common answers), shared by everyone in the office. {firstName},
// {scholarship}, {referenceCode} and {term} are filled in when inserted;
// [brackets] are for the person to fill in. See routes/replyTemplates.js.

const CONTEXTS = ['application', 'renewal', 'message'];
const DECISIONS = ['Approved', 'Rejected', 'Needs Revision', 'Renewed', 'Not Renewed'];

const replyTemplateSchema = new mongoose.Schema({
  office: { type: String, enum: ['LSO', 'POLCA', 'ALUMNI'], required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 80 },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
  context: { type: String, enum: CONTEXTS, required: true },
  // Which decision it's for (applications and renewals); unset = any.
  decision: { type: String, enum: DECISIONS },
  usedCount: { type: Number, default: 0 },
  lastUsedAt: Date,
  // Deleted ones are kept so the starter set isn't added again.
  deletedAt: Date,
  starter: Boolean,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

module.exports = mongoose.model('ReplyTemplate', replyTemplateSchema);
module.exports.CONTEXTS = CONTEXTS;
module.exports.DECISIONS = DECISIONS;
