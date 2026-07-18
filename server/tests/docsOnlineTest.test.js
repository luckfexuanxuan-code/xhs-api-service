const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINTS } = require('../apiRegistry');

const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');

function onlineTestSections(source) {
  const starts = [...source.matchAll(/<div class="api-section[^\"]*page[^\"]*" id="([^"]+)">/g)];
  return starts.map((match, index) => {
    const end = starts[index + 1] ? starts[index + 1].index : source.length;
    return { id: match[1], html: source.slice(match.index, end) };
  }).filter((section) => section.html.includes('在线测试'));
}

test('every registry-backed online test exposes and sends every customer parameter', () => {
  const endpointByType = new Map(ENDPOINTS.map((endpoint) => [endpoint.type, endpoint]));
  const issues = [];

  for (const section of onlineTestSections(html)) {
    const type = section.html.match(/<span class="path">\/api\/([^<]+)<\/span>/)?.[1];
    const endpoint = endpointByType.get(type);
    if (!endpoint) continue;

    const fields = [...section.html.matchAll(/<div class="test-row">([\s\S]*?)<\/div>/g)]
      .map((match) => ({
        name: match[1].match(/<label>([^<]+)<\/label>/)?.[1].trim(),
        id: match[1].match(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/)?.[1],
      }));
    const labels = fields.map((field) => field.name);
    const onclick = section.html.match(/<button[^>]*onclick="([^"]+)"[^>]*>发送请求<\/button>/)?.[1] || '';
    const declared = (endpoint.params || []).map((parameter) => parameter.name);
    const missingFields = declared.filter((name) => !labels.includes(name));
    const missingBindings = onclick.startsWith('testApi(')
      ? fields.filter((field) => declared.includes(field.name))
        .filter((field) => !onclick.includes(`${field.name}: gv('${field.id}')`))
        .map((field) => field.name)
      : [];

    if (missingFields.length) issues.push(`${type}: 缺少输入框 ${missingFields.join(', ')}`);
    if (missingBindings.length) issues.push(`${type}: 未发送 ${missingBindings.join(', ')}`);
  }

  assert.deepEqual(issues, [], `在线测试参数不完整：\n${issues.join('\n')}`);
});

test('online test methods match the endpoint registry', () => {
  const endpointByType = new Map(ENDPOINTS.map((endpoint) => [endpoint.type, endpoint]));
  const issues = [];

  for (const section of onlineTestSections(html)) {
    const type = section.html.match(/<span class="path">\/api\/([^<]+)<\/span>/)?.[1];
    const endpoint = endpointByType.get(type);
    if (!endpoint) continue;
    const documented = section.html.match(/<span class="method[^\"]*">([^<]+)<\/span>/)?.[1];
    if (documented !== endpoint.method) issues.push(`${type}: ${documented} != ${endpoint.method}`);
  }

  assert.deepEqual(issues, []);
});

test('obsolete Web comment token pagination notice stays removed', () => {
  assert.equal(html.includes('xsec_token 会随评论分页刷新'), false);
});

test('must-read registration link uses the public HTTPS crawler platform', () => {
  assert.equal(html.includes('href="https://galaxysapi.com/"'), true);
  assert.equal(html.includes('http://8.140.241.29:1231/'), false);
  assert.equal(html.includes('http://galaxysapi.com/'), false);
});

test('spotlight keyword planner stays out of the client API documentation', () => {
  assert.equal(html.includes('/api/juguang_keyword_plan_web'), false);
  assert.equal(html.includes('sec-juguang-plan'), false);
  assert.equal(html.includes('聚光关键词规划'), false);
});

test('client examples use the public HTTPS API origin', () => {
  assert.equal(html.includes('http://8.140.241.29:9090'), false);
  assert.equal(html.includes('https://api.galaxysapi.com/api/'), true);
});
