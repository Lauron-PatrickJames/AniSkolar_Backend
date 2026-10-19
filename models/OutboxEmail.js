const mongoose = require('mongoose');

// Personal emails waiting to go out (reminders, digests), sent a few a
// minute by utils/outbox.js because the email service limits how many it
// sends per minute and hour. `key` is unique, so queueing the same
// reminder twice (e.g. a job that runs again the same week) is a no-op.

const STATUSES = ['queued', 'sent', 'failed'];

const outboxEmailSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, required: true },       // job that queued it, e.g. 'dutyReminders'
  to: { type: String, required: true, lowercase: true, trim: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  html: { type: String },
  status: { type: String, enum: STATUSES, default: 'queued' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: Date,
  error: String,
}, { timestamps: true });

outboxEmailSchema.index({ status: 1, nextAttemptAt: 1 });
// Sent and failed emails are kept 60 days, for the Automation page's counts.
outboxEmailSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.model('OutboxEmail', outboxEmailSchema);
module.exports.STATUSES = STATUSES;
