const mongoose = require('mongoose');

// One scholar's renewal for one renewal period (models/RenewalPeriod.js).
// Created by the scholar (POST /api/renewals); reviewed by the office that
// owns the scholarship, or the AdSO (routes/renewals.js).

// 'Not Continuing' is the scholar's own answer (e.g. OJT, graduating,
// transferring); the other final statuses are review decisions.
const STATUSES = ['Under Evaluation', 'Needs Revision', 'Renewed', 'Not Renewed', 'Not Continuing'];
const DECISIONS = ['Needs Revision', 'Renewed', 'Not Renewed'];
const NOT_CONTINUING_REASONS = ['OJT / internship', 'Graduating', 'Transferring', 'Leave of absence', 'Other'];

const documentSchema = new mongoose.Schema({
  docType: String,
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  filename: String,
  mimetype: String,
  size: Number,
}, { _id: false });

const historyEntrySchema = new mongoose.Schema({
  status: { type: String, enum: ['Submitted', 'Resubmitted', ...STATUSES], required: true },
  note: String,
  changedBy: String,        // 'student' or the admin's email
  changedByName: String,
  changedByOffice: String,
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

// The department head's Student Assistant evaluation, entered by office
// staff from the head's form (heads have no AniSkolar account). Scores are
// 1–5, keyed by item (utils/renewals.js EVALUATION_ITEMS). Staff-only: never
// sent to the scholar until the AdSO decides they may see it.
const evaluationSchema = new mongoose.Schema({
  scores: { type: mongoose.Schema.Types.Mixed },
  average: Number,
  evaluatorName: { type: String, trim: true, maxlength: 200 },
  assignedOffice: { type: String, trim: true, maxlength: 200 },
  remarks: { type: String, trim: true, maxlength: 2000 },
  enteredBy: String,
  enteredAt: Date,
  // 'office' = entered by the office head in the office portal.
  source: { type: String, enum: ['office', 'adso'] },
}, { _id: false });

const renewalSchema = new mongoose.Schema({
  periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'RenewalPeriod', required: true, index: true },
  studentNumber: { type: String, required: true, index: true },
  scholarshipId: { type: String, required: true },
  scholarshipName: { type: String, required: true },
  office: { type: String, enum: ['LSO', 'POLCA', 'ALUMNI'], default: 'LSO', index: true },
  academicYear: { type: Number, required: true },
  term: { type: String, required: true },

  continuing: { type: Boolean, required: true },
  notContinuingReason: { type: String, enum: NOT_CONTINUING_REASONS },
  notContinuingDetails: { type: String, trim: true, maxlength: 500 },

  // As the scholar reports it; staff check it against the grades uploaded.
  gpa: { type: Number, min: 0, max: 4 },
  hasFailingGrade: Boolean,
  documents: { type: [documentSchema], default: [] },

  evaluation: { type: evaluationSchema },

  status: { type: String, enum: STATUSES, default: 'Under Evaluation' },
  reviewNote: String,
  reviewedBy: String,
  reviewedAt: Date,
  history: { type: [historyEntrySchema], default: [] },
}, { timestamps: true });

renewalSchema.index({ periodId: 1, studentNumber: 1 }, { unique: true });

module.exports = mongoose.model('Renewal', renewalSchema);
module.exports.STATUSES = STATUSES;
module.exports.DECISIONS = DECISIONS;
module.exports.NOT_CONTINUING_REASONS = NOT_CONTINUING_REASONS;
