const mongoose = require('mongoose');

// A scholar's duty hours for one term — the SFA Grant's service
// requirement, replacing the office's "SFAG Duty Calculator" sheet. The
// scholar enters everything here (office, deadline, required hours, each
// duty and special event); hours and totals are computed from it
// (utils/dutyHours.js), never stored from the client.

const TERMS = ['1st Semester', '2nd Semester'];

const entrySchema = new mongoose.Schema({
  date: { type: String, required: true },     // YYYY-MM-DD
  timeIn: { type: String, required: true },   // HH:mm, 24-hour
  timeOut: { type: String, required: true },
}, { _id: true });

const specialEventSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  hours: { type: Number, required: true, min: 0, max: 100 },
}, { _id: true });

const dutyLogSchema = new mongoose.Schema({
  studentNumber: { type: String, required: true, index: true },
  academicYear: { type: Number, required: true },   // start year: 2026 = AY 2026–2027
  term: { type: String, enum: TERMS, required: true },
  officeAssigned: { type: String, trim: true, maxlength: 200 },
  deadline: { type: String },                        // YYYY-MM-DD
  requiredHours: { type: Number, min: 0, max: 1000 },
  entries: { type: [entrySchema], default: [] },
  specialEvents: { type: [specialEventSchema], default: [] },
}, { timestamps: true });

dutyLogSchema.index({ studentNumber: 1, academicYear: 1, term: 1 }, { unique: true });

module.exports = mongoose.model('DutyLog', dutyLogSchema);
module.exports.TERMS = TERMS;
