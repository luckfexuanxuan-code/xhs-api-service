/**
 * SQLite 数据库模块
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'xhs.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000');

// 原有表结构（保持不变）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    authorization  TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    enabled        INTEGER DEFAULT 1,
    initial_balance REAL DEFAULT 0,
    balance        REAL DEFAULT 0,
    blocked        INTEGER DEFAULT 0,
    blocked_at     TEXT,
    block_reason   TEXT,
    unblocked_at   TEXT,
    attack_records TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS custom_prices (
    authorization TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    price         REAL NOT NULL,
    PRIMARY KEY (authorization, endpoint)
  );

  CREATE TABLE IF NOT EXISTS ip_blacklist (
    ip           TEXT PRIMARY KEY,
    blocked      INTEGER DEFAULT 1,
    blocked_at   TEXT,
    reason       TEXT,
    unblocked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    authorization  TEXT NOT NULL,
    timestamp      TEXT NOT NULL,
    endpoint       TEXT NOT NULL,
    success        INTEGER NOT NULL,
    amount         REAL DEFAULT 0,
    client_ip      TEXT,
    user_agent     TEXT,
    request_params TEXT,
    error_message  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_call_logs_auth ON call_logs(authorization);
  CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_call_logs_auth_ts ON call_logs(authorization, timestamp);
  CREATE INDEX IF NOT EXISTS idx_call_logs_endpoint ON call_logs(endpoint);
  CREATE INDEX IF NOT EXISTS idx_call_logs_endpoint_ts ON call_logs(endpoint, timestamp);
  CREATE INDEX IF NOT EXISTS idx_call_logs_success_ts ON call_logs(success, timestamp);

  CREATE TABLE IF NOT EXISTS recharge_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    authorization   TEXT,
    user_name       TEXT,
    type            TEXT NOT NULL,
    amount          REAL NOT NULL,
    before_balance  REAL,
    after_balance   REAL,
    remark          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_recharge_auth ON recharge_log(authorization);
  CREATE INDEX IF NOT EXISTS idx_recharge_ts ON recharge_log(timestamp);

  CREATE TABLE IF NOT EXISTS usage_statistics (
    authorization  TEXT NOT NULL,
    date           TEXT NOT NULL,
    endpoint       TEXT NOT NULL,
    calls          INTEGER DEFAULT 0,
    success_calls  INTEGER DEFAULT 0,
    failed_calls   INTEGER DEFAULT 0,
    amount         REAL DEFAULT 0,
    cost           REAL DEFAULT 0,
    first_call     TEXT,
    last_call      TEXT,
    PRIMARY KEY (authorization, date, endpoint)
  );

  CREATE INDEX IF NOT EXISTS idx_usage_auth ON usage_statistics(authorization);
  CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_statistics(date);
  CREATE INDEX IF NOT EXISTS idx_usage_auth_endpoint ON usage_statistics(authorization, endpoint);
  CREATE INDEX IF NOT EXISTS idx_usage_date_endpoint ON usage_statistics(date, endpoint);
  CREATE INDEX IF NOT EXISTS idx_usage_endpoint_date ON usage_statistics(endpoint, date);

  -- 用户账户表（新增）
  CREATE TABLE IF NOT EXISTS user_accounts (
    user_id      TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    balance      REAL DEFAULT 0,
    created_at   TEXT NOT NULL,
    last_used_at TEXT DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_accounts_username ON user_accounts(username);

  -- 用户级价格表（新增）
  CREATE TABLE IF NOT EXISTS user_prices (
    user_id   TEXT NOT NULL,
    endpoint  TEXT NOT NULL,
    price     REAL NOT NULL,
    PRIMARY KEY (user_id, endpoint)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_endpoint_throttle (
    authorization    TEXT NOT NULL,
    endpoint         TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    PRIMARY KEY (authorization, endpoint)
  );

  CREATE TABLE IF NOT EXISTS throttle_rules (
    scope            TEXT NOT NULL,   -- 'global' | 'user' | 'auth'
    scope_id         TEXT NOT NULL,   -- ''(global) | user_id | authorization
    endpoint         TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, endpoint)
  );
`);

const usageColumns = db.prepare("PRAGMA table_info(usage_statistics)").all().map(col => col.name);
if (!usageColumns.includes('cost')) {
  db.exec('ALTER TABLE usage_statistics ADD COLUMN cost REAL DEFAULT 0');
}

// 迁移：为 call_logs 添加 cost（本次调用的上游成本，仅成功计费的调用>0）与
// upstream（实际服务的上游 key，如 v5/xingyin/matcha/tikhub；多上游候选链下每次可能不同）
const callLogColumns = db.pragma('table_info(call_logs)').map(c => c.name);
if (!callLogColumns.includes('cost')) {
  db.exec('ALTER TABLE call_logs ADD COLUMN cost REAL DEFAULT 0');
}
if (!callLogColumns.includes('upstream')) {
  db.exec("ALTER TABLE call_logs ADD COLUMN upstream TEXT DEFAULT ''");
}
// 迁移：upstream_attempts——多上游候选链发生切换时，记录被切换掉的候选及其失败原因
// （JSON 数组：[{upstream, api, error}]；未发生切换为空串）
if (!callLogColumns.includes('upstream_attempts')) {
  db.exec("ALTER TABLE call_logs ADD COLUMN upstream_attempts TEXT DEFAULT ''");
}
// 迁移：upstream_api——实际服务的上游具体接口（路径或 api_id=N），供上游接口级健康统计
if (!callLogColumns.includes('upstream_api')) {
  db.exec("ALTER TABLE call_logs ADD COLUMN upstream_api TEXT DEFAULT ''");
}

// 迁移：为 users 表添加 user_id 列
const usersColumns = db.pragma('table_info(users)').map(c => c.name);
if (!usersColumns.includes('user_id')) {
  db.exec('ALTER TABLE users ADD COLUMN user_id TEXT DEFAULT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id)');
}
// 迁移：为 users 表添加 is_default 列（1=创建用户时自动生成，0=后续新建）
if (!usersColumns.includes('is_default')) {
  db.exec('ALTER TABLE users ADD COLUMN is_default INTEGER DEFAULT 0');
}
// 迁移：为 users 表添加 quota 列（每个 Key 的「剩余配额」：NULL=不限额；数值=还能从余额里花掉的额度）
if (!usersColumns.includes('quota')) {
  db.exec('ALTER TABLE users ADD COLUMN quota REAL DEFAULT NULL');
}

// 迁移：为 recharge_log 添加 user_id 列
const rechargeColumns = db.pragma('table_info(recharge_log)').map(c => c.name);
if (!rechargeColumns.includes('user_id')) {
  db.exec('ALTER TABLE recharge_log ADD COLUMN user_id TEXT DEFAULT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recharge_user_id ON recharge_log(user_id)');
}

// 迁移：为 recharge_log 添加在线充值相关列（手动充值这些列留空 / channel=manual，老数据/查询不受影响）
if (!rechargeColumns.includes('channel')) {
  db.exec("ALTER TABLE recharge_log ADD COLUMN channel TEXT DEFAULT 'manual'");
}
if (!rechargeColumns.includes('out_trade_no')) {
  db.exec('ALTER TABLE recharge_log ADD COLUMN out_trade_no TEXT DEFAULT NULL');
}
if (!rechargeColumns.includes('pay_type')) {
  db.exec('ALTER TABLE recharge_log ADD COLUMN pay_type TEXT DEFAULT NULL');
}
if (!rechargeColumns.includes('trade_no')) {
  db.exec('ALTER TABLE recharge_log ADD COLUMN trade_no TEXT DEFAULT NULL');
}

// 在线充值订单表：以 out_trade_no 唯一约束做幂等，防止回调重发 / 重试导致重复入账。
db.exec(`CREATE TABLE IF NOT EXISTS recharge_orders (
  out_trade_no    TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  amount          REAL NOT NULL,
  pay_type        TEXT,
  trade_no        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  before_balance  REAL,
  after_balance   REAL,
  created_at      TEXT,
  paid_at         TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_recharge_orders_user ON recharge_orders(user_id)');

module.exports = db;
