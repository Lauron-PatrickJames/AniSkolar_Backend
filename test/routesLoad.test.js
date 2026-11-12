// Every route file loads (npm test): a syntax error in a route nobody's
// tests call (e.g. `await` outside an async handler) fails here instead
// of when the server starts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers');

const dir = path.join(__dirname, '..', 'routes');
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
  test(`routes/${file} loads`, () => {
    assert.doesNotThrow(() => require(path.join(dir, file)));
  });
}
