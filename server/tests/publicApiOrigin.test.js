const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const apiTestSource = fs.readFileSync(path.join(__dirname, '../../client/src/pages/ApiTest.jsx'), 'utf8');
const docsHtml = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const curlGuide = fs.readFileSync(path.join(__dirname, '../../curl命令手册.md'), 'utf8');
const publicOrigin = 'https://api.galaxysapi.com';

test('admin API test uses the public HTTPS origin for downstream requests and generated code', () => {
  assert.match(apiTestSource, /const PUBLIC_API_ORIGIN = 'https:\/\/api\.galaxysapi\.com'/);
  assert.doesNotMatch(apiTestSource, /const baseUrl = window\.location\.origin/);
  assert.match(apiTestSource, /const baseUrl = PUBLIC_API_ORIGIN/);
  assert.match(apiTestSource, /const requestUrl = PUBLIC_API_ORIGIN \+ relativeUrl/);
  assert.match(apiTestSource, /\{PUBLIC_API_ORIGIN\}\{selectedDownstreamConfig\.url\}/);
});

test('client documentation examples and online API requests use the public HTTPS origin', () => {
  assert.match(docsHtml, /var BASE_URL = 'https:\/\/api\.galaxysapi\.com'/);
  assert.match(docsHtml, /fetch\(BASE_URL \+ '\/api\/get_balance'/);
  assert.match(docsHtml, /fetch\(BASE_URL \+ '\/api\/endpoint_status'/);
  assert.match(docsHtml, /var url = BASE_URL \+ endpoint/);
  assert.match(docsHtml, /var url = BASE_URL \+ '\/api\/search_note'/);

  const absoluteApiUrls = [...docsHtml.matchAll(/https?:\/\/[^\s"'<>]+\/api\/[A-Za-z0-9_/-]+/g)].map((match) => match[0]);
  assert.ok(absoluteApiUrls.length > 0);
  assert.deepEqual([...new Set(absoluteApiUrls.map((url) => new URL(url).origin))], [publicOrigin]);
  assert.equal(docsHtml.includes('http://8.140.241.29:9090'), false);
  assert.match(curlGuide, /BASE="https:\/\/api\.galaxysapi\.com"/);
  assert.doesNotMatch(curlGuide, /BASE="http:\/\/8\.140\.241\.29:9090"/);
});
