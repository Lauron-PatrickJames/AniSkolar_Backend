const mongoose = require('mongoose');

// A student's in-progress grant application (POLCA / Alumni), saved so the
// long evaluation sheet can be finished across sessions and devices. One
// draft per student per scholarship; deleted when the application is
// submitted (routes/applications.js). Uploaded files are NOT part of a
// draft — only typed answers — so nothing lands in GridFS until submit.
const applicationDraftSchema = new mongoose.Schema({
  // Both taken from the authenticated Student record, never from req.body.
  clerkId: { type: String, required: true },
  studentNumber: { type: String, required: true },
  scholarshipId: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, minimize: false });

applicationDraftSchema.index({ clerkId: 1, scholarshipId: 1 }, { unique: true });
applicationDraftSchema.index({ studentNumber: 1, scholarshipId: 1 });

module.exports = mongoose.model('ApplicationDraft', applicationDraftSchema);
