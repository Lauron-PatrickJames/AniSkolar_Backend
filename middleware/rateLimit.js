const { getAuth } = require('@clerk/express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Rate limiting for the API: a signed-in user is counted by their account
// and a signed-out visitor by IP, since many students share the campus
// Wi-Fi's IP. The limits are far above normal use (pages poll at most
// every few seconds); they stop scripts hammering the API.
// `userOf` is replaceable for tests (default: the Clerk session).
function createApiLimiter({ signedIn = 600, signedOut = 300, windowMs = 60 * 1000, userOf } = {}) {
  const user = userOf || (req => getAuth(req)?.userId || null);
  return rateLimit({
    windowMs,
    limit: req => (user(req) ? signedIn : signedOut),
    keyGenerator: req => {
      const userId = user(req);
      return userId ? `user:${userId}` : `ip:${ipKeyGenerator(req.ip || '')}`;
    },
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute and try again.' },
  });
}

module.exports = { createApiLimiter };
