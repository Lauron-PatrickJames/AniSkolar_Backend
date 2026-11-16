// Removes student details from error reports before they're sent to Sentry:
// no request bodies, cookies, headers, query strings or user info, and
// student numbers and email addresses in messages are masked.

const STUDENT_NUMBER = /\b\d{9,10}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const mask = s => (typeof s === 'string' ? s.replace(EMAIL, '[email]').replace(STUDENT_NUMBER, '[number]') : s);

function scrubEvent(event) {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    const ua = event.request.headers?.['user-agent'];
    event.request.headers = ua ? { 'user-agent': ua } : {};
    if (event.request.url) event.request.url = mask(event.request.url);
  }
  if (event.message) event.message = mask(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = mask(ex.value);
  for (const b of event.breadcrumbs ?? []) {
    b.message = mask(b.message);
    if (b.data) b.data = JSON.parse(mask(JSON.stringify(b.data)));
  }
  return event;
}

module.exports = { scrubEvent, mask };
