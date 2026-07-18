#!/usr/bin/env node
/**
 * 数据迁移脚本：JSON 文件 + call_logs 目录 → SQLite
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CALL_LOGS_DIR = path.resolve(__dirname, '..', 'call_logs');
const DB_PATH = path.join(DATA_DIR, 'xhs.db');

// 如果数据库已有数据，询问是否跳过
function readJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return {}; }
}

function getUserDirName(authorization) {
  return crypto.createHash('sha256').update(authorization).digest('hex').substring(0, 16);
}

console.log('========================================');
console.log('  数据迁移：JSON → SQLite');
console.log('========================================\n');

// 打开数据库并建表
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// 建表（和 db.js 保持一致）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    authorization TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    created_at TEXT NOT NULL, enabled INTEGER DEFAULT 1, initial_balance REAL DEFAULT 0,
    balance REAL DEFAULT 0, blocked INTEGER DEFAULT 0, blocked_at TEXT, block_reason TEXT,
    unblocked_at TEXT, attack_records TEXT DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS custom_prices (
    authorization TEXT NOT NULL, endpoint TEXT NOT NULL, price REAL NOT NULL,
    PRIMARY KEY (authorization, endpoint)
  );
  CREATE TABLE IF NOT EXISTS ip_blacklist (
    ip TEXT PRIMARY KEY, blocked INTEGER DEFAULT 1, blocked_at TEXT, reason TEXT, unblocked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, authorization TEXT NOT NULL, timestamp TEXT NOT NULL,
    endpoint TEXT NOT NULL, success INTEGER NOT NULL, amount REAL DEFAULT 0,
    client_ip TEXT, user_agent TEXT, request_params TEXT, error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_call_logs_auth ON call_logs(authorization);
  CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_call_logs_auth_ts ON call_logs(authorization, timestamp);
  CREATE INDEX IF NOT EXISTS idx_call_logs_endpoint ON call_logs(endpoint);
  CREATE TABLE IF NOT EXISTS recharge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, authorization TEXT NOT NULL,
    user_name TEXT, type TEXT NOT NULL, amount REAL NOT NULL, before_balance REAL, after_balance REAL, remark TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recharge_auth ON recharge_log(authorization);
  CREATE INDEX IF NOT EXISTS idx_recharge_ts ON recharge_log(timestamp);
  CREATE TABLE IF NOT EXISTS usage_statistics (
    authorization TEXT NOT NULL, date TEXT NOT NULL, endpoint TEXT NOT NULL,
    calls INTEGER DEFAULT 0, success_calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0,
    amount REAL DEFAULT 0, first_call TEXT, last_call TEXT,
    PRIMARY KEY (authorization, date, endpoint)
  );
`);

// 检查是否已有数据
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount > 0) {
  console.log(`数据库已有 ${userCount} 个用户，跳过迁移。`);
  console.log('如需重新迁移，请先删除 data/xhs.db\n');
  process.exit(0);
}

// 1. 迁移用户 (auth.json + balance.json)
console.log('--- 1. 迁移用户 ---');
const auth = readJson('auth.json');
const balance = readJson('balance.json');

const insertUser = db.prepare(`INSERT OR REPLACE INTO users
  (authorization, name, description, created_at, enabled, initial_balance, balance, blocked, blocked_at, block_reason, unblocked_at, attack_records)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const insertUsers = db.transaction(() => {
  for (const [authKey, info] of Object.entries(auth)) {
    insertUser.run(
      authKey,
      info.name || '',
      info.description || '',
      info.created_at || '',
      (info.enabled === false) ? 0 : 1,
      info.initial_balance || 0,
      balance[authKey] || 0,
      info.blocked ? 1 : 0,
      info.blocked_at || null,
      info.block_reason || null,
      info.unblocked_at || null,
      JSON.stringify(info.attack_records || [])
    );
  }
});
insertUsers();
console.log(`  用户: ${Object.keys(auth).length} 条`);

// 2. 迁移自定义价格
console.log('--- 2. 迁移自定义价格 ---');
const prices = readJson('prices.json');
const insertPrice = db.prepare('INSERT OR REPLACE INTO custom_prices (authorization, endpoint, price) VALUES (?, ?, ?)');
let priceCount = 0;

const insertPrices = db.transaction(() => {
  for (const [authKey, endpoints] of Object.entries(prices)) {
    for (const [ep, price] of Object.entries(endpoints)) {
      insertPrice.run(authKey, ep, price);
      priceCount++;
    }
  }
});
insertPrices();
console.log(`  价格: ${priceCount} 条`);

// 3. 迁移 IP 黑名单
console.log('--- 3. 迁移 IP 黑名单 ---');
const ipBlacklist = readJson('ip_blacklist.json');
const insertIp = db.prepare('INSERT OR REPLACE INTO ip_blacklist (ip, blocked, blocked_at, reason, unblocked_at) VALUES (?, ?, ?, ?, ?)');

const insertIps = db.transaction(() => {
  for (const [ip, info] of Object.entries(ipBlacklist)) {
    if (typeof info === 'object') {
      insertIp.run(ip, info.blocked ? 1 : 0, info.blocked_at || null, info.reason || null, info.unblocked_at || null);
    }
  }
});
insertIps();
console.log(`  IP: ${Object.keys(ipBlacklist).length} 条`);

// 4. 迁移使用统计
console.log('--- 4. 迁移使用统计 ---');
const usage = readJson('usage.json');
const insertUsage = db.prepare(`INSERT OR REPLACE INTO usage_statistics
  (authorization, date, endpoint, calls, success_calls, failed_calls, amount, first_call, last_call)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let usageCount = 0;
const insertAllUsage = db.transaction(() => {
  for (const [authKey, data] of Object.entries(usage)) {
    // Total ALL
    insertUsage.run(authKey, 'TOTAL', 'ALL',
      data.total_calls || 0, 0, 0, data.total_amount || 0,
      data.first_call || null, data.last_call || null);
    usageCount++;

    // Total per endpoint
    for (const [ep, epData] of Object.entries(data.endpoints || {})) {
      insertUsage.run(authKey, 'TOTAL', ep,
        epData.calls || 0, epData.success_calls || 0, epData.failed_calls || 0, epData.amount || 0,
        null, null);
      usageCount++;
    }

    // Daily stats
    for (const [date, daily] of Object.entries(data.daily_stats || {})) {
      insertUsage.run(authKey, date, 'ALL',
        daily.total_calls || 0, 0, 0, daily.total_amount || 0, null, null);
      usageCount++;

      for (const [ep, epData] of Object.entries(daily.endpoints || {})) {
        insertUsage.run(authKey, date, ep,
          epData.calls || 0, epData.success_calls || 0, epData.failed_calls || 0, epData.amount || 0,
          null, null);
        usageCount++;
      }
    }
  }
});
insertAllUsage();
console.log(`  统计: ${usageCount} 条`);

// 5. 迁移充值记录
console.log('--- 5. 迁移充值记录 ---');
const rechargePath = path.join(DATA_DIR, 'recharge_log.json');
let rechargeCount = 0;
if (fs.existsSync(rechargePath)) {
  try {
    const rechargeData = JSON.parse(fs.readFileSync(rechargePath, 'utf-8'));
    const insertRecharge = db.prepare(`INSERT INTO recharge_log
      (timestamp, authorization, user_name, type, amount, before_balance, after_balance, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const insertAll = db.transaction(() => {
      for (const r of rechargeData) {
        insertRecharge.run(r.timestamp, r.authorization, r.user_name, r.type, r.amount, r.before_balance, r.after_balance, r.remark);
        rechargeCount++;
      }
    });
    insertAll();
  } catch (e) { console.warn('  充值记录解析失败:', e.message); }
}
console.log(`  充值记录: ${rechargeCount} 条`);

// 6. 迁移调用日志 (最大的部分)
console.log('--- 6. 迁移调用日志 ---');

// 构建 hash → authorization 映射
const hashToAuth = {};
for (const authKey of Object.keys(auth)) {
  hashToAuth[getUserDirName(authKey)] = authKey;
}

const insertLog = db.prepare(`INSERT INTO call_logs
  (authorization, timestamp, endpoint, success, amount, client_ip, user_agent, request_params, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let logCount = 0;

if (fs.existsSync(CALL_LOGS_DIR)) {
  const userDirs = fs.readdirSync(CALL_LOGS_DIR).filter(d => {
    const full = path.join(CALL_LOGS_DIR, d);
    return fs.statSync(full).isDirectory();
  });

  for (const userDir of userDirs) {
    const authorization = hashToAuth[userDir] || `unknown_${userDir}`;
    const userPath = path.join(CALL_LOGS_DIR, userDir);
    const batch = [];

    // 遍历 YYYY-MM/DD/calls.jsonl
    const walkDir = (dir) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath);
        } else if (item === 'calls.jsonl') {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.trim().split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              batch.push(r);
            } catch (e) {}
          }
        }
      }
    };

    walkDir(userPath);

    // 批量插入
    if (batch.length > 0) {
      const insertBatch = db.transaction(() => {
        for (const r of batch) {
          insertLog.run(
            authorization,
            r.timestamp || '',
            r.endpoint || '',
            r.success ? 1 : 0,
            r.amount || 0,
            r.client_ip || null,
            r.user_agent || null,
            r.request_params ? JSON.stringify(r.request_params) : null,
            r.error_message || null
          );
          logCount++;
        }
      });
      insertBatch();
      process.stdout.write(`  用户 ${authorization.substring(0, 8)}... : ${batch.length} 条\n`);
    }
  }
}
console.log(`  调用日志总计: ${logCount} 条`);

// 7. 备份旧文件
console.log('\n--- 7. 备份旧文件 ---');
const filesToBackup = ['auth.json', 'balance.json', 'prices.json', 'usage.json', 'ip_blacklist.json', 'recharge_log.json'];
for (const f of filesToBackup) {
  const src = path.join(DATA_DIR, f);
  const dst = path.join(DATA_DIR, f + '.bak');
  if (fs.existsSync(src)) {
    fs.renameSync(src, dst);
    console.log(`  ${f} → ${f}.bak`);
  }
}

console.log('\n========================================');
console.log('  迁移完成!');
console.log(`  数据库: ${DB_PATH}`);
console.log(`  用户: ${Object.keys(auth).length}`);
console.log(`  调用日志: ${logCount}`);
console.log(`  统计: ${usageCount}`);
console.log('========================================\n');

db.close();
