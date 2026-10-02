const mongoose = require('mongoose');

// AdSO-edited content for a scholarship. The scholarship itself (id, name,
// office, form type, eligibility rules, document slots) lives in code —
// data/scholarships.js and the frontend's src/data/scholarships.ts — because
// the application forms are built around it. This collection holds only the
// parts the AdSO manages from the admin Scholarships page; any field left
// unset falls back to the default in code.

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
  updatedBy: String,
}, { timestamps: true });

// The fields a client can read and the admin page can edit.
const EDITABLE_FIELDS = ['status', 'deadline', 'description', 'benefits', 'eligibility', 'process', 'submissionNote', 'schedule'];

scholarshipSettingSchema.methods.toOverrides = function toOverrides() {
  const out = { id: this.scholarshipId };
  for (const field of EDITABLE_FIELDS) {
    if (this[field] !== undefined && this[field] !== null) out[field] = this[field];
  }
  out.updatedAt = this.updatedAt;
  out.updatedBy = this.updatedBy;
  return out;
};

module.exports = mongoose.model('ScholarshipSetting', scholarshipSettingSchema);
module.exports.STATUSES = STATUSES;
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
