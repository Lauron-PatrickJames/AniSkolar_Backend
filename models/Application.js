const mongoose = require('mongoose');

// One entry per uploaded document (built in routes/applications.js when
// streaming files into GridFS) — fileId points at the GridFS file, docType
// is the label the frontend supplied (e.g. "Application Letter", "Indigency").
const documentSchema = new mongoose.Schema({
  docType: String,
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
}, { _id: false });

// One entry per lifecycle event on an application. 'Submitted' and
// 'Resubmitted' are student-originated (pushed from POST / and PATCH /:id
// in routes/applications.js); the four review-status values are
// admin-originated (pushed from PATCH /:id/status). changedBy is either
// 'student' or the admin's email (req.adminUser.email, same value stored
// in reviewedBy) — kept as a plain string rather than a ref since the
// student side has no separate admin-style user record to point at.
const historyEntrySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['Submitted', 'Resubmitted', 'Under Evaluation', 'Approved', 'Rejected', 'Needs Revision'],
    required: true,
  },
  note: String,
  changedBy: String,
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

const applicationSchema = new mongoose.Schema({
  // Taken from the authenticated Student record server-side, never from
  // req.body directly — see routes/applications.js.
  studentNumber: { type: String, required: true, index: true },

  scholarshipId: { type: String, required: true },
  // Derived server-side from the scholarship registry (findScholarship),
  // not trusted from the client.
  scholarshipName: { type: String, required: true },

  applicationFormType: { type: String, enum: ['standard', 'sfag'], default: 'standard' },

  documents: { type: [documentSchema], default: [] },

  referenceCode: { type: String, required: true, unique: true },

  // Populated only when applicationFormType === 'standard'.
  standardInfo: { type: mongoose.Schema.Types.Mixed },

  // Populated only when applicationFormType === 'sfag'.
  personalInfo: { type: mongoose.Schema.Types.Mixed },
  contactSchool: { type: mongoose.Schema.Types.Mixed },
  parentsGuardian: { type: mongoose.Schema.Types.Mixed },
  siblings: { type: [mongoose.Schema.Types.Mixed], default: [] },
  assetsExpenses: { type: mongoose.Schema.Types.Mixed },
  agreement: { type: mongoose.Schema.Types.Mixed },

  status: {
    type: String,
    enum: ['Under Evaluation', 'Approved', 'Rejected', 'Needs Revision'],
    default: 'Under Evaluation',
  },
  // Set by the admin-only PATCH /api/applications/:id/status route.
  reviewNote: String,
  reviewedBy: String,   // admin's email, from Clerk (see requireAdmin)
  reviewedAt: Date,

  // Full lifecycle log — submission, resubmissions, and every review
  // decision, oldest first. Populated server-side only (see
  // routes/applications.js); never accepted from req.body. Applications
  // created before this field existed will simply have an empty/missing
  // array — consumers (e.g. AdminAnalytics, ApplicationTimeline) already
  // handle that by falling back to current status.
  history: { type: [historyEntrySchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Application', applicationSchema);