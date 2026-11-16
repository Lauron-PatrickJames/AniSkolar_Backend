// Error reports (npm test): no student details reach Sentry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrubEvent } = require('../utils/sentryScrub');

test('request data, cookies, headers and user are removed', () => {
  const e = scrubEvent({
    user: { id: 'user_1', email: 'juan@dlsud.edu.ph' },
    request: {
      url: 'https://api/x?student=202399001', data: { password: 'x' }, cookies: { s: '1' }, query_string: 'a=1',
      headers: { authorization: 'Bearer abc', 'user-agent': 'Chrome' },
    },
  });
  assert.equal(e.user, undefined);
  assert.equal(e.request.data, undefined);
  assert.equal(e.request.cookies, undefined);
  assert.equal(e.request.query_string, undefined);
  assert.deepEqual(e.request.headers, { 'user-agent': 'Chrome' });
  assert.equal(e.request.url, 'https://api/x?student=[number]');
});

test('student numbers and emails in messages are masked', () => {
  const e = scrubEvent({
    message: 'No profile for 202399001',
    exception: { values: [{ value: 'Mail to juan@dlsud.edu.ph failed' }] },
    breadcrumbs: [{ message: 'GET /api/students/202399001', data: { url: '/api/students/202399001' } }],
  });
  assert.equal(e.message, 'No profile for [number]');
  assert.equal(e.exception.values[0].value, 'Mail to [email] failed');
  assert.equal(e.breadcrumbs[0].message, 'GET /api/students/[number]');
  assert.equal(e.breadcrumbs[0].data.url, '/api/students/[number]');
});
