const OutboxEmail = require('../models/OutboxEmail');
const { sendMail, mailEnabled } = require('./mailer');

// The outbox for personal emails (models/OutboxEmail.js). Jobs queue
// emails here; processOutbox() runs every minute from server.js and sends
// EMAIL_SENDS_PER_MINUTE of them (default 1 — the free Azure sender allows
// 5 a minute and 10 an hour, so keep it low until the sender's quota is
// raised). A refused email is retried up to 5 times, 10 minutes apart.

const MAX_ATTEMPTS = 5;
const perRun = () => Math.max(1, Number(process.env.EMAIL_SENDS_PER_MINUTE) || 1);
// Addresses under .invalid (demo data) are never emailed.
const deliverable = to => typeof to === 'string' && /@/.test(to) && !/\.invalid$/i.test(to.trim());

// emails: [{ key, kind, to, subject, text, html }]. Already-queued keys are
// skipped. Returns how many were newly queued.
async function queueEmails(emails) {
  const docs = emails.filter(e => deliverable(e.to));
  if (!docs.length) return 0;
  try {
    const inserted = await OutboxEmail.insertMany(docs, { ordered: false });
    return inserted.length;
  } catch (err) {
    // Duplicate keys (sent before) are expected; anything else isn't.
    if (err.code === 11000 || err.writeErrors?.every(e => e.code === 11000 || e.err?.code === 11000)) {
      return err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
    }
    throw err;
  }
}

let running = false;
async function processOutbox() {
  if (running || !mailEnabled()) return;
  running = true;
  try {
    for (let i = 0; i < perRun(); i++) {
      const email = await OutboxEmail.findOneAndUpdate(
        { status: 'queued', nextAttemptAt: { $lte: new Date() } },
        { $inc: { attempts: 1 }, $set: { nextAttemptAt: new Date(Date.now() + 10 * 60_000) } },
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }
      );
      if (!email) return;
      const ok = await sendMail({ to: email.to, subject: email.subject, text: email.text, html: email.html, wait: true });
      if (ok) await OutboxEmail.updateOne({ _id: email._id }, { $set: { status: 'sent', sentAt: new Date() }, $unset: { error: '' } });
      else if (email.attempts >= MAX_ATTEMPTS) await OutboxEmail.updateOne({ _id: email._id }, { $set: { status: 'failed', error: 'The email service refused it 5 times. Check the server log.' } });
      else return; // probably the hourly limit: try again next minute
    }
  } finally {
    running = false;
  }
}

async function outboxCounts() {
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const [queued, sent, failed] = await Promise.all([
    OutboxEmail.countDocuments({ status: 'queued' }),
    OutboxEmail.countDocuments({ status: 'sent', sentAt: { $gte: since } }),
    OutboxEmail.countDocuments({ status: 'failed', updatedAt: { $gte: since } }),
  ]);
  return { queued, sentLast7Days: sent, failedLast7Days: failed, perMinute: perRun(), mailEnabled: mailEnabled() };
}

module.exports = { queueEmails, processOutbox, outboxCounts };
