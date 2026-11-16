const mongoose = require('mongoose');

// A Full Scholarship Equivalent (FSE) report, generated whenever the AdSO
// needs one from the registrar's raw scholarship assessment report (see the
// admin FSE page); each generation is kept as its own report. FSE per scholar = total discount / matriculation (DLSP FSE
// manual); the report's totals are computed from these rows when read.

const CATEGORIES = ['internalAcademic', 'internalNonAcademic', 'external', 'special'];
const TERMS = ['1st Semester', '2nd Semester', 'Midyear'];
const SPECIAL_FUNDING = ['internal', 'external', 'coFunded'];

const scholarSchema = new mongoose.Schema({
  studentId: { type: String, required: true, trim: true },
  program: { type: String, trim: true },
  matriculation: { type: Number, min: 0, required: true },  // tuition and fees
  discount: { type: Number, min: 0, default: 0 },
  allowances: { type: Number, min: 0, default: 0 },         // meal, monthly, dorm, book, other assistance
  // The same by kind, when the upload had the office's allowance columns.
  allowanceDetail: {
    type: new mongoose.Schema({ meal: Number, monthly: Number, dorm: Number, other: Number, book: Number }, { _id: false }),
    default: undefined,
  },
  // The allowances the AdSO entered for this scholar (from a donor or
  // sponsor), already in allowanceDetail / allowances / totalDiscount; kept
  // apart so editing can change them.
  entered: {
    type: new mongoose.Schema({ meal: Number, monthly: Number, dorm: Number, other: Number, book: Number }, { _id: false }),
    default: undefined,
  },
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
  // Special programs only: how the program is funded (the FSE sheet splits
  // special-program headcount into internally / externally / co-funded).
  specialFunding: { type: String, enum: SPECIAL_FUNDING },
  // The allowances per scholar the AdSO entered for this scholarship (from
  // its donor or sponsoring office); added to each grantee's discount.
  allowances: {
    type: new mongoose.Schema({ meal: Number, monthly: Number, dorm: Number, other: Number, book: Number }, { _id: false }),
    default: undefined,
  },
  // Scholars the AdSO added by hand when the file is missing some (e.g. rows
  // lost from the registrar's export): how many, their total assessment and
  // total discount, and where the numbers come from. Counted in the FSE at
  // the group's average.
  adjustment: {
    type: new mongoose.Schema({
      scholars: { type: Number, min: 1 }, assessment: { type: Number, min: 0 }, discount: { type: Number, min: 0 }, note: String,
    }, { _id: false }),
    default: undefined,
  },
  scholars: { type: [scholarSchema], default: [] },
}, { _id: false });

const fseReportSchema = new mongoose.Schema({
  academicYear: { type: String, required: true, trim: true },   // "AY 2025–2026"
  term: { type: String, enum: TERMS, required: true },
  population: { type: Number, required: true, min: 1 },          // student population / FTE
  spoonRecipients: { type: Number, min: 0 },                     // Lasallian SPOON recipients (entered)
  asOf: Date,
  fileName: { type: String, trim: true },
  // Other grants the AdSO added to listed scholars: e.g. DOST for students
  // the registrar's file lists under another scholarship (each student is
  // listed once). Added to that row as "other financial assistance".
  grants: {
    type: [new mongoose.Schema({ label: String, amount: Number, studentIds: [String] }, { _id: false })],
    default: undefined,
  },
  scholarships: { type: [scholarshipSchema], default: [] },
  updatedBy: String,
}, { timestamps: true });

// Generated on demand: any number per term, newest first.
fseReportSchema.index({ createdAt: -1 });

module.exports = mongoose.model('FseReport', fseReportSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.TERMS = TERMS;
module.exports.SPECIAL_FUNDING = SPECIAL_FUNDING;
