const mongoose = require('mongoose');

// One entry per uploaded document (built in routes/applications.js when
// streaming files into GridFS) — fileId points at the GridFS file, docType
// is the label the frontend supplied (e.g. "Application Letter", "Indigency").
//
// slotKey/variant are only set by the grant-form flows (POLCA / Alumni):
// slotKey is the stable requirement key from the scholarship's
// documentSlots (one slot can hold several files, e.g. residence
// pictures), and variant records which accepted document type the
// student chose for a multi-type slot (e.g. "Affidavit of Non-filing of ITR").
const documentSchema = new mongoose.Schema({
  docType: String,
  slotKey: String,
  variant: String,
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
}, { _id: false });

// Office-internal fields from the POLCA form's "For POLCA use only" box.
// Written only by the admin PATCH /:id/admin-fields route and stripped
// from every student-facing response (see routes/applications.js).
const adminFieldsSchema = new mongoose.Schema({
  dateReceived: Date,
  receivedBy: String,
  applicantType: { type: String, enum: ['New', 'Old'] },
  gpa: { type: Number, min: 0, max: 5 },
  updatedBy: String,
  updatedAt: Date,
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
    enum: ['Submitted', 'Resubmitted', 'Under Evaluation', 'Approved', 'Rejected', 'Needs Revision', 'Forwarded to LSO'],
    required: true,
  },
  note: String,
  // 'student', 'system' (automatic events such as sending an approved
  // office application to the AdSO), or the admin's email.
  changedBy: String,
  // Admin entries only: display name and office code ('LSO', 'POLCA',
  // 'ALUMNI') at the time of the change, so the history can show
  // "POLCA Office · Maria Santos". Older entries don't have them.
  changedByName: String,
  changedByOffice: String,
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

  // Which scholarship office reviews this application. Derived server-side
  // from the scholarship registry (data/scholarships.js). Applications
  // created before offices existed have no value and are treated as 'LSO'.
  office: { type: String, enum: ['LSO', 'POLCA', 'ALUMNI'], default: 'LSO', index: true },

  // 'polca' and 'alumni' are the grant-form flows. They reuse the same
  // section fields as 'sfag' below (personalInfo, contactSchool,
  // parentsGuardian, siblings, assetsExpenses, agreement), just with the
  // section shapes from those scholarships' forms, plus
  // eligibilityAnswers / evaluationSheet.
  applicationFormType: { type: String, enum: ['standard', 'sfag', 'polca', 'alumni'], default: 'standard' },

  documents: { type: [documentSchema], default: [] },

  referenceCode: { type: String, required: true, unique: true },

  // Populated only when applicationFormType === 'standard'.
  standardInfo: { type: mongoose.Schema.Types.Mixed },

  // Populated when applicationFormType is 'sfag', 'polca' or 'alumni'.
  personalInfo: { type: mongoose.Schema.Types.Mixed },
  contactSchool: { type: mongoose.Schema.Types.Mixed },
  parentsGuardian: { type: mongoose.Schema.Types.Mixed },
  siblings: { type: [mongoose.Schema.Types.Mixed], default: [] },
  assetsExpenses: { type: mongoose.Schema.Types.Mixed },
  agreement: { type: mongoose.Schema.Types.Mixed },

  // 'polca': { hsGeneralAverage, lowestHsGrade, notRelatedToBoardMember }
  // 'alumni': { alumnusName, relationship, institution, batchYear }
  // Checked against the scholarship's eligibility rules on submit.
  eligibilityAnswers: { type: mongoose.Schema.Types.Mixed },

  // 'polca' only: the 7-page Financial Aid Grantee Personal Information
  // Sheet (education, family, income/assets, statements).
  evaluationSheet: { type: mongoose.Schema.Types.Mixed },

  adminFields: { type: adminFieldsSchema },

  // Set when a POLCA / Alumni office approves the application, which sends
  // it to the AdSO ('LSO') automatically (PATCH /api/applications/:id/status).
  // Until then the AdSO can't see it; see utils/officeScope.js. Always unset
  // for the AdSO's own applications.
  forwardedAt: { type: Date, default: null },
  forwardedBy: String,          // office admin who approved it
  forwardBatchId: String,       // id of the send (one per approval)

  // Which office recorded the current status ('LSO', 'POLCA', 'ALUMNI').
  // The office's decision stands unless the LSO changes it, so an office
  // application with decisionOffice 'LSO' is an LSO override.
  decisionOffice: String,

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