const mongoose = require('mongoose');

// A scholar's duty hours for one term — the SFAG's service
// requirement, replacing the office's "SFAG Duty Calculator" sheet. The
// AdSO assigns the office the scholar renders duty in; the scholar enters
// the rest (deadline, required hours, each duty and special event). Hours
// and totals are computed from it (utils/dutyHours.js), never stored from
// the client.

const TERMS = ['1st Semester', '2nd Semester'];

// The office head confirms each duty (routes/office.js): 'confirmed' or
// 'flagged' (with a note); unset = waiting. When the scholar's office has
// a head in AniSkolar, only confirmed duties count (utils/dutyHours.js).
const ENTRY_STATUSES = ['confirmed', 'flagged'];
const entrySchema = new mongoose.Schema({
  date: { type: String, required: true },     // YYYY-MM-DD
  timeIn: { type: String, required: true },   // HH:mm, 24-hour
  timeOut: { type: String, required: true },
  status: { type: String, enum: ENTRY_STATUSES },
  reviewedBy: String,                         // the head's email
  reviewedAt: Date,
  note: { type: String, trim: true, maxlength: 500 },
}, { _id: true });

// The office head's evaluation of the scholar's duty this term (the 1–5
// ratings of utils/renewals.js EVALUATION_ITEMS), entered in the office
// portal; it's copied into the renewal that looks back on this term.
const evaluationSchema = new mongoose.Schema({
  scores: { type: mongoose.Schema.Types.Mixed },
  average: Number,
  evaluatorName: { type: String, trim: true, maxlength: 200 },
  assignedOffice: { type: String, trim: true, maxlength: 200 },
  remarks: { type: String, trim: true, maxlength: 2000 },
  enteredBy: String,
  enteredAt: Date,
  source: { type: String, enum: ['office', 'adso'] },
}, { _id: false });

const specialEventSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  hours: { type: Number, required: true, min: 0, max: 100 },
}, { _id: true });

// A scholar's claim to have attended a credited event (models/DutyEvent.js).
// Only Approved claims count, for the event's credit hours.
const CLAIM_STATUSES = ['Pending', 'Approved', 'Rejected'];
const eventClaimSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'DutyEvent', required: true },
  status: { type: String, enum: CLAIM_STATUSES, default: 'Pending' },
  claimedAt: { type: Date, default: Date.now },
  reviewedBy: String,
  reviewedAt: Date,
  note: { type: String, trim: true, maxlength: 500 },   // e.g. why it was rejected
}, { _id: false });

const dutyLogSchema = new mongoose.Schema({
  studentNumber: { type: String, required: true, index: true },
  academicYear: { type: Number, required: true },   // start year: 2026 = AY 2026–2027
  term: { type: String, enum: TERMS, required: true },
  officeAssigned: { type: String, trim: true, maxlength: 200 },
  officeAssignedBy: { type: String },                // AdSO email; never sent to the scholar
  officeAssignedAt: { type: Date },
  deadline: { type: String },                        // YYYY-MM-DD
  requiredHours: { type: Number, min: 0, max: 1000 },
  entries: { type: [entrySchema], default: [] },
  // Before credited events: hours the scholar typed in. No longer
  // accepted from scholars; kept so old logs still add up.
  specialEvents: { type: [specialEventSchema], default: [] },
  eventClaims: { type: [eventClaimSchema], default: [] },
  evaluation: { type: evaluationSchema },
}, { timestamps: true });

dutyLogSchema.index({ studentNumber: 1, academicYear: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('DutyLog', dutyLogSchema);
module.exports.TERMS = TERMS;
module.exports.CLAIM_STATUSES = CLAIM_STATUSES;
module.exports.ENTRY_STATUSES = ENTRY_STATUSES;
