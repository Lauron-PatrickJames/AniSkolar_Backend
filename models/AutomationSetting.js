const mongoose = require('mongoose');

// What AniSkolar does on its own (utils/automation.js), switched on by the
// AdSO on the Automation page. Everything starts off, so nobody is emailed
// until the office decides to. One document, _id 'automation'.

const JOBS = ['dutyReminders', 'officeHeadReminders', 'deadlineReminders', 'adsoDigest', 'termRollover'];

const lastRunSchema = new mongoose.Schema({
  period: String,       // the day / week it ran for, e.g. '2026-10-19' or '2026-W43'
  at: Date,
  queued: Number,       // emails queued
  summary: String,      // one line for the page, e.g. '12 scholars behind'
  error: String,
}, { _id: false });

const automationSettingSchema = new mongoose.Schema({
  _id: { type: String, default: 'automation' },
  dutyReminders: { type: Boolean, default: false },
  officeHeadReminders: { type: Boolean, default: false },
  deadlineReminders: { type: Boolean, default: false },
  adsoDigest: { type: Boolean, default: false },
  // Who gets the morning summary (AdSO staff school emails).
  adsoDigestTo: { type: [String], default: [] },
  termRollover: { type: Boolean, default: false },
  // Rollover: a scholar goes back to last term's office when it has room.
  keepLastOffice: { type: Boolean, default: true },
  lastRuns: { type: Map, of: lastRunSchema, default: {} },
  updatedBy: String,
}, { timestamps: true });

automationSettingSchema.statics.current = async function current() {
  return (await this.findById('automation').lean()) ?? { _id: 'automation', dutyReminders: false, officeHeadReminders: false, deadlineReminders: false, adsoDigest: false, adsoDigestTo: [], termRollover: false, keepLastOffice: true, lastRuns: {} };
};

module.exports = mongoose.model('AutomationSetting', automationSettingSchema);
module.exports.JOBS = JOBS;
