const { todayInManila } = require('./dutyHours');
const { sfagOpenAllYear } = require('./academicYear');

// Application periods are picked as dates (opensOn / closesOn, YYYY-MM-DD,
// Manila time), never typed. A scholarship takes applications only between
// them, whatever its status says. Mirrors applicationWindow() in the
// frontend's src/data/scholarships.ts.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isDate = v => typeof v === 'string' && DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const isTime = v => typeof v === 'string' && TIME.test(v);

const longDate = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));

// The dates in force: the office's, else the code default.
function periodOf(scholarship, setting) {
  return {
    opensOn: setting?.opensOn ?? scholarship?.opensOn ?? null,
    closesOn: setting?.closesOn ?? scholarship?.closesOn ?? null,
  };
}

// null when applications are accepted today; otherwise why not.
function windowError(scholarship, setting, now = new Date()) {
  // SFAG_OPEN_ALL_YEAR (demos and testing) lifts the SFAG's dates too.
  if (scholarship?.id === 's1' && sfagOpenAllYear()) return null;
  const { opensOn, closesOn } = periodOf(scholarship, setting);
  const today = todayInManila(now);
  if (opensOn && today < opensOn) return `Applications open on ${longDate(opensOn)}.`;
  if (closesOn && today > closesOn) return `Applications closed on ${longDate(closesOn)}.`;
  return null;
}

module.exports = { isDate, isTime, periodOf, windowError, longDate };
