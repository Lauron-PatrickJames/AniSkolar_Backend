// Duty hours arithmetic, as on the office's duty sheet. Mirrors
// src/utils/dutyHours.ts in the frontend — keep the two in sync.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// Hours between time in and time out on the same day, to 2 decimals.
function entryHours({ timeIn, timeOut }) {
  return Math.round(((minutes(timeOut) - minutes(timeIn)) / 60) * 100) / 100;
}

const round2 = n => Math.round(n * 100) / 100;

// When duty may be rendered (AdSO, Oct 2026): Monday–Thursday 8:00 AM–6:00
// PM, Friday 8:00 AM–5:00 PM, never across the 12:00–1:00 PM lunch break,
// and at least 1.5 hours at a time. Returns the reason an entry breaks
// these, or null. Mirrors dutyRuleError in the frontend.
const DUTY_START = 8 * 60;
const LUNCH_START = 12 * 60;
const LUNCH_END = 13 * 60;
const MIN_DUTY_MINUTES = 90;
// Times go in 30-minute steps (on the hour or half hour).
const STEP_MINUTES = 30;
function dutyRuleError({ date, timeIn, timeOut }) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return 'Duty is only on weekdays (Monday to Friday).';
  const start = minutes(timeIn);
  const end = minutes(timeOut);
  if (start % STEP_MINUTES || end % STEP_MINUTES) return 'Use times on the hour or half hour, like 8:00 or 8:30.';
  if (start < DUTY_START) return 'Duty starts at 8:00 AM at the earliest.';
  if (day === 5 && end > 17 * 60) return 'Duty ends by 5:00 PM on Fridays.';
  if (end > 18 * 60) return 'Duty ends by 6:00 PM, Monday to Thursday.';
  if (start < LUNCH_END && end > LUNCH_START) return 'Duty can\'t include the 12:00–1:00 PM lunch break. Log the morning and the afternoon as separate duties.';
  if (end - start < MIN_DUTY_MINUTES) return 'A duty must be at least 1.5 hours.';
  return null;
}

// Days between two YYYY-MM-DD dates (b - a).
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Totals for a log. `today` (YYYY-MM-DD) decides how many weeks are left
// before the deadline for "weekly hours needed".
// confirmationRequired: the scholar's office has a head in AniSkolar, so
// only duties the head confirmed count; the rest are waiting (or flagged).
function summarize(log, today, { confirmationRequired = false } = {}) {
  const entries = log.entries || [];
  const counts = e => !confirmationRequired || e.status === 'confirmed';
  const regular = entries.filter(counts).reduce((sum, e) => sum + entryHours(e), 0);
  const waitingHours = confirmationRequired ? entries.filter(e => !e.status).reduce((sum, e) => sum + entryHours(e), 0) : 0;
  const flagged = entries.filter(e => e.status === 'flagged').length;
  const special = (log.specialEvents || []).reduce((sum, e) => sum + (e.hours || 0), 0);
  const completed = round2(regular + special);
  const required = log.requiredHours ?? null;
  const remaining = required === null ? null : round2(required - completed);
  let weeklyNeeded = null;
  if (remaining !== null && log.deadline) {
    if (remaining <= 0) weeklyNeeded = 0;
    else {
      const daysLeft = daysBetween(today, log.deadline) + 1;
      weeklyNeeded = daysLeft > 0 ? round2(remaining / Math.max(1, Math.ceil(daysLeft / 7))) : null;
    }
  }
  const dates = (log.entries || []).map(e => e.date).sort();
  return {
    regularHours: round2(regular),
    specialHours: round2(special),
    completed,
    required,
    remaining,
    weeklyNeeded,
    lastDutyDate: dates[dates.length - 1] ?? null,
    confirmationRequired,
    waitingHours: round2(waitingHours),
    waitingCount: confirmationRequired ? entries.filter(e => !e.status).length : 0,
    flaggedCount: flagged,
  };
}

// Validates a scholar's whole log. Returns { log } or { error }. The
// office, the deadline (set by the AdSO per term) and event credit aren't
// part of it. `keep`: "date|timeIn|timeOut" of duties already saved, which
// were checked when they were added and aren't re-checked against rules
// introduced since (e.g. the 30-minute steps).
function parseLog(body, { keep = new Set() } = {}) {
  const out = {};

  if (body.requiredHours === '' || body.requiredHours === null || body.requiredHours === undefined) out.requiredHours = undefined;
  else {
    const n = Number(body.requiredHours);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return { error: 'Required hours must be between 0 and 1000.' };
    out.requiredHours = n;
  }

  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length > 500) return { error: 'A term can have at most 500 duty entries.' };
  out.entries = [];
  for (const e of entries) {
    if (!e || !isValidDate(e.date)) return { error: 'Every duty needs a valid date.' };
    if (!TIME_RE.test(e.timeIn || '') || !TIME_RE.test(e.timeOut || '')) return { error: `Enter the time in and time out for ${e.date}.` };
    if (minutes(e.timeOut) <= minutes(e.timeIn)) return { error: `Time out must be after time in (${e.date}).` };
    const ruleError = keep.has(`${e.date}|${e.timeIn}|${e.timeOut}`) ? null : dutyRuleError(e);
    if (ruleError) return { error: `${ruleError} (${e.date}, ${e.timeIn}–${e.timeOut})` };
    out.entries.push({ date: e.date, timeIn: e.timeIn, timeOut: e.timeOut });
  }

  // Event credit comes from the AdSO's credited events (claims approved by
  // the AdSO), so special events sent by the scholar are ignored.
  return { log: out };
}

// The term a date falls in: August–December is the 1st semester of that
// academic year; January–July counts toward the 2nd semester of the year
// before (midyear isn't tracked).
function currentTerm(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: 'numeric' }).formatToParts(date);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  return month >= 8 ? { academicYear: year, term: '1st Semester' } : { academicYear: year - 1, term: '2nd Semester' };
}

function todayInManila(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date);
}

module.exports = { entryHours, dutyRuleError, summarize, parseLog, currentTerm, todayInManila, isValidDate };
