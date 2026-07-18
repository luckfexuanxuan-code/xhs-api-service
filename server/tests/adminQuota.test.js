const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('admin quota API reserves null unlimited quota for trusted admin calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminApi.js'), 'utf8');
  const route = source.split("router.post('/set_auth_quota'", 2)[1].split("router.get('/check_auth'", 1)[0];

  assert.match(route, /const unlimitedRequested = quota === null \|\| quota === 'unlimited'/);
  assert.match(route, /if \(unlimitedRequested && !isAdmin\)/);
  assert.match(route, /setAuthQuota\(authorization, unlimitedRequested \? null : quota\)/);
});
