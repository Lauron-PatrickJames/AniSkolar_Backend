// Rate limiting (npm test): signed-out visitors are limited by IP, signed-in
// users by their account, so students sharing the campus IP don't use up
// each other's limit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiLimiter } = require('../middleware/rateLimit');

async function withApp(fn) {
  const app = express();
  // Small limits for the test; the user comes from a header instead of Clerk.
  app.use('/api', createApiLimiter({ signedIn: 5, signedOut: 3, userOf: req => req.get('x-user') || null }));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const hit = (base, user) => fetch(`${base}/api/ping`, { headers: user ? { 'x-user': user } : {} }).then(r => r.status);

test('a signed-out visitor is limited by IP', () => withApp(async base => {
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push(await hit(base));
  assert.deepEqual(statuses, [200, 200, 200, 429]);
}));

test('signed-in users each get their own limit, not the shared IP one', () => withApp(async base => {
  for (let i = 0; i < 3; i++) assert.equal(await hit(base), 200);
  assert.equal(await hit(base), 429);                // the IP is used up
  for (let i = 0; i < 5; i++) assert.equal(await hit(base, 'user_a'), 200);
  assert.equal(await hit(base, 'user_a'), 429);      // user A's own limit
  assert.equal(await hit(base, 'user_b'), 200);      // user B is unaffected
}));
