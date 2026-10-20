const OutboxEmail = require('../models/OutboxEmail');
const { sendMail, mailEnabled } = require('./mailer');

// The outbox for personal emails (models/OutboxEmail.js). Jobs queue
// emails here; processOutbox() runs every minute from server.js and sends
// EMAIL_SENDS_PER_MINUTE of them in any minute (default 1 — the free Azure
// sender allows 5 a minute and 10 an hour, so keep it low until the
// sender's quota is raised). Message alerts go before reminders. A refused
// email (usually the hourly limit) is retried up to 5 times, waiting 15,
// 30, 45 and 60 minutes. While email isn't set up nothing is queued, so
// turning it on later doesn't send a pile of old alerts.

const MAX_ATTEMPTS = 5;
const perRun = () => Math.max(1, Number(process.env.EMAIL_SENDS_PER_MINUTE) || 1);
// Addresses under .invalid (sample or test records) are skipped.
const deliverable = to => typeof to === 'string' && /@/.test(to) && !/\.invalid$/i.test(to.trim());

// emails: [{ key, kind, to, subject, text, html }]. Already-queued keys are
// skipped. Returns how many were newly queued.
async function queueEmails(emails) {
  const docs = emails.filter(e => deliverable(e.to));
  if (!docs.length) return 0;
  if (!mailEnabled()) {
    docs.forEach(e => console.log(`[mail off] would email ${e.to}: ${e.subject}`));
    return 0;
  }
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

// Send times in the last minute (this server), for the per-minute limit;
// processOutbox runs every minute and right after a message alert.
const recentSends = [];
let running = false;
async function processOutbox() {
  if (running || !mailEnabled()) return;
  running = true;
  try {
    for (;;) {
      while (recentSends.length && recentSends[0] < Date.now() - 60_000) recentSends.shift();
      if (recentSends.length >= perRun()) return;
      const email = await OutboxEmail.findOneAndUpdate(
        { status: 'queued', nextAttemptAt: { $lte: new Date() } },
        // Claimed for 10 minutes, so another server doesn't send it too.
        { $inc: { attempts: 1 }, $set: { nextAttemptAt: new Date(Date.now() + 10 * 60_000) } },
        { sort: { priority: -1, nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }
      );
      if (!email) return;
      recentSends.push(Date.now());
      const ok = await sendMail({ to: email.to, subject: email.subject, text: email.text, html: email.html, wait: true });
      if (ok) {
        await OutboxEmail.updateOne({ _id: email._id }, { $set: { status: 'sent', sentAt: new Date() }, $unset: { error: '' } });
      } else if (email.attempts >= MAX_ATTEMPTS) {
        await OutboxEmail.updateOne({ _id: email._id }, { $set: { status: 'failed', error: 'The email service refused it 5 times (often the hourly limit). Check the server log.' } });
      } else {
        await OutboxEmail.updateOne({ _id: email._id }, { $set: { nextAttemptAt: new Date(Date.now() + email.attempts * 15 * 60_000) } });
        return; // probably the hourly limit: stop for now
      }
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
