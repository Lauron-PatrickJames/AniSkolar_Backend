const DutyLog = require('../models/DutyLog');
const Student = require('../models/Student');
const { norm, officesWithHeads } = require('./offices');
const { renderEmail } = require('./emailTemplate');
const { queueEmails, processOutbox } = require('./outbox');

// Duties the office head hasn't confirmed or flagged within 48 hours of
// being logged are removed (AdSO, Nov 2026), and the scholar is emailed
// and sees them on their Duty hours page. Only for offices with a head in
// AniSkolar: elsewhere nobody confirms duties, so nothing expires.
// Runs every 15 minutes from server.js.

const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000;
const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';

function to12h(time) {
  const [h, m] = time.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function longDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

async function expireUnreviewedDuties(now = new Date()) {
  const cutoff = new Date(now.getTime() - REVIEW_WINDOW_MS);
  const logs = await DutyLog.find({
    entries: { $elemMatch: { status: { $exists: false }, loggedAt: { $lte: cutoff } } },
  }).select('studentNumber academicYear term officeAssigned entries').lean();
  if (!logs.length) return 0;

  const headOffices = await officesWithHeads();
  let removed = 0;
  for (const log of logs) {
    if (!headOffices.has(norm(log.officeAssigned))) continue;
    const stale = log.entries.filter(e => !e.status && e.loggedAt && new Date(e.loggedAt) <= cutoff);
    if (!stale.length) continue;
    const ids = stale.map(e => e._id);
    // Only entries that are still unreviewed (the head may be confirming now).
    const res = await DutyLog.updateOne(
      { _id: log._id },
      {
        $pull: { entries: { _id: { $in: ids }, status: { $exists: false } } },
        $push: { expiredEntries: { $each: stale.map(e => ({ date: e.date, timeIn: e.timeIn, timeOut: e.timeOut, loggedAt: e.loggedAt, removedAt: now })) } },
      }
    );
    if (!res.modifiedCount) continue;
    removed += stale.length;
    await notifyScholar(log, stale).catch(err => console.error('Expired duty email failed:', err));
  }
  if (removed) console.log(`Removed ${removed} duty entr${removed === 1 ? 'y' : 'ies'} not reviewed within 48 hours.`);
  return removed;
}

async function notifyScholar(log, stale) {
  const student = await Student.findOne({ studentNumber: log.studentNumber }).select('name email').lean();
  if (!student?.email) return;
  const lines = stale.map(e => `• ${longDate(e.date)}, ${to12h(e.timeIn)}–${to12h(e.timeOut)}`).join('\n');
  const many = stale.length > 1;
  const { html, text } = renderEmail({
    heading: many ? 'Some of your duties were removed' : 'A duty you logged was removed',
    intro: `${log.officeAssigned}, ${log.term}, A.Y. ${log.academicYear}–${log.academicYear + 1}.`,
    body: `Good day${student.name ? `, ${student.name}` : ''}!\n\nYour office head didn’t confirm ${many ? 'these duties' : 'this duty'} within 48 hours, so ${many ? 'they were' : 'it was'} removed from your duty hours:\n\n${lines}\n\nIf you did render ${many ? 'them' : 'it'}, talk to your office head or the Admissions and Scholarship Office. Remind your office head to confirm your duties within two days of logging them.`,
    button: { url: appUrl(), label: 'View your duty hours' },
  });
  const key = `duty-expired:${log._id}:${stale.map(e => String(e._id)).join(',')}`;
  const n = await queueEmails([{ key, kind: 'dutyExpired', to: student.email, subject: 'AniSkolar: unconfirmed duty removed', text, html }]);
  if (n) processOutbox().catch(() => {});
}

module.exports = { expireUnreviewedDuties, REVIEW_WINDOW_MS };
