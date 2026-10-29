const AutomationSetting = require('../models/AutomationSetting');
const { RENEWAL_DOCUMENTS } = require('../models/RenewalPeriod');
const Application = require('../models/Application');
const ApplicationDraft = require('../models/ApplicationDraft');
const DutyLog = require('../models/DutyLog');
const Message = require('../models/Message');
const OfficeRequest = require('../models/OfficeRequest');
const OutboxEmail = require('../models/OutboxEmail');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const Student = require('../models/Student');
const { findScholarship } = require('../data/scholarships');
const { academicYearStart } = require('./academicYear');
const { currentTerm, todayInManila } = require('./dutyHours');
const { findHolders, findCurrentHolders, previousTerm } = require('./renewals');
const { listOffices, norm, officesWithHeads } = require('./offices');
const { officeFilter } = require('./officeScope');
const { renderEmail } = require('./emailTemplate');
const { queueEmails } = require('./outbox');

// What AniSkolar does on its own, each switched on by the AdSO on the
// Automation page (models/AutomationSetting.js). runDueJobs() runs every
// 15 minutes from server.js; each job runs once per day or week (claimed
// atomically, so two servers never both run it). Emails go through the
// outbox (utils/outbox.js), and every email has a key, so running a job
// again never emails anyone twice.
//
//   dutyReminders        Mondays: SFAG scholars behind on duty hours (or
//                        not started) get their numbers and weekly pace.
//   officeHeadReminders  Mondays: office heads with duties to confirm or
//                        scholars to evaluate.
//   deadlineReminders    daily: 3 days and 1 day before a renewal or
//                        application deadline, to scholars who haven't
//                        submitted / students with an unsent draft; and
//                        3 days after "Needs Revision" if nothing changed.
//   adsoDigest           daily: one summary email to the AdSO staff listed.
//   termRollover         daily in a term's first 8 weeks: SFAG scholars
//                        without an office get one (last term's office if
//                        it has room, else at random by the office slots),
//                        and they and the office heads are emailed.

const TZ = 'Asia/Manila';
// Weeks scholars have to finish their hours, for "on track" (a semester is
// about 16–17 weeks of classes).
const TERM_WEEKS = 16;
const ROLLOVER_WEEKS = 8;
const { SFAG_ID } = require('../middleware/requireStudent');

const appUrl = () => process.env.APP_URL || (process.env.FRONTEND_ORIGINS || '').split(',')[0].trim() || 'http://localhost:3000';
const fmt = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function manilaClock(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  return {
    date: todayInManila(now),
    hour: Number(parts.find(p => p.type === 'hour').value),
    weekday: parts.find(p => p.type === 'weekday').value,
  };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ISO week of a YYYY-MM-DD date, e.g. '2026-W43'.
function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

const longDate = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));

// Deadlines are typed by the AdSO ("January 20, 2027"). Returns YYYY-MM-DD,
// or null when it isn't one clear date (e.g. "June 1–20, 2026").
function parseDeadline(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (!/\b(19|20)\d{2}\b/.test(t) || /[–—]|\bto\b/i.test(t)) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The first day of a duty term (see currentTerm in utils/dutyHours.js).
const termStart = t => (t.term === '1st Semester' ? `${t.academicYear}-08-01` : `${t.academicYear + 1}-01-01`);
const termLabel = t => `${t.term}, A.Y. ${t.academicYear}–${t.academicYear + 1}`;

function email({ key, kind, to, subject, heading, intro, body, buttonLabel = 'Open AniSkolar' }) {
  const { html, text } = renderEmail({ heading, intro, body, button: { url: appUrl(), label: buttonLabel } });
  return { key, kind, to, subject, html, text };
}

async function studentsBy(numbers) {
  const students = await Student.find({ studentNumber: { $in: [...numbers] } }).select('studentNumber name firstName email').lean();
  return new Map(students.map(s => [s.studentNumber, s]));
}
const hi = s => `Hi ${s?.firstName || 'there'},`;

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Jobs ---------------------------------------------------------------------
// Each returns { emails, summary, details? } and changes nothing when dryRun.

async function dutyReminders({ now }) {
  const { dutyHelpers } = require('../routes/dutyHours');
  const term = currentTerm(now);
  const today = todayInManila(now);
  const week = isoWeek(today);
  const weeksIn = Math.floor(daysBetween(termStart(term), today) / 7);
  if (weeksIn < 2) return { emails: [], summary: 'Too early in the semester (reminders start in week 3).' };

  const holders = [...await findCurrentHolders({ scholarshipId: SFAG_ID, ...term })];
  const [logs, rules, eventsById, headOffices, students] = await Promise.all([
    DutyLog.find({ ...term, studentNumber: { $in: holders } }).lean(),
    dutyHelpers.dutyRules(holders),
    dutyHelpers.termEvents(term),
    officesWithHeads(),
    studentsBy(holders),
  ]);
  const logOf = new Map(logs.map(l => [l.studentNumber, l]));
  const emails = [];
  let notStarted = 0;
  for (const sn of holders) {
    const log = logOf.get(sn);
    const rule = rules.get(sn);
    const s = log ? dutyHelpers.logView(log, today, rule, eventsById, headOffices).summary : null;
    const required = s?.required ?? rule?.requiredHours ?? null;
    if (!required) continue; // nothing to measure against
    const completed = s?.completed ?? 0;
    if (completed >= required) continue;
    const expected = required * Math.min(1, weeksIn / TERM_WEEKS);
    const started = !!log?.entries?.length;
    // 20% leeway before calling someone behind.
    if (started && completed >= expected * 0.8) continue;
    if (!started) notStarted++;
    const lines = [
      hi(students.get(sn)),
      '',
      started ? "You're behind on your SFAG duty hours this semester." : "You haven't logged any SFAG duty yet this semester.",
      '',
      `- Completed: ${fmt(completed)} of ${fmt(required)} hours (${fmt(required - completed)} left)`,
      `- On track would be about ${fmt(expected)} hours by now`,
      s?.weeklyNeeded && log?.deadline
        ? `- To finish by ${longDate(log.deadline)}: about ${fmt(s.weeklyNeeded)} hours a week`
        : '- The scholarship office will set this semester’s deadline; then you’ll see how much you need each week',
      `- Office: ${log?.officeAssigned || 'not assigned yet (the scholarship office will assign one)'}`,
    ];
    if (s?.waitingCount) lines.push(`- ${plural(s.waitingCount, 'duty', 'duties')} waiting for your office to confirm (only confirmed duties count)`);
    if (s?.flaggedCount) lines.push(`- ${plural(s.flaggedCount, 'duty', 'duties')} flagged by your office: open the Duty Hours page to see why`);
    lines.push('', 'Log each duty on the Duty Hours page after you render it. If something is wrong with these numbers, message the scholarship office in AniSkolar.');
    emails.push(email({
      key: `duty:${term.academicYear}:${term.term}:${sn}:${week}`,
      kind: 'dutyReminders',
      to: students.get(sn)?.email,
      subject: started ? 'AniSkolar: you are behind on your duty hours' : 'AniSkolar: you have not started your duty hours',
      heading: 'Your duty hours this semester',
      intro: `${fmt(completed)} of ${fmt(required)} hours done, ${termLabel(term)}.`,
      body: lines.join('\n'),
    }));
  }
  return { emails, summary: emails.length ? `${plural(emails.length, 'scholar')} behind (${notStarted} not started).` : 'Every scholar is on track.' };
}

async function officeHeadReminders({ now }) {
  const today = todayInManila(now);
  const week = isoWeek(today);
  const term = currentTerm(now);
  const prev = previousTerm(term);
  const heads = (await listOffices()).filter(o => o.headEmail);
  if (!heads.length) return { emails: [], summary: 'No office heads listed yet (Duty hours → Offices).' };
  const logs = await DutyLog.find({
    $or: [term, prev].map(t => ({ academicYear: t.academicYear, term: t.term })),
    officeAssigned: { $nin: [null, ''] },
    entries: { $elemMatch: { status: { $exists: false } } },
  }).select('officeAssigned entries studentNumber').lean();
  const waiting = new Map();
  for (const log of logs) {
    const k = norm(log.officeAssigned);
    const w = waiting.get(k) ?? { duties: 0, scholars: new Set() };
    w.duties += log.entries.filter(e => !e.status).length;
    w.scholars.add(log.studentNumber);
    waiting.set(k, w);
  }
  const ready = await require('./evaluations').readyCounts();
  const emails = [];
  for (const head of heads) {
    const k = norm(head.office);
    const w = waiting.get(k);
    const toEvaluate = ready.get(k) ?? 0;
    if (!w?.duties && !toEvaluate) continue;
    const lines = [`Good day${head.headName ? `, ${head.headName}` : ''}!`, '', `Here is what is waiting for you in AniSkolar for ${head.office}:`, ''];
    if (w?.duties) lines.push(`- ${plural(w.duties, 'duty', 'duties')} from ${plural(w.scholars.size, 'scholar')} to confirm or flag (only confirmed duties count toward their hours)`);
    if (toEvaluate) lines.push(`- ${plural(toEvaluate, 'scholar')} who finished their duty hours, ready for your evaluation`);
    lines.push('', 'Sign in to AniSkolar with your school email to open your office portal.');
    emails.push(email({
      key: `officehead:${head.headEmail}:${week}`,
      kind: 'officeHeadReminders',
      to: head.headEmail,
      subject: `AniSkolar: ${w?.duties ? 'duties to confirm' : 'scholars to evaluate'} for ${head.office}`,
      heading: 'Waiting for you in AniSkolar',
      body: lines.join('\n'),
    }));
  }
  return { emails, summary: emails.length ? `${plural(emails.length, 'office head')} with something to do.` : 'Nothing waiting for any office head.' };
}

async function deadlineReminders({ now }) {
  const today = todayInManila(now);
  const emails = [];
  const counts = { renewal: 0, draft: 0, revision: 0 };

  // Renewals not yet submitted, 3 days and 1 day before the deadline.
  const periods = await RenewalPeriod.find({ open: true }).lean();
  for (const period of periods) {
    const deadline = parseDeadline(period.deadline);
    const left = deadline ? daysBetween(today, deadline) : null;
    if (left !== 3 && left !== 1) continue;
    const name = findScholarship(period.scholarshipId)?.name ?? 'scholarship';
    const [holders, submitted] = await Promise.all([findHolders(period), Renewal.distinct('studentNumber', { periodId: period._id })]);
    const done = new Set(submitted);
    const missing = [...holders.keys()].filter(sn => !done.has(sn));
    const students = await studentsBy(missing);
    for (const sn of missing) {
      counts.renewal++;
      emails.push(email({
        key: `renewal-deadline:${period._id}:${sn}:${left}`,
        kind: 'deadlineReminders',
        to: students.get(sn)?.email,
        subject: `AniSkolar: renew your ${name} by ${longDate(deadline)}`,
        heading: `${left === 1 ? 'Tomorrow' : 'In 3 days'}: ${name} renewal deadline`,
        intro: `You haven't submitted your renewal for the ${period.term}, A.Y. ${period.academicYear}–${period.academicYear + 1}.`,
        body: [hi(students.get(sn)), '', `The deadline is ${longDate(deadline)}. Open Renewals in AniSkolar to submit your grades:`, ...RENEWAL_DOCUMENTS.map(r => `- ${r}`), '', "If you're not continuing (OJT, graduating, transferring), say so in the same form so the office knows."].join('\n'),
      }));
    }
  }

  // Application drafts not yet submitted, 3 days and 1 day before the
  // scholarship's deadline.
  const settings = await ScholarshipSetting.find({ deadline: { $nin: [null, ''] }, status: { $ne: 'Closed' } }).select('scholarshipId deadline').lean();
  for (const setting of settings) {
    const deadline = parseDeadline(setting.deadline);
    const left = deadline ? daysBetween(today, deadline) : null;
    if (left !== 3 && left !== 1) continue;
    const name = findScholarship(setting.scholarshipId)?.name ?? 'scholarship';
    const drafts = await ApplicationDraft.find({ scholarshipId: setting.scholarshipId }).select('studentNumber').lean();
    const ay = academicYearStart(now);
    const applied = new Set((await Application.find({ scholarshipId: setting.scholarshipId, studentNumber: { $in: drafts.map(d => d.studentNumber) } }).select('studentNumber createdAt').lean())
      .filter(a => academicYearStart(a.createdAt) === ay).map(a => a.studentNumber));
    const pending = drafts.map(d => d.studentNumber).filter(sn => !applied.has(sn));
    const students = await studentsBy(pending);
    for (const sn of pending) {
      counts.draft++;
      emails.push(email({
        key: `draft-deadline:${setting.scholarshipId}:${sn}:${deadline}:${left}`,
        kind: 'deadlineReminders',
        to: students.get(sn)?.email,
        subject: `AniSkolar: finish your ${name} application by ${longDate(deadline)}`,
        heading: `${left === 1 ? 'Tomorrow' : 'In 3 days'}: ${name} deadline`,
        intro: 'You started an application but haven\'t submitted it yet.',
        body: [hi(students.get(sn)), '', `Your saved answers are waiting in AniSkolar. Finish and submit it by ${longDate(deadline)}; a draft isn't an application.`].join('\n'),
      }));
    }
  }

  // "Needs Revision" with nothing changed 3 days later (once per decision).
  const from = new Date(now.getTime() - 30 * 86400000);
  const to = new Date(now.getTime() - 3 * 86400000);
  const [renewals, apps] = await Promise.all([
    Renewal.find({ status: 'Needs Revision', reviewedAt: { $gte: from, $lte: to } }).select('studentNumber scholarshipName reviewedAt reviewNote').lean(),
    Application.find({ status: 'Needs Revision', reviewedAt: { $gte: from, $lte: to } }).select('studentNumber scholarshipName scholarshipId referenceCode reviewedAt reviewNote').lean(),
  ]);
  const students = await studentsBy([...renewals, ...apps].map(r => r.studentNumber));
  for (const [kind, list] of [['renewal', renewals], ['application', apps]]) {
    for (const r of list) {
      counts.revision++;
      const name = r.scholarshipName || findScholarship(r.scholarshipId)?.name || 'scholarship';
      emails.push(email({
        key: `revision:${kind}:${r._id}:${new Date(r.reviewedAt).getTime()}`,
        kind: 'deadlineReminders',
        to: students.get(r.studentNumber)?.email,
        subject: `AniSkolar: your ${name} ${kind} still needs changes`,
        heading: `Your ${kind} needs changes`,
        intro: `The office asked you to revise your ${name} ${kind}${r.referenceCode ? ` (${r.referenceCode})` : ''}.`,
        body: [hi(students.get(r.studentNumber)), '', ...(r.reviewNote ? ['The office wrote:', r.reviewNote, ''] : []), `Open it in AniSkolar, make the changes and resubmit so it can be decided.`].join('\n'),
      }));
    }
  }
  const total = counts.renewal + counts.draft + counts.revision;
  return { emails, summary: total ? `${counts.renewal} renewal, ${counts.draft} draft and ${counts.revision} revision reminders.` : 'Nothing due today.' };
}

// The numbers in the AdSO's morning summary.
async function digestCounts(now) {
  const lso = officeFilter({ office: 'LSO' });
  const term = currentTerm(now);
  const [newApps, toReview, unread, requests, renewals, claims, failed, holders, assigned] = await Promise.all([
    Application.countDocuments({ ...lso, createdAt: { $gte: new Date(now.getTime() - 24 * 3600_000) } }),
    Application.countDocuments({ ...lso, status: 'Under Evaluation' }),
    Message.countDocuments({ from: { $in: ['student', 'office'] }, readAt: null }),
    OfficeRequest.countDocuments({ status: 'open' }),
    Renewal.countDocuments({ status: 'Under Evaluation' }),
    DutyLog.aggregate([{ $match: { ...term, 'eventClaims.status': 'Pending' } }, { $unwind: '$eventClaims' }, { $match: { 'eventClaims.status': 'Pending' } }, { $count: 'n' }]),
    OutboxEmail.countDocuments({ status: 'failed', updatedAt: { $gte: new Date(now.getTime() - 24 * 3600_000) } }),
    findCurrentHolders({ scholarshipId: SFAG_ID, ...term }),
    DutyLog.distinct('studentNumber', { ...term, officeAssigned: { $nin: [null, ''] } }),
  ]);
  const withOffice = new Set(assigned);
  return {
    newApps, toReview, unread, requests, renewals,
    claims: claims[0]?.n ?? 0,
    failed,
    noOffice: [...holders].filter(sn => !withOffice.has(sn)).length,
  };
}

async function adsoDigest({ now, settings }) {
  const to = (settings.adsoDigestTo || []).filter(Boolean);
  if (!to.length) return { emails: [], summary: 'No one to send it to: add the AdSO emails.' };
  const c = await digestCounts(now);
  const lines = [
    c.newApps && `- ${plural(c.newApps, 'new application')} since yesterday`,
    c.toReview && `- ${plural(c.toReview, 'application')} under evaluation`,
    c.renewals && `- ${plural(c.renewals, 'renewal')} to decide`,
    c.unread && `- ${plural(c.unread, 'unread message')}`,
    c.requests && `- ${plural(c.requests, 'open office request')}`,
    c.claims && `- ${plural(c.claims, 'event claim')} to approve`,
    c.noOffice && `- ${plural(c.noOffice, 'SFAG scholar')} without a duty office`,
    c.failed && `- ${plural(c.failed, 'email')} AniSkolar couldn't send in the last day (see Automation)`,
  ].filter(Boolean);
  if (!lines.length) return { emails: [], summary: 'Nothing waiting, so no summary was sent.', details: c };
  const today = todayInManila(now);
  const emails = to.map(address => email({
    key: `digest:${today}:${address}`,
    kind: 'adsoDigest',
    to: address,
    subject: `AniSkolar today: ${lines.length} ${lines.length === 1 ? 'thing' : 'things'} waiting`,
    heading: `Good morning! Here's AniSkolar for ${longDate(today)}`,
    body: lines.join('\n'),
  }));
  return { emails, summary: `${lines.length} items in the summary.`, details: c };
}

// Deals scholars into offices' free slots at random, round by round, like
// Random assign on the Duty hours page.
function deal(scholars, free) {
  const queue = shuffled(scholars);
  const left = new Map(free);
  const result = new Map();
  while (queue.length) {
    const open = shuffled([...left.entries()].filter(([, n]) => n > 0).map(([office]) => office));
    if (!open.length) break;
    for (const office of open) {
      const sn = queue.shift();
      if (!sn) break;
      result.set(sn, office);
      left.set(office, left.get(office) - 1);
    }
  }
  return { assigned: result, leftOver: queue };
}

async function termRollover({ now, dryRun, settings }) {
  const { dutyHelpers } = require('../routes/dutyHours');
  const term = currentTerm(now);
  const today = todayInManila(now);
  const daysIn = daysBetween(termStart(term), today);
  if (daysIn < 0 || daysIn >= ROLLOVER_WEEKS * 7) return { emails: [], summary: `Only runs in the first ${ROLLOVER_WEEKS} weeks of a semester.` };
  const offices = (await listOffices()).filter(o => o.slots > 0);
  if (!offices.length) return { emails: [], summary: 'No office slots set yet (Duty hours → Random assign or Offices).' };

  const holders = [...await findCurrentHolders({ scholarshipId: SFAG_ID, ...term })];
  const logs = await DutyLog.find({ ...term }).select('studentNumber officeAssigned').lean();
  const officeOf = new Map(logs.filter(l => l.officeAssigned).map(l => [l.studentNumber, l.officeAssigned]));
  const unassigned = holders.filter(sn => !officeOf.has(sn));
  if (!unassigned.length) return { emails: [], summary: 'Every SFAG scholar has an office.' };

  const byNorm = new Map(offices.map(o => [norm(o.office), o]));
  const free = new Map(offices.map(o => [o.office, o.slots]));
  for (const office of officeOf.values()) {
    const o = byNorm.get(norm(office));
    if (o) free.set(o.office, free.get(o.office) - 1);
  }
  // Last term's office first, when it still has room.
  const assignment = new Map();
  if (settings.keepLastOffice) {
    const prev = previousTerm(term);
    const prevLogs = await DutyLog.find({ ...prev, studentNumber: { $in: unassigned }, officeAssigned: { $nin: [null, ''] } }).select('studentNumber officeAssigned').lean();
    for (const l of shuffled(prevLogs)) {
      const o = byNorm.get(norm(l.officeAssigned));
      if (o && free.get(o.office) > 0) {
        assignment.set(l.studentNumber, o.office);
        free.set(o.office, free.get(o.office) - 1);
      }
    }
  }
  const kept = assignment.size;
  const { assigned, leftOver } = deal(unassigned.filter(sn => !assignment.has(sn)), free);
  for (const [sn, office] of assigned) assignment.set(sn, office);

  if (!dryRun && assignment.size) {
    await DutyLog.bulkWrite([...assignment].map(([studentNumber, office]) => ({
      updateOne: {
        // Only if nobody assigned them in the meantime.
        filter: { studentNumber, ...term, officeAssigned: { $in: [null, ''] } },
        update: { $set: { officeAssigned: office, officeAssignedBy: 'AniSkolar (automatic)', officeAssignedAt: now }, $setOnInsert: { entries: [], specialEvents: [] } },
        upsert: !officeOf.has(studentNumber) && !logs.some(l => l.studentNumber === studentNumber),
      },
    })));
  }

  const [students, rules] = await Promise.all([studentsBy(assignment.keys()), dutyHelpers.dutyRules([...assignment.keys()])]);
  const emails = [];
  const byOffice = new Map();
  for (const [sn, office] of assignment) {
    const o = byNorm.get(norm(office));
    byOffice.set(office, [...(byOffice.get(office) ?? []), sn]);
    const hours = rules.get(sn)?.requiredHours;
    emails.push(email({
      key: `assigned:${term.academicYear}:${term.term}:${sn}`,
      kind: 'termRollover',
      to: students.get(sn)?.email,
      subject: `AniSkolar: your duty office this semester is ${office}`,
      heading: 'Your duty office this semester',
      intro: `${office}, ${termLabel(term)}.`,
      body: [
        hi(students.get(sn)), '',
        `You'll render your SFAG duty hours at ${office}${o?.headName ? `, headed by ${o.headName}` : ''}.`,
        '',
        ...(hours ? [`- Required this semester: ${fmt(hours)} hours`] : []),
        '- Duty is Monday–Thursday 8:00 AM–6:00 PM and Friday until 5:00 PM, not over the 12:00–1:00 PM lunch break, at least 1.5 hours at a time',
        '- Log each duty on the Duty Hours page; your office head confirms them',
        '', 'Please report to the office in your first week. If you have a conflict, message the scholarship office in AniSkolar.',
      ].join('\n'),
    }));
  }
  for (const [office, sns] of byOffice) {
    const o = byNorm.get(norm(office));
    if (!o?.headEmail) continue;
    emails.push(email({
      key: `office-new:${term.academicYear}:${term.term}:${norm(office)}:${today}`,
      kind: 'termRollover',
      to: o.headEmail,
      subject: `AniSkolar: ${plural(sns.length, 'new scholar')} for ${office}`,
      heading: `New scholars for ${office}`,
      intro: `${termLabel(term)}.`,
      body: [
        `Good day${o.headName ? `, ${o.headName}` : ''}!`, '',
        `These SFAG scholars will render duty in your office this semester:`,
        ...sns.map(sn => `- ${students.get(sn)?.name || sn} (${sn})`),
        '', 'They log their duties in AniSkolar; please confirm them in your office portal. To ask for more or fewer scholars, use Requests in the portal.',
      ].join('\n'),
    }));
  }
  return {
    emails,
    summary: assignment.size
      ? `${dryRun ? 'Would assign' : 'Assigned'} ${plural(assignment.size, 'scholar')} (${kept} to last term's office)${leftOver.length ? `; ${leftOver.length} left without an office (no free slots)` : ''}.`
      : `No free office slots: ${plural(leftOver.length, 'scholar')} still without an office. Add slots in Duty hours.`,
    details: { assignments: [...assignment].map(([studentNumber, office]) => ({ studentNumber, name: students.get(studentNumber)?.name ?? '', office })), leftOver: leftOver.length },
  };
}

const JOBS = {
  dutyReminders: { run: dutyReminders, due: c => c.weekday === 'Mon' && c.hour >= 8, period: c => isoWeek(c.date) },
  officeHeadReminders: { run: officeHeadReminders, due: c => c.weekday === 'Mon' && c.hour >= 8, period: c => isoWeek(c.date) },
  deadlineReminders: { run: deadlineReminders, due: c => c.hour >= 8, period: c => c.date },
  adsoDigest: { run: adsoDigest, due: c => c.hour >= 7, period: c => c.date },
  termRollover: { run: termRollover, due: c => c.hour >= 6, period: c => c.date },
};

async function record(job, period, result, error) {
  await AutomationSetting.updateOne({ _id: 'automation' }, {
    $set: { [`lastRuns.${job}`]: { period, at: new Date(), queued: result?.queued ?? 0, summary: result?.summary ?? '', ...(error ? { error } : {}) } },
  });
}

// Runs one job now: queues its emails (unless dryRun) and records the run.
// Returns { queued, summary, emails (count), details }.
async function runJob(job, { now = new Date(), dryRun = false } = {}) {
  const def = JOBS[job];
  if (!def) throw new Error(`Unknown job ${job}`);
  const settings = await AutomationSetting.current();
  const out = await def.run({ now, dryRun, settings });
  const recipients = out.emails.filter(e => e.to);
  const queued = dryRun ? 0 : await queueEmails(recipients);
  const result = { queued, summary: out.summary, emails: recipients.length, details: out.details ?? null, sample: recipients.slice(0, 5).map(e => ({ to: e.to, subject: e.subject })) };
  if (!dryRun) await record(job, def.period(manilaClock(now)), result);
  return result;
}

// Every 15 minutes: each job that's on and due, once per day / week.
let running = false;
async function runDueJobs(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const clock = manilaClock(now);
    for (const [job, def] of Object.entries(JOBS)) {
      if (!def.due(clock)) continue;
      const period = def.period(clock);
      // Claim the run: only one server, once per period.
      const claimed = await AutomationSetting.updateOne(
        { _id: 'automation', [job]: true, [`lastRuns.${job}.period`]: { $ne: period } },
        { $set: { [`lastRuns.${job}`]: { period, at: now, queued: 0, summary: 'Running…' } } }
      );
      if (!claimed.modifiedCount) continue;
      try {
        await runJob(job, { now });
      } catch (err) {
        console.error(`Automation ${job} failed:`, err);
        await record(job, period, null, err.message).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

module.exports = { runDueJobs, runJob, digestCounts, parseDeadline, isoWeek, JOB_NAMES: Object.keys(JOBS) };
