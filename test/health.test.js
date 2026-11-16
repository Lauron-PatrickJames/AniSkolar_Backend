// The uptime monitor's health check (npm test): 200 only when the database
// answers, 503 when it's disconnected or doesn't answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const healthRouter = require('../routes/health');

async function check(connection) {
  const app = express();
  app.use('/api/health', healthRouter(connection));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}
const db = ping => ({ admin: () => ({ ping }) });

test('the database answers: 200', async () => {
  const r = await check({ readyState: 1, db: db(async () => ({ ok: 1 })) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, database: 'up' });
});

test('not connected: 503', async () => {
  const r = await check({ readyState: 0, db: null });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ok: false, database: 'down' });
});

test('the ping fails (e.g. a rotated password): 503', async () => {
  const r = await check({ readyState: 1, db: db(async () => { throw new Error('auth failed'); }) });
  assert.equal(r.status, 503);
});
