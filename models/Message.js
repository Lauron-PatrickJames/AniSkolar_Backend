const mongoose = require('mongoose');

// Messages with the AdSO: one conversation per student (by studentNumber)
// and one per duty office (by office; its head writes from the office
// portal). Either side may attach JPG,
// PNG or PDF files (stored like application documents, utils/gridfs.js)
// and mention one of the student's applications. readAt is when the
// recipient opened the conversation. See routes/messages.js.

const attachmentSchema = new mongoose.Schema({
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
}, { _id: false });

const messageSchema = new mongoose.Schema({
  // Exactly one of studentNumber / office.
  studentNumber: { type: String, index: true },
  office: { type: String, trim: true, maxlength: 200, index: true },
  from: { type: String, enum: ['student', 'adso', 'office'], required: true },
  authorEmail: String,
  authorName: String,
  body: { type: String, trim: true, maxlength: 4000, default: '' },
  attachments: { type: [attachmentSchema], default: [] },
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
  applicationRef: String,          // its reference code, for display
  readAt: { type: Date, default: null },
}, { timestamps: true });

messageSchema.index({ studentNumber: 1, createdAt: 1 });
messageSchema.index({ from: 1, readAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
