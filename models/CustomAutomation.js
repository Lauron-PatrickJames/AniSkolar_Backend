const mongoose = require('mongoose');

// Automations the AdSO adds on the Automation page (utils/customAutomations.js),
// beside the built-in reminders. Each sends an email:
//   trigger 'schedule'  to an audience (students by utils/emailTarget.js, or
//                       the duty office heads) once, daily, weekly or monthly
//   trigger 'event'     to the student involved, when one of EVENTS happens
//                       (optionally only for some scholarships)
// They start off. Every email has a key, so nobody gets the same one twice.

const EVENTS = [
  'applicationSubmitted',
  'applicationApproved',
  'applicationNeedsRevision',
  'applicationRejected',
  'renewalSubmitted',
  'renewalRenewed',
  'renewalNeedsRevision',
  'renewalNotRenewed',
];
const FREQUENCIES = ['once', 'daily', 'weekly', 'monthly'];
const AUDIENCES = ['students', 'officeHeads'];
const MAX_AUTOMATIONS = 30;

const lastRunSchema = new mongoose.Schema({
  period: String,       // the day / week / month it ran for, or 'event'
  at: Date,
  queued: Number,
  summary: String,
  error: String,
}, { _id: false });

const customAutomationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  enabled: { type: Boolean, default: false },
  // Events only count from when it was last switched on, so switching one
  // on doesn't email everyone approved last month.
  activeSince: Date,
  trigger: { type: String, enum: ['schedule', 'event'], required: true },

  // trigger 'schedule' (Manila time)
  frequency: { type: String, enum: FREQUENCIES },
  date: String,         // 'once': YYYY-MM-DD
  weekday: { type: Number, min: 0, max: 6 },      // 'weekly': 0 = Sunday
  dayOfMonth: { type: Number, min: 1, max: 28 },  // 'monthly'
  hour: { type: Number, min: 0, max: 23, default: 8 },
  audience: { type: String, enum: AUDIENCES },
  emailTarget: { type: mongoose.Schema.Types.Mixed },  // audience 'students'

  // trigger 'event'
  event: { type: String, enum: EVENTS },
  scholarshipIds: { type: [String], default: [] },     // empty = any

  subject: { type: String, required: true, trim: true, maxlength: 150 },
  body: { type: String, required: true, trim: true, maxlength: 5000 },

  lastRun: lastRunSchema,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

module.exports = mongoose.model('CustomAutomation', customAutomationSchema);
module.exports.EVENTS = EVENTS;
module.exports.FREQUENCIES = FREQUENCIES;
module.exports.AUDIENCES = AUDIENCES;
module.exports.MAX_AUTOMATIONS = MAX_AUTOMATIONS;
