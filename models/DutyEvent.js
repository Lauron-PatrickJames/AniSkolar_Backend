const mongoose = require('mongoose');

// An event that earns SFAG scholars duty-hour credit. Events are set up by
// the scholarship office or by COSA (the scholars' organization, which asks
// the office first); the office decides whether an event is credited and
// for how many hours. The credit is the office's call, not the event's
// length: a 1-hour event can be worth 3 hours (AdSO, Oct 2026). The AdSO
// enters them; scholars claim the ones they attended and the AdSO approves
// each claim (DutyLog.eventClaims) before the hours count.

const ORGANIZERS = ['Scholarship office', 'COSA'];

const dutyEventSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  date: { type: String, required: true },             // YYYY-MM-DD
  organizer: { type: String, enum: ORGANIZERS, required: true },
  creditHours: { type: Number, required: true, min: 0.25, max: 24 },
  // The duty term the date falls in (utils/dutyHours.js currentTerm).
  academicYear: { type: Number, required: true },
  term: { type: String, required: true },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

dutyEventSchema.index({ academicYear: 1, term: 1, date: -1 });

module.exports = mongoose.model('DutyEvent', dutyEventSchema);
module.exports.ORGANIZERS = ORGANIZERS;
