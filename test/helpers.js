// Shared test setup. Require this before any route or model: it swaps in a
// fake Clerk (the signed-in user comes from the x-test-user header and
// `users`), so no Clerk account or database is needed.
const express = require('express');

const users = {};
require.cache[require.resolve('@clerk/express')] = {
  id: '@clerk/express', loaded: true,
  exports: {
    getAuth: req => ({ userId: req.headers['x-test-user'] || null }),
    clerkClient: { users: { getUser: async id => users[id] } },
    clerkMiddleware: () => (req, res, next) => next(),
  },
};

const clerkUser = (email, { verified = true, metadata = {} } = {}) => ({
  primaryEmailAddressId: 'e1',
  emailAddresses: [{ id: 'e1', emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }],
  firstName: 'Test', lastName: 'User', imageUrl: '',
  publicMetadata: metadata,
});
const adsoAdmin = () => clerkUser('adso@dlsud.edu.ph', { metadata: { role: 'admin', office: 'ADSO' } });

// A query stand-in: awaitable, and .select/.lean/.sort/... return itself.
const query = value => {
  const p = Promise.resolve(value);
  for (const m of ['select', 'lean', 'sort', 'limit', 'populate', 'distinct']) p[m] = () => p;
  return p;
};

function app(router, path) {
  const a = express();
  a.use(express.json());
  a.use(path, router);
  return a;
}

async function call(a, method, url, { user, body } = {}) {
  const server = a.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

module.exports = { users, clerkUser, adsoAdmin, query, app, call };
