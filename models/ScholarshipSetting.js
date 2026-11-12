const mongoose = require('mongoose');
const { OFFICE_CODES } = require('../data/offices');

// AdSO-edited content for a scholarship. The built-in scholarships (id,
// name, office, form type, document slots) live in code —
// data/scholarships.js and the frontend's src/data/scholarships.ts —
// because their application forms are built around them; for those this
// holds only what the AdSO edits, and any field left unset falls back to
// the default in code.
//
// `custom: true` documents are scholarships the AdSO created: their name,
// office, category, mode and reference code live here too, and they use
// the standard application form (utils/customScholarships.js keeps them
// in memory for findScholarship).
//
// Eligibility and documents are picked from the shared catalog
// (data/requirementCatalog.js): `rules`, `customEligibility`,
// `documentKeys`, `customDocuments`. An empty list is a real choice
// ("none"); unset means the code default.

const STATUSES = ['Open', 'Closing Soon', 'Closed'];

const listField = { type: [String], default: undefined };

const scholarshipSettingSchema = new mongoose.Schema({
  scholarshipId: { type: String, required: true, unique: true },
  status: { type: String, enum: STATUSES },
  deadline: { type: String, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 4000 },
  benefits: listField,
  eligibility: listField,
  process: listField,
  submissionNote: { type: String, trim: true, maxlength: 500 },
  // Application period, picked as dates (YYYY-MM-DD, Manila): applications
  // are accepted only between them (utils/scholarshipDates.js). `deadline`
  // is the older typed text, shown only while no dates are picked.
  opensOn: String,
  closesOn: String,
  // e.g. the Athletic Scholarship's varsity tryouts: a picked date and
  // time, and where. `schedule` is the older typed text.
  schedule: { type: String, trim: true, maxlength: 300 },
  scheduleOn: String,
  scheduleTime: String,
  scheduleVenue: { type: String, trim: true, maxlength: 150 },
  rules: { type: mongoose.Schema.Types.Mixed, default: undefined },
  customEligibility: listField,
  documentKeys: listField,
  customDocuments: listField,
  // Slot limits, replacing the code's (0 = no limit): at most this many
  // current scholars in all / per college (utils/collegeSlots.js).
  totalSlots: { type: Number, min: 0, max: 1000 },
  slotsPerCollege: { type: Number, min: 0, max: 1000 },
  // The office's amounts and levels (data/officeForms.js → numbers), e.g.
  // the ROTC amount for each rank: { key: number }.
  officeNumbers: { type: mongoose.Schema.Types.Mixed, default: undefined },

  // Scholarships created by the AdSO.
  custom: { type: Boolean, default: undefined },
  name: { type: String, trim: true, maxlength: 150 },
  office: { type: String, enum: OFFICE_CODES },
  category: { type: String, enum: ['Academic', 'Financial', 'Athletic', 'Leadership', 'Others'] },
  applicationMode: { type: String, enum: ['online', 'info'] },
  availNote: { type: String, trim: true, maxlength: 500 },
  // No online application: the office students go to.
  handledBy: { type: String, trim: true, maxlength: 150 },
  referenceCode: { type: String, trim: true, uppercase: true, maxlength: 10 },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

// The fields a client can read and the admin page can edit.
const EDITABLE_FIELDS = [
  'status', 'deadline', 'opensOn', 'closesOn', 'description', 'benefits', 'process', 'submissionNote',
  'schedule', 'scheduleOn', 'scheduleTime', 'scheduleVenue',
  'rules', 'customEligibility', 'documentKeys', 'customDocuments',
  'totalSlots', 'slotsPerCollege', 'officeNumbers',
];
// Fixed details of an AdSO-created scholarship (sent with its overrides).
const CUSTOM_FIELDS = ['custom', 'name', 'office', 'category', 'applicationMode', 'availNote', 'handledBy', 'referenceCode'];

scholarshipSettingSchema.methods.toOverrides = function toOverrides() {
  const out = { id: this.scholarshipId };
  for (const field of [...EDITABLE_FIELDS, ...(this.custom ? CUSTOM_FIELDS : [])]) {
    if (this[field] !== undefined && this[field] !== null) out[field] = this[field];
  }
  out.updatedAt = this.updatedAt;
  out.updatedBy = this.updatedBy;
  return out;
};

module.exports = mongoose.model('ScholarshipSetting', scholarshipSettingSchema);
module.exports.STATUSES = STATUSES;
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
module.exports.CUSTOM_FIELDS = CUSTOM_FIELDS;
