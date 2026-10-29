const mongoose = require('mongoose');

// Duty hours settings, set by the AdSO on the Duty hours page: how many
// hours an SFAG grantee renders per term, by year level and grant
// percentage. An hour left empty means those scholars enter their required
// hours themselves, as on the old duty sheet. One document, _id 'duty'.

const GRANT_PERCENTAGES = [100, 75, 50, 25];

// Hours depend on the scholar's year level: 1st–2nd year render more than
// 3rd year and up. 5th-year students count with 3rd–4th year.
const YEAR_GROUPS = ['lower', 'upper'];
function yearGroupOf(yearLevel) {
  if (yearLevel === '1st Year' || yearLevel === '2nd Year') return 'lower';
  if (yearLevel === '3rd Year' || yearLevel === '4th Year' || yearLevel === '5th Year') return 'upper';
  return null;
}

// SFAG duty hours per term from the AdSO (Oct 2026). The AdSO can change
// them on the page.
const DEFAULT_HOURS = {
  lower: { p100: 180, p75: 135, p50: 100, p25: 50 },
  upper: { p100: 95, p75: 70, p50: 55, p25: 30 },
};
const key = percentage => `p${percentage}`;

const hoursField = { type: Number, min: 0, max: 1000 };
const groupSchema = new mongoose.Schema({ p100: hoursField, p75: hoursField, p50: hoursField, p25: hoursField }, { _id: false });

// How many scholars each office takes, for the AdSO's "Random assign"
// (AdSO, Oct 2026: assignment is random; bigger offices such as the
// Registrar, Accounting and Admissions take more). Kept across terms.
// Also the list of duty offices and their heads: a head signs in with
// this school email and gets the office portal (routes/office.js).
const officeSlotSchema = new mongoose.Schema({
  office: { type: String, required: true, trim: true, maxlength: 200 },
  slots: { type: Number, required: true, min: 0, max: 50 },
  headName: { type: String, trim: true, maxlength: 200 },
  headEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
}, { _id: false });

// The duty deadline for a term, set by the AdSO (scholars can't change it).
const termDeadlineSchema = new mongoose.Schema({
  academicYear: { type: Number, required: true },
  term: { type: String, required: true },
  date: { type: String, required: true },   // YYYY-MM-DD
}, { _id: false });

const dutySettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'duty' },
  // lower / upper -> p100 / p75 / p50 / p25 -> hours per term
  // (unset = scholars enter it).
  hours: { lower: groupSchema, upper: groupSchema },
  // Set once the AdSO saves hours; until then the defaults apply (saving
  // office slots alone mustn't blank them).
  hoursSaved: Boolean,
  officeSlots: { type: [officeSlotSchema], default: undefined },
  deadlines: { type: [termDeadlineSchema], default: undefined },
  updatedBy: String,
}, { timestamps: true });

// The saved settings, or the defaults when none have been saved, as
// { hoursByGroup: { lower: { 100: n|null, 75: …, 50: …, 25: … }, upper: { … } },
//   officeSlots: [{ office, slots }] }.
dutySettingSchema.statics.current = async function current() {
  const doc = await this.findById('duty').lean();
  const saved = doc?.hoursSaved ? (doc.hours ?? {}) : DEFAULT_HOURS;
  const hoursByGroup = Object.fromEntries(YEAR_GROUPS.map(g => [
    g,
    Object.fromEntries(GRANT_PERCENTAGES.map(p => [p, saved[g]?.[key(p)] ?? null])),
  ]));
  return { hoursByGroup, officeSlots: doc?.officeSlots ?? [], deadlines: doc?.deadlines ?? [], updatedBy: doc?.updatedBy ?? null, updatedAt: doc?.updatedAt ?? null };
};

// The AdSO's duty deadline for a term (YYYY-MM-DD), or null.
dutySettingSchema.statics.deadlineFor = async function deadlineFor({ academicYear, term }) {
  const doc = await this.findById('duty').select('deadlines').lean();
  return doc?.deadlines?.find(d => d.academicYear === academicYear && d.term === term)?.date ?? null;
};

module.exports = mongoose.model('DutySetting', dutySettingSchema);
module.exports.GRANT_PERCENTAGES = GRANT_PERCENTAGES;
module.exports.YEAR_GROUPS = YEAR_GROUPS;
module.exports.yearGroupOf = yearGroupOf;
module.exports.hoursKey = key;
