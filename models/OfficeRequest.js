const mongoose = require('mongoose');

// A duty office's request to the AdSO, sent from the office portal: a
// specific scholar, more or fewer scholars, or something else. The AdSO
// answers it from Duty hours → Requests.

const KINDS = ['specific', 'more', 'fewer', 'other'];
const STATUSES = ['open', 'done', 'declined'];

const officeRequestSchema = new mongoose.Schema({
  office: { type: String, required: true, trim: true, maxlength: 200, index: true },
  headEmail: String,
  headName: String,
  kind: { type: String, enum: KINDS, required: true },
  scholar: { type: String, trim: true, maxlength: 200 },   // 'Name (student number)', for 'specific'
  studentNumber: { type: String, trim: true },             // the scholar picked, for 'specific'
  count: { type: Number, min: 1, max: 20 },                // for 'more' / 'fewer'
  note: { type: String, trim: true, maxlength: 1000 },
  academicYear: Number,
  term: String,
  status: { type: String, enum: STATUSES, default: 'open', index: true },
  response: { type: String, trim: true, maxlength: 1000 },
  resolvedBy: String,
  resolvedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('OfficeRequest', officeRequestSchema);
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
