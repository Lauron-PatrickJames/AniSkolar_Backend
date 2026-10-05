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

// Days between two YYYY-MM-DD dates (b - a).
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Totals for a log. `today` (YYYY-MM-DD) decides how many weeks are left
// before the deadline for "weekly hours needed".
function summarize(log, today) {
  const regular = (log.entries || []).reduce((sum, e) => sum + entryHours(e), 0);
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
  };
}

// Validates a scholar's whole log. Returns { log } or { error }.
function parseLog(body) {
  const out = {};
  out.officeAssigned = typeof body.officeAssigned === 'string' ? body.officeAssigned.trim().slice(0, 200) : '';

  if (body.deadline === '' || body.deadline === null || body.deadline === undefined) out.deadline = undefined;
  else if (!isValidDate(body.deadline)) return { error: 'Enter a valid deadline.' };
  else out.deadline = body.deadline;

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
    out.entries.push({ date: e.date, timeIn: e.timeIn, timeOut: e.timeOut });
  }

  const events = Array.isArray(body.specialEvents) ? body.specialEvents : [];
  if (events.length > 100) return { error: 'A term can have at most 100 special events.' };
  out.specialEvents = [];
  for (const e of events) {
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    const hours = Number(e?.hours);
    if (!name) return { error: 'Every special event needs a name.' };
    if (!Number.isFinite(hours) || hours <= 0 || hours > 100) return { error: `Enter the equivalent hours for ${name}.` };
    out.specialEvents.push({ name: name.slice(0, 200), hours: round2(hours) });
  }
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

module.exports = { entryHours, summarize, parseLog, currentTerm, todayInManila, isValidDate };
