const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('legacy /login redirects to the dashboard login page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(
    source,
    /app\.get\('\/login',\s*\(req,\s*res\)\s*=>\s*\{\s*res\.redirect\(302,\s*'\/dashboard\/login'\);\s*\}\);/,
  );
});
