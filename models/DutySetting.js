const mongoose = require('mongoose');

// Duty hours settings, set by the AdSO on the Duty hours page: how many
// hours an SFAG grantee renders per term, by grant percentage ("hours based
// on their scholarship percentage", A.Y. 2026-2027 guidelines). A
// percentage left empty means its scholars enter their required hours
// themselves, as on the old duty sheet. One document, _id 'duty'.

const GRANT_PERCENTAGES = [100, 75, 50, 25];

// 100% = 180 hours (AdSO interview, Oct 2026); 25% = 36 hours as the team
// recalls it — to confirm. The AdSO can change all of them on the page.
const DEFAULT_HOURS = { p100: 180, p25: 36 };
const key = percentage => `p${percentage}`;

const dutySettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'duty' },
  // p100 / p75 / p50 / p25 -> hours per term (unset = scholars enter it).
  hours: {
    p100: { type: Number, min: 0, max: 1000 },
    p75: { type: Number, min: 0, max: 1000 },
    p50: { type: Number, min: 0, max: 1000 },
    p25: { type: Number, min: 0, max: 1000 },
  },
  updatedBy: String,
}, { timestamps: true });

// The saved settings, or the defaults when none have been saved, as
// { hoursByPercentage: { 100: n|null, 75: …, 50: …, 25: … } }.
dutySettingSchema.statics.current = async function current() {
  const doc = await this.findById('duty').lean();
  const saved = doc?.hours ?? DEFAULT_HOURS;
  const hoursByPercentage = Object.fromEntries(GRANT_PERCENTAGES.map(p => [p, saved[key(p)] ?? null]));
  return { hoursByPercentage, updatedBy: doc?.updatedBy ?? null, updatedAt: doc?.updatedAt ?? null };
};

module.exports = mongoose.model('DutySetting', dutySettingSchema);
module.exports.GRANT_PERCENTAGES = GRANT_PERCENTAGES;
module.exports.hoursKey = key;
