const mongoose = require('mongoose');

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
  // e.g. the Athletic Scholarship's varsity tryout dates.
  schedule: { type: String, trim: true, maxlength: 300 },
  rules: { type: mongoose.Schema.Types.Mixed, default: undefined },
  customEligibility: listField,
  documentKeys: listField,
  customDocuments: listField,

  // Scholarships created by the AdSO.
  custom: { type: Boolean, default: undefined },
  name: { type: String, trim: true, maxlength: 150 },
  office: { type: String, enum: ['LSO', 'POLCA', 'ALUMNI'] },
  category: { type: String, enum: ['Academic', 'Financial', 'Athletic', 'Leadership', 'Others'] },
  applicationMode: { type: String, enum: ['online', 'info'] },
  availNote: { type: String, trim: true, maxlength: 500 },
  referenceCode: { type: String, trim: true, uppercase: true, maxlength: 10 },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

// The fields a client can read and the admin page can edit.
const EDITABLE_FIELDS = [
  'status', 'deadline', 'description', 'benefits', 'process', 'submissionNote', 'schedule',
  'rules', 'customEligibility', 'documentKeys', 'customDocuments',
];
// Fixed details of an AdSO-created scholarship (sent with its overrides).
const CUSTOM_FIELDS = ['custom', 'name', 'office', 'category', 'applicationMode', 'availNote', 'referenceCode'];

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
