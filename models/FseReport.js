const mongoose = require('mongoose');

// One semester's Full Scholarship Equivalent (FSE) report, built from the
// registrar's scholarship export that the AdSO uploads (see the admin FSE
// page). FSE per scholar = total discount / matriculation (DLSP FSE
// manual); the report's totals are computed from these rows when read.

const CATEGORIES = ['internalAcademic', 'internalNonAcademic', 'external', 'special'];
const TERMS = ['1st Semester', '2nd Semester', 'Midyear'];

const scholarSchema = new mongoose.Schema({
  studentId: { type: String, required: true, trim: true },
  program: { type: String, trim: true },
  matriculation: { type: Number, min: 0, required: true },  // tuition and fees
  discount: { type: Number, min: 0, default: 0 },
  allowances: { type: Number, min: 0, default: 0 },         // meal, monthly, dorm, book, other assistance
  totalDiscount: { type: Number, min: 0, required: true },  // what the FSE counts
  fse: { type: Number, min: 0, required: true },
}, { _id: false });

const scholarshipSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true },
  name: { type: String, trim: true },
  // As written in the registrar export, e.g. "Internally Funded" /
  // "Academic Scholarship"; `category` is what the report counts it under.
  fundSource: { type: String, trim: true },
  subcategory: { type: String, trim: true },
  category: { type: String, enum: CATEGORIES, required: true },
  scholars: { type: [scholarSchema], default: [] },
}, { _id: false });

const fseReportSchema = new mongoose.Schema({
  academicYear: { type: String, required: true, trim: true },   // "AY 2025–2026"
  term: { type: String, enum: TERMS, required: true },
  population: { type: Number, required: true, min: 1 },          // student population / FTE
  asOf: Date,
  fileName: { type: String, trim: true },
  scholarships: { type: [scholarshipSchema], default: [] },
  updatedBy: String,
}, { timestamps: true });

fseReportSchema.index({ academicYear: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('FseReport', fseReportSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.TERMS = TERMS;
