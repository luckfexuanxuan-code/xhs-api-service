const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const modulePath = path.join(__dirname, '..', 'utils', 'accountUsage.js');

test('account usage query module exists', () => {
  assert.equal(fs.existsSync(modulePath), true, 'server/utils/accountUsage.js should exist');
});

test('call log listing is cursor-paginated and bounded by default', () => {
  const Database = require('better-sqlite3');
  const { listCallLogsPage } = require(modulePath);
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    authorization TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    success INTEGER NOT NULL,
    amount REAL,
    client_ip TEXT,
    request_params TEXT,
    error_message TEXT
  )`);
  const insert = database.prepare(`INSERT INTO call_logs
    (authorization, timestamp, endpoint, success, amount, client_ip, request_params, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = database.transaction(() => {
    for (let index = 1; index <= 105; index += 1) {
      insert.run('key-a', `2026-07-${String((index % 28) + 1).padStart(2, '0')} 12:00:00`, 'get_note_detail', 1, 0.04, '127.0.0.1', '{"id":1}', '');
    }
  });
  seed();

  const first = listCallLogsPage(database, 'key-a', {});
  assert.equal(first.records.length, 100);
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, 6);
  assert.deepEqual(first.records.slice(0, 2).map((row) => row.id), [105, 104]);
  assert.deepEqual(first.records[0].request_params, { id: 1 });

  const second = listCallLogsPage(database, 'key-a', { before_id: String(first.next_cursor) });
  assert.deepEqual(second.records.map((row) => row.id), [5, 4, 3, 2, 1]);
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  database.close();
});

test('call log listing applies date, endpoint, success, and maximum limit filters', () => {
  const Database = require('better-sqlite3');
  const { listCallLogsPage } = require(modulePath);
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    authorization TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    success INTEGER NOT NULL,
    amount REAL,
    client_ip TEXT,
    request_params TEXT,
    error_message TEXT
  )`);
  const insert = database.prepare(`INSERT INTO call_logs
    (authorization, timestamp, endpoint, success, amount) VALUES (?, ?, ?, ?, ?)`);
  insert.run('key-a', '2026-07-01 12:00:00', 'get_note_detail', 1, 0.04);
  insert.run('key-a', '2026-07-02 12:00:00', 'get_note_detail', 0, 0);
  insert.run('key-a', '2026-07-02 13:00:00', 'search_notes', 1, 0.08);
  insert.run('key-b', '2026-07-02 14:00:00', 'get_note_detail', 1, 0.04);

  const page = listCallLogsPage(database, 'key-a', {
    start_date: '2026-07-02',
    end_date: '2026-07-02',
    endpoint: 'get_note_detail',
    success: 'false',
    limit: '999999'
  });
  assert.equal(page.limit, 500);
  assert.deepEqual(page.records.map((row) => row.id), [2]);
  database.close();
});

test('usage summary reads daily aggregate rows instead of raw call logs', () => {
  const Database = require('better-sqlite3');
  const { getUsageSummary } = require(modulePath);
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE usage_statistics (
    authorization TEXT NOT NULL,
    date TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    calls INTEGER NOT NULL,
    success_calls INTEGER NOT NULL,
    failed_calls INTEGER NOT NULL,
    amount REAL NOT NULL,
    cost REAL NOT NULL,
    first_call TEXT,
    last_call TEXT,
    PRIMARY KEY (authorization, date, endpoint)
  )`);
  const insert = database.prepare(`INSERT INTO usage_statistics
    (authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost, first_call, last_call)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('key-a', '2026-07-01', 'ALL', 10, 9, 1, 0.4, 0.2, '2026-07-01 01:00:00', '2026-07-01 22:00:00');
  insert.run('key-a', '2026-07-01', 'get_note_detail', 6, 6, 0, 0.24, 0.12, '2026-07-01 01:00:00', '2026-07-01 20:00:00');
  insert.run('key-a', '2026-07-01', 'search_notes', 4, 3, 1, 0.16, 0.08, '2026-07-01 02:00:00', '2026-07-01 22:00:00');
  insert.run('key-a', '2026-07-02', 'ALL', 5, 4, 1, 0.2, 0.1, '2026-07-02 03:00:00', '2026-07-02 21:00:00');
  insert.run('key-a', '2026-07-02', 'get_note_detail', 5, 4, 1, 0.2, 0.1, '2026-07-02 03:00:00', '2026-07-02 21:00:00');
  insert.run('key-b', '2026-07-02', 'ALL', 999, 999, 0, 99, 50, '2026-07-02 01:00:00', '2026-07-02 23:00:00');

  const usage = getUsageSummary(database, 'key-a', { start_date: '2026-07-01', end_date: '2026-07-02' });
  assert.deepEqual(usage.summary, {
    calls: 15,
    success_calls: 13,
    failed_calls: 2,
    amount: 0.6,
    cost: 0.3,
    first_call: '2026-07-01 01:00:00',
    last_call: '2026-07-02 21:00:00'
  });
  assert.deepEqual(usage.daily_stats.map((row) => [row.date, row.calls, row.cost]), [
    ['2026-07-01', 10, 0.2],
    ['2026-07-02', 5, 0.1]
  ]);
  assert.deepEqual(usage.endpoint_stats.map((row) => [row.endpoint, row.calls, row.success_calls, row.cost]), [
    ['get_note_detail', 11, 10, 0.22],
    ['search_notes', 4, 3, 0.08]
  ]);
  database.close();
});

test('user usage summary aggregates all API keys owned by one user without double-counting endpoint rows', () => {
  const Database = require('better-sqlite3');
  const { listUserUsageSummary } = require(modulePath);
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE user_accounts (user_id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE users (authorization TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE usage_statistics (
      authorization TEXT NOT NULL, date TEXT NOT NULL, endpoint TEXT NOT NULL,
      calls INTEGER NOT NULL, success_calls INTEGER NOT NULL, failed_calls INTEGER NOT NULL,
      amount REAL NOT NULL, cost REAL NOT NULL, first_call TEXT, last_call TEXT,
      PRIMARY KEY (authorization, date, endpoint)
    );
  `);
  database.prepare('INSERT INTO user_accounts(user_id, username) VALUES (?, ?)').run('user-a', 'Alice');
  database.prepare('INSERT INTO user_accounts(user_id, username) VALUES (?, ?)').run('user-b', 'Bob');
  const addKey = database.prepare('INSERT INTO users(authorization, user_id) VALUES (?, ?)');
  addKey.run('key-a1', 'user-a');
  addKey.run('key-a2', 'user-a');
  addKey.run('key-b1', 'user-b');
  addKey.run('legacy-key', null);
  const addUsage = database.prepare(`INSERT INTO usage_statistics
    (authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost, first_call, last_call)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  addUsage.run('key-a1', '2026-07-01', 'ALL', 10, 9, 1, 0.4, 0.2, '2026-07-01 01:00:00', '2026-07-01 22:00:00');
  addUsage.run('key-a1', '2026-07-01', 'get_note_detail', 10, 9, 1, 0.4, 0.2, '2026-07-01 01:00:00', '2026-07-01 22:00:00');
  addUsage.run('key-a2', '2026-07-02', 'ALL', 5, 4, 1, 0.2, 0.1, '2026-07-02 03:00:00', '2026-07-02 21:00:00');
  addUsage.run('key-a2', '2026-07-02', 'search_note', 5, 4, 1, 0.2, 0.1, '2026-07-02 03:00:00', '2026-07-02 21:00:00');
  addUsage.run('legacy-key', '2026-07-03', 'ALL', 99, 99, 0, 9.9, 1, '2026-07-03 01:00:00', '2026-07-03 02:00:00');

  const result = listUserUsageSummary(database);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    user_id: 'user-a', username: 'Alice', key_count: 2, active_key_count: 2,
    total_calls: 15, success_calls: 13, failed_calls: 2,
    total_amount: 0.6, total_cost: 0.3, total_profit: 0.3,
    endpoints_count: 2,
    first_call: '2026-07-01 01:00:00', last_call: '2026-07-02 21:00:00'
  });
  assert.deepEqual(result[1], {
    user_id: 'user-b', username: 'Bob', key_count: 1, active_key_count: 0,
    total_calls: 0, success_calls: 0, failed_calls: 0,
    total_amount: 0, total_cost: 0, total_profit: 0,
    endpoints_count: 0, first_call: '', last_call: ''
  });
  database.close();
});

test('daily dashboard user statistics aggregate every API key by real user id', () => {
  const Database = require('better-sqlite3');
  const { listDailyUserUsageSummary } = require(modulePath);
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE user_accounts (user_id TEXT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE users (authorization TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE usage_statistics (
      authorization TEXT NOT NULL, date TEXT NOT NULL, endpoint TEXT NOT NULL,
      calls INTEGER NOT NULL, success_calls INTEGER NOT NULL, failed_calls INTEGER NOT NULL,
      amount REAL NOT NULL, cost REAL NOT NULL, first_call TEXT, last_call TEXT,
      PRIMARY KEY (authorization, date, endpoint)
    );
  `);
  database.prepare('INSERT INTO user_accounts(user_id, username) VALUES (?, ?)').run('user-a', 'Alice');
  database.prepare('INSERT INTO user_accounts(user_id, username) VALUES (?, ?)').run('user-b', 'Bob');
  const addKey = database.prepare('INSERT INTO users(authorization, user_id) VALUES (?, ?)');
  addKey.run('key-a1', 'user-a');
  addKey.run('key-a2', 'user-a');
  addKey.run('key-b1', 'user-b');
  addKey.run('legacy-key', null);
  const addUsage = database.prepare(`INSERT INTO usage_statistics
    (authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost, first_call, last_call)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  addUsage.run('key-a1', '2026-07-18', 'ALL', 8, 7, 1, 0.32, 0.16, '', '');
  addUsage.run('key-a2', '2026-07-18', 'ALL', 5, 4, 1, 0.20, 0.10, '', '');
  addUsage.run('key-b1', '2026-07-18', 'ALL', 3, 3, 0, 0.12, 0.06, '', '');
  addUsage.run('legacy-key', '2026-07-18', 'ALL', 99, 99, 0, 9.9, 1, '', '');
  addUsage.run('key-a1', '2026-07-17', 'ALL', 50, 50, 0, 2, 1, '', '');

  assert.deepEqual(listDailyUserUsageSummary(database, '2026-07-18', 'ALL'), [
    { user_id: 'user-a', user_name: 'Alice', key_count: 2, total_calls: 13, success_calls: 11, failed_calls: 2, total_amount: 0.52, total_cost: 0.52 },
    { user_id: 'user-b', user_name: 'Bob', key_count: 1, total_calls: 3, success_calls: 3, failed_calls: 0, total_amount: 0.12, total_cost: 0.12 }
  ]);
  database.close();
});

test('admin API exposes user-level usage separately from key-level usage', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminApi.js'), 'utf8');
  assert.match(routeSource, /router\.get\('\/get_user_usage_statistics'/);
  assert.match(routeSource, /listUserUsageSummary\(db\)/);
  assert.match(routeSource, /router\.get\('\/get_daily_user_statistics'/);
  assert.match(routeSource, /listDailyUserUsageSummary\(db, targetDate, ep\)/);
});

test('statistics dashboard distinguishes user aggregates from API key statistics', () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'services', 'api.jsx'), 'utf8');
  const pageSource = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'Statistics.jsx'), 'utf8');
  const dashboardSource = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'Dashboard.jsx'), 'utf8');
  assert.match(apiSource, /getUserUsageStatistics/);
  assert.match(apiSource, /\/admin\/get_user_usage_statistics/);
  assert.match(pageSource, /用户统计/);
  assert.match(pageSource, /密钥统计/);
  assert.match(pageSource, /user\.key_count/);
  assert.match(pageSource, /keyStats\.map/);
  assert.match(dashboardSource, /row\.key_count/);
  assert.match(dashboardSource, /真实用户/);
});

test('user API exposes aggregate usage and keeps legacy call logs compatible beside v2 pagination', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'userApi.js'), 'utf8');
  assert.match(routeSource, /router\.get\('\/get_usage_statistics'/);
  assert.match(routeSource, /getUsageSummary\(db, auth\.authorization, req\.query\)/);
  assert.match(routeSource, /router\.get\('\/v2\/call_logs'/);
  const v2Route = routeSource.split("router.get('/v2/call_logs'", 2)[1].split("router.get('/get_call_logs'", 1)[0];
  assert.match(v2Route, /listCallLogsPage\(db, auth\.authorization, req\.query\)/);
  assert.match(v2Route, /has_more/);
  assert.match(v2Route, /next_cursor/);
  const legacyRoute = routeSource.split("router.get('/get_call_logs'", 2)[1].split("router.get('/get_recharge_log'", 1)[0];
  assert.match(legacyRoute, /ORDER BY timestamp DESC/);
  assert.doesNotMatch(legacyRoute, /listCallLogsPage/);
});
