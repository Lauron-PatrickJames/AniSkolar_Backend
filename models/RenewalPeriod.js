const mongoose = require('mongoose');

// A renewal window for one scholarship and term, opened by the AdSO from
// the admin Renewals page. Scholars who hold the scholarship (see
// utils/renewals.js) submit a renewal against it while it is open.
//
// DLSU-D has no second-semester application: scholars renew for the 2nd
// semester, and those continuing into a new academic year renew for its
// 1st semester (interview with the Scholarship Associate, NG manuscript
// Appendix E).

const TERMS = ['1st Semester', '2nd Semester'];

const renewalPeriodSchema = new mongoose.Schema({
  scholarshipId: { type: String, required: true },
  // Start year of the academic year, e.g. 2026 for AY 2026–2027
  // (utils/academicYear.js).
  academicYear: { type: Number, required: true, min: 2000, max: 2100 },
  term: { type: String, enum: TERMS, required: true },
  // Closed periods refuse new submissions; resubmissions after "Needs
  // Revision" are still accepted.
  open: { type: Boolean, default: true },
  deadline: { type: String, trim: true, maxlength: 200 },
  // Retention rule shown to scholars and checked on the admin list:
  // a GPA (0.0–4.0, higher is better) of at least this much.
  minGpa: { type: Number, min: 0, max: 4 },
  // Whether the scholar's department head evaluation (the SFAG's
  // 1–5 Student Assistant rating) is part of this renewal.
  requiresEvaluation: { type: Boolean, default: false },
  // Documents the scholar uploads, one label each, e.g.
  // "Certified True Copy of Grades".
  requirements: { type: [String], default: [] },
  notes: { type: String, trim: true, maxlength: 1000 },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

renewalPeriodSchema.index({ scholarshipId: 1, academicYear: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('RenewalPeriod', renewalPeriodSchema);
module.exports.TERMS = TERMS;
