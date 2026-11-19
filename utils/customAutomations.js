const CustomAutomation = require('../models/CustomAutomation');
const { EVENTS, FREQUENCIES, AUDIENCES } = CustomAutomation;
const Application = require('../models/Application');
const OutboxEmail = require('../models/OutboxEmail');
const Renewal = require('../models/Renewal');
const Student = require('../models/Student');
const { findScholarship } = require('../data/scholarships');
const { parseEmailTarget, recipientStudents } = require('./emailTarget');
const { listOffices } = require('./offices');
const { renderEmail } = require('./emailTemplate');
const { queueEmails } = require('./outbox');
const { properName } = require('./names');
const { todayInManila } = require('./dutyHours');

// The AdSO's own automations (models/CustomAutomation.js). runDueCustom()
// runs with the built-in jobs every 15 minutes (utils/automation.js):
//   schedule  sends once per day / week / month (claimed atomically, so two
//             servers never both send it) at or after its hour, Manila time
//   event     emails the student behind each matching application or
//             renewal change since it was switched on (looking back at
//             most 7 days)
// The subject and message can use {firstName}, {scholarship}, {status} and
// {office}. Emails go through the outbox; each has a key, so a run never
// emails anyone twice.

const EVENT_LOOKBACK_DAYS = 7;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What each event watches: the collection, the status (none = submitted),
// and the time that marks it.
const EVENT_DEFS = {
  applicationSubmitted: { model: () => Application, kind: 'application', at: 'createdAt' },
  applicationApproved: { model: () => Application, kind: 'application', status: 'Approved', at: 'reviewedAt' },
  applicationNeedsRevision: { model: () => Application, kind: 'application', status: 'Needs Revision', at: 'reviewedAt' },
  applicationRejected: { model: () => Application, kind: 'application', status: 'Rejected', at: 'reviewedAt' },
  renewalSubmitted: { model: () => Renewal, kind: 'renewal', at: 'createdAt' },
  renewalRenewed: { model: () => Renewal, kind: 'renewal', status: 'Renewed', at: 'reviewedAt' },
  renewalNeedsRevision: { model: () => Renewal, kind: 'renewal', status: 'Needs Revision', at: 'reviewedAt' },
  renewalNotRenewed: { model: () => Renewal, kind: 'renewal', status: 'Not Renewed', at: 'reviewedAt' },
};

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (v === '' || v === null || v === undefined ? NaN : Number(v));

// Validates an automation from the Automation page. Returns { value } or
// { error }. `now` is for refusing a one-time date in the past.
function parseAutomation(body, { now = new Date() } = {}) {
  const b = body || {};
  const name = text(b.name, 100);
  if (!name) return { error: 'Give the automation a name.' };
  const subject = text(b.subject, 150);
  if (!subject) return { error: 'Write the email’s subject.' };
  const message = text(b.body, 5000);
  if (!message) return { error: 'Write the email’s message.' };
  const value = { name, subject, body: message };
  if (b.enabled !== undefined) value.enabled = b.enabled === true;

  if (b.trigger === 'schedule') {
    value.trigger = 'schedule';
    if (!FREQUENCIES.includes(b.frequency)) return { error: 'Choose how often it sends.' };
    value.frequency = b.frequency;
    const hour = int(b.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: 'Choose the time it sends.' };
    value.hour = hour;
    if (b.frequency === 'once') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || Number.isNaN(Date.parse(`${b.date}T00:00:00Z`))) return { error: 'Choose the date it sends.' };
      if (b.date < todayInManila(now)) return { error: 'Choose today or a later date.' };
      value.date = b.date;
    }
    if (b.frequency === 'weekly') {
      const weekday = int(b.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'Choose the day of the week it sends.' };
      value.weekday = weekday;
    }
    if (b.frequency === 'monthly') {
      const day = int(b.dayOfMonth);
      if (!Number.isInteger(day) || day < 1 || day > 28) return { error: 'Choose a day of the month from 1 to 28.' };
      value.dayOfMonth = day;
    }
    if (!AUDIENCES.includes(b.audience)) return { error: 'Choose who gets the email.' };
    value.audience = b.audience;
    if (b.audience === 'students') {
      const target = parseEmailTarget(b.emailTarget);
      if (target.error) return { error: target.error };
      value.emailTarget = target.value;
    }
    return { value };
  }

  if (b.trigger === 'event') {
    value.trigger = 'event';
    if (!EVENTS.includes(b.event)) return { error: 'Choose what triggers the email.' };
    value.event = b.event;
    const ids = Array.isArray(b.scholarshipIds) ? [...new Set(b.scholarshipIds.filter(id => typeof id === 'string'))] : [];
    if (ids.some(id => !findScholarship(id))) return { error: 'Unknown scholarship.' };
    value.scholarshipIds = ids;
    return { value };
  }
  return { error: 'Choose whether it runs on a schedule or when something happens.' };
}

// Fills {firstName}, {scholarship}, {status} and {office}; unknown ones stay.
function fill(template, vars) {
  return template.replace(/\{(firstName|scholarship|status|office)\}/g, (m, k) => (vars[k] ? vars[k] : (k === 'firstName' ? 'there' : m)));
}

function buildEmail(a, key, to, vars) {
  const { appUrl } = require('./automation');
  const subject = fill(a.subject, vars);
  const { html, text: plain } = renderEmail({ heading: subject, body: fill(a.body, vars), button: { url: appUrl(), label: 'Open AniSkolar' } });
  return { key, kind: `custom:${a._id}`, to, subject, html, text: plain };
}

// The run's period for a schedule, e.g. '2026-11-19', '2026-W47', '2026-11'.
function periodOf(a, clock) {
  const { isoWeek } = require('./automation');
  if (a.frequency === 'weekly') return isoWeek(clock.date);
  if (a.frequency === 'monthly') return clock.date.slice(0, 7);
  if (a.frequency === 'once') return a.date;
  return clock.date;
}

function isDue(a, clock) {
  if (clock.hour < (a.hour ?? 8)) return false;
  if (a.frequency === 'once') return clock.date >= a.date;
  if (a.frequency === 'weekly') return WEEKDAYS[a.weekday] === clock.weekday;
  if (a.frequency === 'monthly') return Number(clock.date.slice(8, 10)) === a.dayOfMonth;
  return true;
}

// The emails a schedule sends for `period`.
async function scheduleEmails(a, period) {
  if (a.audience === 'officeHeads') {
    const heads = (await listOffices()).filter(o => o.headEmail);
    return heads.map(h => buildEmail(a, `custom:${a._id}:${period}:${h.headEmail}`, h.headEmail, { firstName: h.headName, office: h.office }));
  }
  const students = await recipientStudents(a.emailTarget || { mode: 'all' });
  return students.map(s => buildEmail(a, `custom:${a._id}:${period}:${s.email}`, s.email, { firstName: properName(s.firstName) }));
}

// The emails an event automation sends for changes since it was switched
// on (at most EVENT_LOOKBACK_DAYS back).
async function eventEmails(a, now) {
  const def = EVENT_DEFS[a.event];
  const since = new Date(Math.max(new Date(a.activeSince || now).getTime(), now.getTime() - EVENT_LOOKBACK_DAYS * 86400000));
  const filter = { [def.at]: { $gte: since, $lte: now } };
  if (def.status) filter.status = def.status;
  if (a.scholarshipIds?.length) filter.scholarshipId = { $in: a.scholarshipIds };
  const docs = await def.model().find(filter).select(`studentNumber scholarshipId scholarshipName status ${def.at}`).lean();
  const students = new Map((await Student.find({ studentNumber: { $in: docs.map(d => d.studentNumber) } }).select('studentNumber email firstName').lean()).map(s => [s.studentNumber, s]));
  const emails = [];
  for (const d of docs) {
    const s = students.get(d.studentNumber);
    if (!s?.email) continue;
    const at = new Date(d[def.at]).getTime();
    emails.push(buildEmail(a, `custom:${a._id}:${def.kind}:${d._id}:${def.status || 'submitted'}:${at}`, s.email.toLowerCase(), {
      firstName: properName(s.firstName),
      scholarship: d.scholarshipName || findScholarship(d.scholarshipId)?.name,
      status: def.status || 'Submitted',
    }));
  }
  return emails;
}

// Leaves out emails already queued or sent (same key).
async function notYetSent(emails) {
  if (!emails.length) return emails;
  const done = new Set(await OutboxEmail.distinct('key', { key: { $in: emails.map(e => e.key) } }));
  return emails.filter(e => e.to && !done.has(e.key));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Runs one automation now. `period` (schedules) defaults to a manual run
// today, so "run now" twice in a day sends once. Returns the same shape as
// the built-in jobs' runJob: { queued, summary, emails, sample }.
async function runCustom(a, { now = new Date(), dryRun = false, period } = {}) {
  const emails = await notYetSent(a.trigger === 'event'
    ? await eventEmails(a, now)
    : await scheduleEmails(a, period || `manual-${todayInManila(now)}`));
  const queued = dryRun ? 0 : await queueEmails(emails);
  const summary = emails.length
    ? `${plural(emails.length, 'email')} to send.`
    : a.trigger === 'event' ? 'Nothing new since it was switched on.' : 'Nobody to email.';
  return { queued, summary, emails: emails.length, details: null, sample: emails.slice(0, 5).map(e => ({ to: e.to, subject: e.subject })) };
}

async function record(a, period, result, error) {
  await CustomAutomation.updateOne({ _id: a._id }, {
    $set: {
      lastRun: { period, at: new Date(), queued: result?.queued ?? 0, summary: result?.summary ?? '', ...(error ? { error } : {}) },
      // A one-time email is done once it went out.
      ...(a.trigger === 'schedule' && a.frequency === 'once' && !error && period === a.date ? { enabled: false } : {}),
    },
  });
}

// Every 15 minutes, from runDueJobs.
async function runDueCustom(now = new Date()) {
  const { manilaClock } = require('./automation');
  const clock = manilaClock(now);
  const list = await CustomAutomation.find({ enabled: true }).lean();
  for (const a of list) {
    try {
      if (a.trigger === 'event') {
        const result = await runCustom(a, { now });
        if (result.queued) await record(a, 'event', { ...result, summary: `${plural(result.queued, 'email')} sent.` });
        continue;
      }
      if (!isDue(a, clock)) continue;
      const period = periodOf(a, clock);
      const claimed = await CustomAutomation.updateOne(
        { _id: a._id, enabled: true, 'lastRun.period': { $ne: period } },
        { $set: { lastRun: { period, at: now, queued: 0, summary: 'Running…' } } }
      );
      if (!claimed.modifiedCount) continue;
      const result = await runCustom(a, { now, period });
      await record(a, period, { ...result, summary: `${plural(result.queued, 'email')} sent.` });
    } catch (err) {
      console.error(`Custom automation ${a._id} failed:`, err);
      await record(a, a.trigger === 'event' ? 'event' : periodOf(a, clock), null, err.message).catch(() => {});
    }
  }
}

module.exports = { parseAutomation, runCustom, runDueCustom, isDue, periodOf, fill, EVENT_DEFS };
