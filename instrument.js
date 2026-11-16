// Sentry error reporting. Loaded first in server.js (before Express) so it
// can hook in. Off unless SENTRY_DSN is set (Render), so local runs and
// tests send nothing. Errors only: no tracing, no request data.
const Sentry = require('@sentry/node');
const { scrubEvent } = require('./utils/sentryScrub');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  });
}

module.exports = Sentry;
