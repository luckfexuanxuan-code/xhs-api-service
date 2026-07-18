/**
 * 数据管理模块 - SQLite 版本
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('../config');
const { getFallbackUpstreamUnitCost } = require('./settings');

const dataStore = {
  usersBalance: {},
  customPrices: {},
  authorizations: {},
  usageStatistics: {},
  ipBlacklist: {},
  userAccounts: {},  // { user_id: { username, balance, created_at, last_used_at } }
  userPrices: {}     // { user_id: { endpoint: price } }
};

// ==================== 预编译语句 ====================
const stmts = {
  // auth（原 users 表）
  getUser: db.prepare('SELECT * FROM users WHERE authorization = ?'),
  getAllUsers: db.prepare('SELECT * FROM users'),
  upsertUser: db.prepare(`INSERT OR REPLACE INTO users
    (authorization, name, description, created_at, enabled, initial_balance, balance, blocked, blocked_at, block_reason, unblocked_at, attack_records, user_id, is_default, quota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateBalance: db.prepare('UPDATE users SET balance = ? WHERE authorization = ?'),
  chargeBalance: db.prepare('UPDATE users SET balance = balance - ? WHERE authorization = ? AND balance >= ?'),
  refundBalance: db.prepare('UPDATE users SET balance = balance + ? WHERE authorization = ?'),
  getBalance: db.prepare('SELECT balance FROM users WHERE authorization = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE authorization = ?'),
  updateUserField: db.prepare('UPDATE users SET enabled = ?, blocked = ?, blocked_at = ?, block_reason = ?, unblocked_at = ?, attack_records = ? WHERE authorization = ?'),
  setUserIdOnAuth: db.prepare('UPDATE users SET user_id = ?, balance = 0 WHERE authorization = ?'),
  getAuthsByUserId: db.prepare('SELECT * FROM users WHERE user_id = ?'),

  // 自定义价格（auth 级，仅用于未绑定用户的 auth）
  getPrices: db.prepare('SELECT endpoint, price FROM custom_prices WHERE authorization = ?'),
  getAllPrices: db.prepare('SELECT * FROM custom_prices'),
  upsertPrice: db.prepare('INSERT OR REPLACE INTO custom_prices (authorization, endpoint, price) VALUES (?, ?, ?)'),
  deletePrices: db.prepare('DELETE FROM custom_prices WHERE authorization = ?'),

  // IP 黑名单
  getAllIpBlacklist: db.prepare('SELECT * FROM ip_blacklist'),
  upsertIp: db.prepare('INSERT OR REPLACE INTO ip_blacklist (ip, blocked, blocked_at, reason, unblocked_at) VALUES (?, ?, ?, ?, ?)'),

  // 调用日志
  insertCallLog: db.prepare(`INSERT INTO call_logs
    (authorization, timestamp, endpoint, success, amount, client_ip, user_agent, request_params, error_message, cost, upstream, upstream_attempts, upstream_api)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getCallLogs: db.prepare(`SELECT * FROM call_logs WHERE authorization = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC`),
  getAllCallLogs: db.prepare(`SELECT * FROM call_logs WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC`),
  deleteUserCallLogs: db.prepare('DELETE FROM call_logs WHERE authorization = ?'),
  countUserCallLogs: db.prepare('SELECT COUNT(*) as cnt FROM call_logs WHERE authorization = ?'),

  // 使用统计
  upsertUsage: db.prepare(`INSERT INTO usage_statistics (authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost, first_call, last_call)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(authorization, date, endpoint) DO UPDATE SET
      calls = calls + 1,
      success_calls = success_calls + excluded.success_calls,
      failed_calls = failed_calls + excluded.failed_calls,
      amount = amount + excluded.amount,
      cost = cost + excluded.cost,
      last_call = excluded.last_call`),
  upsertUsageBatch: db.prepare(`INSERT INTO usage_statistics (authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost, first_call, last_call)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(authorization, date, endpoint) DO UPDATE SET
      calls = calls + excluded.calls,
      success_calls = success_calls + excluded.success_calls,
      failed_calls = failed_calls + excluded.failed_calls,
      amount = amount + excluded.amount,
      cost = cost + excluded.cost,
      last_call = excluded.last_call`),
  getUsageByAuth: db.prepare('SELECT * FROM usage_statistics WHERE authorization = ?'),
  getAllUsage: db.prepare('SELECT * FROM usage_statistics'),
  deleteUserUsage: db.prepare('DELETE FROM usage_statistics WHERE authorization = ?'),

  // 充值记录
  insertRecharge: db.prepare(`INSERT INTO recharge_log
    (timestamp, authorization, user_name, type, amount, before_balance, after_balance, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  insertUserRecharge: db.prepare(`INSERT INTO recharge_log
    (timestamp, user_id, user_name, type, amount, before_balance, after_balance, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getRechargeLog: db.prepare('SELECT * FROM recharge_log ORDER BY id DESC'),
  getRechargeByAuth: db.prepare('SELECT * FROM recharge_log WHERE authorization = ? ORDER BY id DESC'),
  getRechargeByUserId: db.prepare('SELECT * FROM recharge_log WHERE user_id = ? ORDER BY id DESC'),
  deleteUserRecharge: db.prepare('DELETE FROM recharge_log WHERE authorization = ?'),
  deleteUserAccountRecharge: db.prepare('DELETE FROM recharge_log WHERE user_id = ?'),
  updateRechargeUserName: db.prepare('UPDATE recharge_log SET user_name = ? WHERE authorization = ?'),

  // 聚合使用统计
  getUsageTotalsByAuth: db.prepare(`SELECT authorization, SUM(calls) AS calls, SUM(success_calls) AS success_calls,
    SUM(failed_calls) AS failed_calls, SUM(amount) AS amount, SUM(cost) AS cost, MIN(first_call) AS first_call, MAX(last_call) AS last_call
    FROM usage_statistics WHERE authorization = ? GROUP BY authorization`),
  getUsageTotalsByEndpoint: db.prepare(`SELECT authorization, endpoint, SUM(calls) AS calls, SUM(success_calls) AS success_calls,
    SUM(failed_calls) AS failed_calls, SUM(amount) AS amount, SUM(cost) AS cost
    FROM usage_statistics WHERE authorization = ? AND endpoint != 'ALL' GROUP BY authorization, endpoint`),
  getUsageDailyAll: db.prepare(`SELECT authorization, date, calls, success_calls, failed_calls, amount, cost
    FROM usage_statistics WHERE authorization = ? AND date != 'TOTAL' AND endpoint = 'ALL'`),
  getUsageDailyEndpoints: db.prepare(`SELECT authorization, date, endpoint, calls, success_calls, failed_calls, amount, cost
    FROM usage_statistics WHERE authorization = ? AND date != 'TOTAL' AND endpoint != 'ALL'`),

  // 单条操作（兼容层）
  upsertSingleUser: db.prepare(`INSERT OR REPLACE INTO users
    (authorization, name, description, created_at, enabled, initial_balance, balance, blocked, blocked_at, block_reason, unblocked_at, attack_records, user_id, is_default, quota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upsertSingleIp: db.prepare('INSERT OR REPLACE INTO ip_blacklist (ip, blocked, blocked_at, reason, unblocked_at) VALUES (?, ?, ?, ?, ?)'),

  // 配额（剩余额度，NULL=不限）
  getQuota: db.prepare('SELECT quota FROM users WHERE authorization = ?'),
  decQuota: db.prepare('UPDATE users SET quota = quota - ? WHERE authorization = ? AND quota IS NOT NULL AND quota >= ?'),
  incQuota: db.prepare('UPDATE users SET quota = quota + ? WHERE authorization = ? AND quota IS NOT NULL'),
  setQuota: db.prepare('UPDATE users SET quota = ? WHERE authorization = ?'),
  upsertSinglePrice: db.prepare('INSERT OR REPLACE INTO custom_prices (authorization, endpoint, price) VALUES (?, ?, ?)'),

  // user_accounts
  getUserAccount: db.prepare('SELECT * FROM user_accounts WHERE user_id = ?'),
  getAllUserAccounts: db.prepare('SELECT * FROM user_accounts'),
  upsertUserAccount: db.prepare(`INSERT OR REPLACE INTO user_accounts (user_id, username, balance, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)`),
  updateUserAccountBalance: db.prepare('UPDATE user_accounts SET balance = ? WHERE user_id = ?'),
  chargeUserAccountBalance: db.prepare('UPDATE user_accounts SET balance = balance - ? WHERE user_id = ? AND balance >= ?'),
  refundUserAccountBalance: db.prepare('UPDATE user_accounts SET balance = balance + ? WHERE user_id = ?'),
  getUserAccountBalance: db.prepare('SELECT balance FROM user_accounts WHERE user_id = ?'),
  updateUserLastUsedAt: db.prepare('UPDATE user_accounts SET last_used_at = ? WHERE user_id = ?'),
  deleteUserAccount: db.prepare('DELETE FROM user_accounts WHERE user_id = ?'),

  // user_prices
  getUserPrices: db.prepare('SELECT endpoint, price FROM user_prices WHERE user_id = ?'),
  getAllUserPrices: db.prepare('SELECT * FROM user_prices'),
  upsertUserPrice: db.prepare('INSERT OR REPLACE INTO user_prices (user_id, endpoint, price) VALUES (?, ?, ?)'),
  deleteUserPrices: db.prepare('DELETE FROM user_prices WHERE user_id = ?'),
};

const pendingCallLogs = [];
const pendingUsageStats = new Map();
const LOG_FLUSH_INTERVAL_MS = Math.max(config.LOG_FLUSH_INTERVAL_MS || 1000, 100);
const LOG_FLUSH_BATCH_SIZE = Math.max(config.LOG_FLUSH_BATCH_SIZE || 200, 1);
const USAGE_FLUSH_INTERVAL_MS = Math.max(config.USAGE_FLUSH_INTERVAL_MS || 1000, 100);

// ==================== 工具函数 ====================

function roundBalance(value, decimals = 4) {
  if (value === null || value === undefined) return 0;
  if (Math.abs(value) < 0.0001) return 0;
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function nowStr(ms = false) {
  const n = new Date();
  const p = v => String(v).padStart(2, '0');
  const base = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  return ms ? `${base}.${String(n.getMilliseconds()).padStart(3,'0')}` : base;
}

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

function cleanErrorMessage(message) {
  if (!message) return message;
  // 去掉 Matcha 上游的内部前缀「子接口调用失败：」，只保留后面的具体原因（如“商品不存在”）
  message = message.replace(/^\s*子接口调用失败\s*[:：]\s*/, '');
  message = message.replace(/[。，,\s]*防失联.*/gi, '');
  message = message.replace(/[。，,\s]*telegram[:：].*/gi, '');
  message = message.replace(/[。，,\s]*加入.*群.*/gi, '');
  message = message.replace(/联系客服[处排查升级]*\S*/gi, '');
  message = message.replace(/客服\S*/gi, '');
  message = message.replace(/[（(]联系.*?[)）]/gi, '');
  message = message.trim().replace(/[。，,.]+$/, '');
  // 上游风控类提示统一成简洁文案（去掉「失败不扣费」等冗余感叹号文字）
  if (message.includes('风控')) {
    return '风控处理中，请保持无限重试，不超过10分钟';
  }
  // 兜底：任何含“上游”的文案都不让客户看到（避免暴露是转调供应商）
  if (message.includes('上游')) {
    return '服务繁忙，请稍后再试';
  }
  if (message.includes('通道繁忙')) {
    return '通道繁忙，建议稍后再试';
  }
  return message;
}

function cleanSensitiveText(text) {
  if (!text || typeof text !== 'string') return text;
  text = text.replace(/telegram[:：]\s*\S+/gi, '');
  text = text.replace(/防失联\S*/gi, '');
  text = text.replace(/加入.*?群\S*/gi, '');
  text = text.replace(/联系客服\S*/gi, '');
  text = text.replace(/客服(微信|QQ|qq|电话|Tel)[:：]?\s*\S+/gi, '');
  text = text.replace(/[（(]联系.*?[)）]/gi, '');
  return text.trim();
}

function cleanResponseData(data) {
  if (!data) return data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(cleanResponseData(parsed));
    } catch (e) {
      return cleanSensitiveText(data);
    }
  }
  if (Array.isArray(data)) return data.map(cleanResponseData);
  if (typeof data === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      cleaned[k] = (k === 'message' || k === 'msg') ? cleanSensitiveText(v) : cleanResponseData(v);
    }
    return cleaned;
  }
  return data;
}

function getUserDirName(authorization) {
  if (!authorization) return 'unknown';
  return crypto.createHash('sha256').update(authorization).digest('hex').substring(0, 16);
}

function generateUserId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

function generateSkAuth() {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

// ==================== 余额操作 ====================

// auth 级余额操作（用于未绑定用户的 auth）
function atomicBalanceOperation(authorization, operationType, amount) {
  try {
    if (operationType === 'charge') {
      const result = stmts.chargeBalance.run(amount, authorization, amount);
      if (result.changes === 0) {
        const row = stmts.getBalance.get(authorization);
        return { success: false, balance: roundBalance(row ? row.balance : 0), error: '余额不足' };
      }
      const row = stmts.getBalance.get(authorization);
      const newBal = roundBalance(row ? row.balance : 0);
      dataStore.usersBalance[authorization] = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'refund') {
      stmts.refundBalance.run(amount, authorization);
      const row = stmts.getBalance.get(authorization);
      const newBal = roundBalance(row ? row.balance : 0);
      dataStore.usersBalance[authorization] = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'add') {
      const row = stmts.getBalance.get(authorization);
      if (!row) return { success: false, balance: 0, error: '用户不存在' };
      stmts.refundBalance.run(amount, authorization);
      const newRow = stmts.getBalance.get(authorization);
      const newBal = roundBalance(newRow ? newRow.balance : 0);
      dataStore.usersBalance[authorization] = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'set') {
      const row = stmts.getBalance.get(authorization);
      if (!row) return { success: false, balance: 0, error: '用户不存在' };
      stmts.updateBalance.run(amount, authorization);
      dataStore.usersBalance[authorization] = roundBalance(amount);
      return { success: true, balance: roundBalance(amount), error: null };
    }
    return { success: false, balance: 0, error: '无效的操作类型' };
  } catch (e) {
    console.error(`auth余额操作失败: ${e.message}`);
    return { success: false, balance: 0, error: e.message };
  }
}

// 用户账户级余额操作
function atomicUserBalanceOperation(userId, operationType, amount) {
  try {
    if (operationType === 'charge') {
      const result = stmts.chargeUserAccountBalance.run(amount, userId, amount);
      if (result.changes === 0) {
        const row = stmts.getUserAccountBalance.get(userId);
        return { success: false, balance: roundBalance(row ? row.balance : 0), error: '余额不足' };
      }
      const row = stmts.getUserAccountBalance.get(userId);
      const newBal = roundBalance(row ? row.balance : 0);
      if (dataStore.userAccounts[userId]) dataStore.userAccounts[userId].balance = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'refund') {
      stmts.refundUserAccountBalance.run(amount, userId);
      const row = stmts.getUserAccountBalance.get(userId);
      const newBal = roundBalance(row ? row.balance : 0);
      if (dataStore.userAccounts[userId]) dataStore.userAccounts[userId].balance = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'add') {
      const row = stmts.getUserAccountBalance.get(userId);
      if (!row) return { success: false, balance: 0, error: '用户不存在' };
      stmts.refundUserAccountBalance.run(amount, userId);
      const newRow = stmts.getUserAccountBalance.get(userId);
      const newBal = roundBalance(newRow ? newRow.balance : 0);
      if (dataStore.userAccounts[userId]) dataStore.userAccounts[userId].balance = newBal;
      return { success: true, balance: newBal, error: null };
    } else if (operationType === 'set') {
      const row = stmts.getUserAccountBalance.get(userId);
      if (!row) return { success: false, balance: 0, error: '用户不存在' };
      stmts.updateUserAccountBalance.run(amount, userId);
      if (dataStore.userAccounts[userId]) dataStore.userAccounts[userId].balance = roundBalance(amount);
      return { success: true, balance: roundBalance(amount), error: null };
    }
    return { success: false, balance: 0, error: '无效的操作类型' };
  } catch (e) {
    console.error(`用户账户余额操作失败: ${e.message}`);
    return { success: false, balance: 0, error: e.message };
  }
}

// 根据 auth 的绑定状态决定使用哪个余额
function atomicBalanceOperationForAuth(authorization, operationType, amount) {
  const authInfo = dataStore.authorizations[authorization];
  const userId = authInfo ? authInfo.user_id : null;
  if (userId) {
    return atomicUserBalanceOperation(userId, operationType, amount);
  }
  return atomicBalanceOperation(authorization, operationType, amount);
}

// ==================== Key 配额（剩余额度） ====================
// 扣配额：quota=NULL 视为不限额直接放行；否则原子地 quota -= amount（不足则拒绝，不动余额）。
// 同步内存 dataStore，保证 saveUser 写回时不会用旧值覆盖。
function chargeKeyQuota(authorization, amount) {
  const info = dataStore.authorizations[authorization];
  if (!info || info.quota == null) return { success: true, unlimited: true };
  const r = stmts.decQuota.run(amount, authorization, amount);
  if (r.changes === 0) {
    return { success: false, error: '配额不足', quota: roundBalance(info.quota) };
  }
  const row = stmts.getQuota.get(authorization);
  const nb = roundBalance(row ? row.quota : 0);
  info.quota = nb;
  return { success: true, quota: nb };
}

// 退配额：与扣配额对称，上游失败退费时把额度加回去（不限额的无需处理）
function refundKeyQuota(authorization, amount) {
  const info = dataStore.authorizations[authorization];
  if (!info || info.quota == null) return;
  stmts.incQuota.run(amount, authorization);
  const row = stmts.getQuota.get(authorization);
  info.quota = roundBalance(row ? row.quota : 0);
}

// 设置配额：quota 传 null 表示改回不限额；否则直接设为该剩余额度
function setAuthQuota(authorization, quota) {
  const info = dataStore.authorizations[authorization];
  if (!info) return { success: false, error: '密钥不存在' };
  const val = (quota == null) ? null : roundBalance(quota);
  stmts.setQuota.run(val, authorization);
  info.quota = val;
  return { success: true, quota: val };
}

// 获取 auth 对应的当前余额（考虑绑定状态）
function getAuthCurrentBalance(authorization) {
  const authInfo = dataStore.authorizations[authorization];
  if (authInfo && authInfo.user_id) {
    const ua = dataStore.userAccounts[authInfo.user_id];
    return roundBalance(ua ? ua.balance : 0);
  }
  return roundBalance(dataStore.usersBalance[authorization] || 0);
}

// 获取 auth 对应的价格（考虑绑定状态）
function getPricesForAuth(authorization) {
  const authInfo = dataStore.authorizations[authorization];
  if (authInfo && authInfo.user_id) {
    return dataStore.userPrices[authInfo.user_id] || {};
  }
  return dataStore.customPrices[authorization] || {};
}

function updateUserLastUsed(userId) {
  try {
    const ts = nowStr();
    stmts.updateUserLastUsedAt.run(ts, userId);
    if (dataStore.userAccounts[userId]) {
      dataStore.userAccounts[userId].last_used_at = ts;
    }
  } catch (e) {
    console.error(`更新 last_used_at 失败: ${e.message}`);
  }
}

// ==================== 使用统计 ====================

// costOverride：本次调用的真实上游成本（按实际服务的上游接口从成本表取，计费中间件传入）。
// 未传则回退到全局兜底单价（向后兼容旧调用点）。失败调用成本恒为 0。
function recordUsageStatistics(authorization, endpoint, success = true, amount = 0, costOverride = null) {
  try {
    const today = todayStr();
    const now = nowStr();
    const successVal = success ? 1 : 0;
    const failedVal = success ? 0 : 1;
    const amountVal = success ? amount : 0;
    const costVal = success ? (costOverride != null ? roundBalance(costOverride) : getFallbackUpstreamUnitCost()) : 0;

    queueUsageStat(authorization, today, 'ALL', successVal, failedVal, amountVal, costVal, now);
    queueUsageStat(authorization, today, endpoint, successVal, failedVal, amountVal, costVal, now);
    syncUsageStatisticsCache(authorization, endpoint, today, successVal, failedVal, amountVal, costVal, now);
    return true;
  } catch (e) {
    console.error(`记录使用统计失败: ${e.message}`);
    return false;
  }
}

function queueUsageStat(authorization, date, endpoint, successCalls, failedCalls, amount, cost, timestamp) {
  const key = `${authorization} ${date} ${endpoint}`;
  const current = pendingUsageStats.get(key);
  if (current) {
    current.calls += successCalls + failedCalls;
    current.successCalls += successCalls;
    current.failedCalls += failedCalls;
    current.amount = roundBalance(current.amount + amount);
    current.cost = roundBalance(current.cost + cost);
    current.lastCall = timestamp;
    return;
  }
  pendingUsageStats.set(key, {
    authorization, date, endpoint,
    calls: successCalls + failedCalls,
    successCalls, failedCalls,
    amount: roundBalance(amount),
    cost: roundBalance(cost),
    firstCall: timestamp, lastCall: timestamp
  });
}

function flushUsageStatistics() {
  if (pendingUsageStats.size === 0) return true;
  const rows = Array.from(pendingUsageStats.values());
  pendingUsageStats.clear();
  try {
    const writeBatch = db.transaction(batch => {
      for (const row of batch) {
        stmts.upsertUsageBatch.run(
          row.authorization, row.date, row.endpoint,
          row.calls, row.successCalls, row.failedCalls,
          roundBalance(row.amount), roundBalance(row.cost),
          row.firstCall, row.lastCall
        );
      }
    });
    writeBatch(rows);
    return true;
  } catch (e) {
    for (const row of rows) {
      const key = `${row.authorization} ${row.date} ${row.endpoint}`;
      const current = pendingUsageStats.get(key);
      if (current) {
        current.calls += row.calls;
        current.successCalls += row.successCalls;
        current.failedCalls += row.failedCalls;
        current.amount = roundBalance(current.amount + row.amount);
        current.cost = roundBalance((current.cost || 0) + (row.cost || 0));
        current.lastCall = row.lastCall;
      } else {
        pendingUsageStats.set(key, row);
      }
    }
    console.error(`批量写入使用统计失败: ${e.message}`);
    return false;
  }
}

function syncUsageStatisticsCache(authorization, endpoint, date, successCalls, failedCalls, amount, cost, timestamp) {
  if (!dataStore.usageStatistics[authorization]) {
    dataStore.usageStatistics[authorization] = {
      total_calls: 0, total_amount: 0, total_cost: 0,
      endpoints: {}, daily_stats: {},
      first_call: timestamp, last_call: timestamp
    };
  }
  const userStats = dataStore.usageStatistics[authorization];
  const calls = successCalls + failedCalls;
  userStats.total_calls = (userStats.total_calls || 0) + calls;
  userStats.total_amount = roundBalance((userStats.total_amount || 0) + amount);
  userStats.total_cost = roundBalance((userStats.total_cost || 0) + cost);
  userStats.first_call = userStats.first_call || timestamp;
  userStats.last_call = timestamp;

  if (!userStats.endpoints) userStats.endpoints = {};
  if (!userStats.endpoints[endpoint]) {
    userStats.endpoints[endpoint] = { calls: 0, amount: 0, cost: 0, success_calls: 0, failed_calls: 0 };
  }
  const ep = userStats.endpoints[endpoint];
  ep.calls = (ep.calls || 0) + calls;
  ep.amount = roundBalance((ep.amount || 0) + amount);
  ep.cost = roundBalance((ep.cost || 0) + cost);
  ep.success_calls = (ep.success_calls || 0) + successCalls;
  ep.failed_calls = (ep.failed_calls || 0) + failedCalls;

  if (!userStats.daily_stats) userStats.daily_stats = {};
  if (!userStats.daily_stats[date]) {
    userStats.daily_stats[date] = { total_calls: 0, total_amount: 0, total_cost: 0, endpoints: {} };
  }
  const daily = userStats.daily_stats[date];
  daily.total_calls = (daily.total_calls || 0) + calls;
  daily.total_amount = roundBalance((daily.total_amount || 0) + amount);
  daily.total_cost = roundBalance((daily.total_cost || 0) + cost);

  if (!daily.endpoints) daily.endpoints = {};
  if (!daily.endpoints[endpoint]) {
    daily.endpoints[endpoint] = { calls: 0, amount: 0, cost: 0, success_calls: 0, failed_calls: 0 };
  }
  const dep = daily.endpoints[endpoint];
  dep.calls = (dep.calls || 0) + calls;
  dep.amount = roundBalance((dep.amount || 0) + amount);
  dep.cost = roundBalance((dep.cost || 0) + cost);
  dep.success_calls = (dep.success_calls || 0) + successCalls;
  dep.failed_calls = (dep.failed_calls || 0) + failedCalls;
}

// ==================== 调用日志 ====================

const MAX_CALL_LOG_PARAMS_CHARS = parseInt(process.env.MAX_CALL_LOG_PARAMS_CHARS || '4096', 10);
const MAX_CALL_LOG_STRING_VALUE_CHARS = parseInt(process.env.MAX_CALL_LOG_STRING_VALUE_CHARS || '512', 10);

function stringifyRequestParams(requestParams) {
  if (!requestParams) return null;
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(requestParams, (key, value) => {
      if (typeof value === 'string' && value.length > MAX_CALL_LOG_STRING_VALUE_CHARS) {
        return `${value.slice(0, MAX_CALL_LOG_STRING_VALUE_CHARS)}... [truncated ${value.length - MAX_CALL_LOG_STRING_VALUE_CHARS} chars]`;
      }
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    if (!Number.isFinite(MAX_CALL_LOG_PARAMS_CHARS) || MAX_CALL_LOG_PARAMS_CHARS <= 0 || json.length <= MAX_CALL_LOG_PARAMS_CHARS) {
      return json;
    }
    return JSON.stringify({
      _truncated: true,
      original_chars: json.length,
      preview: json.slice(0, MAX_CALL_LOG_PARAMS_CHARS)
    });
  } catch (e) {
    return JSON.stringify({ _serialize_error: e.message });
  }
}

function recordCallLog(authorization, endpoint, success, amount, clientIp, userAgent = null, requestParams = null, errorMessage = null, cost = 0, upstream = '', upstreamAttempts = '', upstreamApi = '') {
  try {
    pendingCallLogs.push({
      authorization,
      timestamp: nowStr(true),
      endpoint,
      success: success ? 1 : 0,
      amount: roundBalance(amount),
      clientIp,
      userAgent: userAgent || 'Unknown',
      requestParams: stringifyRequestParams(requestParams),
      errorMessage: errorMessage || null,
      cost: roundBalance(cost || 0),
      upstream: upstream || '',
      upstreamAttempts: upstreamAttempts || '',
      upstreamApi: upstreamApi || ''
    });
    if (pendingCallLogs.length >= LOG_FLUSH_BATCH_SIZE) {
      flushCallLogs(LOG_FLUSH_BATCH_SIZE);
    }
    return true;
  } catch (e) {
    console.error(`记录调用日志失败: ${e.message}`);
    return false;
  }
}

function flushCallLogs(maxRows = null) {
  if (pendingCallLogs.length === 0) return true;
  const size = maxRows ? Math.min(maxRows, pendingCallLogs.length) : pendingCallLogs.length;
  const rows = pendingCallLogs.splice(0, size);
  try {
    const writeBatch = db.transaction(batch => {
      for (const row of batch) {
        stmts.insertCallLog.run(
          row.authorization, row.timestamp, row.endpoint,
          row.success, row.amount, row.clientIp,
          row.userAgent, row.requestParams, row.errorMessage,
          row.cost || 0, row.upstream || '', row.upstreamAttempts || '', row.upstreamApi || ''
        );
      }
    });
    writeBatch(rows);
    return true;
  } catch (e) {
    pendingCallLogs.unshift(...rows);
    console.error(`批量写入调用日志失败: ${e.message}`);
    return false;
  }
}

function flushBufferedWrites() {
  return flushCallLogs() && flushUsageStatistics();
}

const logFlushTimer = setInterval(() => flushCallLogs(), LOG_FLUSH_INTERVAL_MS);
const usageFlushTimer = setInterval(() => flushUsageStatistics(), USAGE_FLUSH_INTERVAL_MS);
if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();
if (typeof usageFlushTimer.unref === 'function') usageFlushTimer.unref();

function exportCallLogs(authorization = null, startDate = null, endDate = null, sortByTime = false) {
  try {
    flushCallLogs();
    const startTs = startDate || '2020-01-01';
    const endTs = (endDate || '2099-12-31') + ' 23:59:59.999';

    let rows;
    if (authorization) {
      rows = stmts.getCallLogs.all(authorization, startTs, endTs);
    } else {
      rows = stmts.getAllCallLogs.all(startTs, endTs);
    }

    const uniqueAuths = [...new Set(rows.map(r => r.authorization))];
    const userNames = {};
    const usernames = {};
    for (const auth of uniqueAuths) {
      const info = dataStore.authorizations[auth];
      userNames[auth] = info ? (info.name || '') : '';
      const userId = info ? (info.user_id || null) : null;
      const ua = userId ? dataStore.userAccounts[userId] : null;
      usernames[auth] = ua ? ua.username : null;
    }

    const records = rows.map(r => ({
      timestamp: r.timestamp,
      endpoint: r.endpoint,
      success: r.success === 1,
      amount: r.amount,
      cost: r.cost || 0,
      upstream: r.upstream || '',
      upstream_attempts: r.upstream_attempts || '',
      client_ip: r.client_ip,
      user_agent: r.user_agent,
      request_params: r.request_params,
      error_message: r.error_message,
      user_hash: getUserDirName(r.authorization),
      // user_name 是密钥自己的备注名；username 是密钥绑定的真实账户用户名（可能没绑定，为 null）。
      user_name: userNames[r.authorization] || '',
      username: usernames[r.authorization] || null,
      authorization: r.authorization
    }));

    if (sortByTime) records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      success: true, records,
      count: records.length,
      start_date: startDate || startTs,
      end_date: endDate || todayStr(),
      sorted: sortByTime
    };
  } catch (e) {
    console.error(`导出调用日志失败: ${e.message}`);
    return { success: false, error: e.message, records: [], count: 0 };
  }
}

function deleteUserCallLogs(authorization) {
  try {
    flushCallLogs();
    const countRow = stmts.countUserCallLogs.get(authorization);
    const count = countRow ? countRow.cnt : 0;
    stmts.deleteUserCallLogs.run(authorization);
    return { success: true, deleted: count, message: `已删除 ${count} 条日志记录` };
  } catch (e) {
    return { success: false, deleted: 0, message: e.message };
  }
}

// ==================== 使用统计查询 ====================

function getUsageStatisticsFromDB(authorization = null) {
  try {
    flushUsageStatistics();
    if (authorization) {
      const totalsRow = stmts.getUsageTotalsByAuth.get(authorization);
      if (!totalsRow) return null;

      const endpointRows = stmts.getUsageTotalsByEndpoint.all(authorization);
      const dailyAllRows = stmts.getUsageDailyAll.all(authorization);
      const dailyEpRows = stmts.getUsageDailyEndpoints.all(authorization);

      const endpoints = {};
      for (const r of endpointRows) {
        endpoints[r.endpoint] = {
          calls: r.calls,
          amount: roundBalance(r.amount || 0),
          cost: roundBalance(r.cost || 0),
          profit: roundBalance((r.amount || 0) - (r.cost || 0)),
          success_calls: r.success_calls,
          failed_calls: r.failed_calls
        };
      }

      const daily_stats = {};
      for (const r of dailyAllRows) {
        daily_stats[r.date] = {
          total_calls: r.calls,
          total_amount: roundBalance(r.amount || 0),
          total_cost: roundBalance(r.cost || 0),
          total_profit: roundBalance((r.amount || 0) - (r.cost || 0)),
          endpoints: {}
        };
      }
      for (const r of dailyEpRows) {
        if (!daily_stats[r.date]) daily_stats[r.date] = { total_calls: 0, total_amount: 0, total_cost: 0, total_profit: 0, endpoints: {} };
        daily_stats[r.date].endpoints[r.endpoint] = {
          calls: r.calls,
          amount: roundBalance(r.amount || 0),
          cost: roundBalance(r.cost || 0),
          profit: roundBalance((r.amount || 0) - (r.cost || 0)),
          success_calls: r.success_calls,
          failed_calls: r.failed_calls
        };
      }

      const firstLast = db.prepare('SELECT MIN(first_call) AS first_call, MAX(last_call) AS last_call FROM usage_statistics WHERE authorization = ?').get(authorization);

      return {
        total_calls: totalsRow.calls,
        total_amount: roundBalance(totalsRow.amount || 0),
        total_cost: roundBalance(totalsRow.cost || 0),
        total_profit: roundBalance((totalsRow.amount || 0) - (totalsRow.cost || 0)),
        first_call: firstLast ? firstLast.first_call : '',
        last_call: firstLast ? firstLast.last_call : '',
        endpoints, daily_stats
      };
    } else {
      const allAuths = Object.keys(dataStore.authorizations);
      const result = {};
      for (const auth of allAuths) {
        const stats = getUsageStatisticsFromDB(auth);
        if (stats) result[auth] = stats;
      }
      return result;
    }
  } catch (e) {
    console.error(`查询使用统计失败: ${e.message}`);
    return authorization ? null : {};
  }
}

function backfillUsageCostOnce() {
  try {
    const marker = 'usage_cost_backfilled_v1';
    const existing = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(marker);
    if (existing && existing.value === '1') return;

    // 一次性历史回填（生产库已打标记跳过）：老数据没有逐次成本，统一按兜底单价估算
    const fallbackCost = getFallbackUpstreamUnitCost();
    const endpoints = db.prepare("SELECT DISTINCT endpoint FROM usage_statistics WHERE endpoint != 'ALL'").all();
    const allRows = db.prepare(`
      SELECT authorization, date, SUM(cost) AS cost
      FROM usage_statistics
      WHERE endpoint != 'ALL'
      GROUP BY authorization, date
    `);
    const updateEndpoint = db.prepare('UPDATE usage_statistics SET cost = success_calls * ? WHERE endpoint = ?');
    const updateAll = db.prepare("UPDATE usage_statistics SET cost = ? WHERE authorization = ? AND date = ? AND endpoint = 'ALL'");
    const setMarker = db.prepare(`INSERT INTO app_settings(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    const run = db.transaction(() => {
      for (const row of endpoints) {
        updateEndpoint.run(fallbackCost, row.endpoint);
      }
      for (const row of allRows.all()) {
        updateAll.run(roundBalance(row.cost || 0), row.authorization, row.date);
      }
      setMarker.run(marker, '1');
    });
    run();
    console.log(`使用统计成本回填完成，接口数: ${endpoints.length}`);
  } catch (e) {
    console.error(`使用统计成本回填失败: ${e.message}`);
  }
}

// ==================== 兼容层 ====================

function safeFileOperation(filepath, operation = 'read', data = null) {
  const base = path.basename(filepath);

  if (base === 'auth.json') {
    if (operation === 'read') {
      const rows = stmts.getAllUsers.all();
      const result = {};
      for (const r of rows) {
        result[r.authorization] = {
          name: r.name, description: r.description,
          created_at: r.created_at, enabled: r.enabled === 1,
          initial_balance: r.initial_balance,
          attack_records: JSON.parse(r.attack_records || '[]'),
          blocked: r.blocked === 1, blocked_at: r.blocked_at || '',
          block_reason: r.block_reason || '', unblocked_at: r.unblocked_at || '',
          user_id: r.user_id || null, is_default: r.is_default === 1,
          quota: r.quota == null ? null : r.quota
        };
      }
      return result;
    } else {
      const writeAll = db.transaction(() => {
        for (const [auth, info] of Object.entries(data)) {
          stmts.upsertUser.run(
            auth, info.name || '', info.description || '', info.created_at || nowStr(),
            info.enabled === false ? 0 : 1, info.initial_balance || 0,
            dataStore.usersBalance[auth] || 0,
            info.blocked ? 1 : 0, info.blocked_at || null, info.block_reason || null,
            info.unblocked_at || null, JSON.stringify(info.attack_records || []),
            info.user_id || null, info.is_default ? 1 : 0,
            info.quota == null ? null : info.quota
          );
        }
      });
      writeAll();
      return true;
    }
  }

  if (base === 'balance.json') {
    if (operation === 'read') {
      const rows = stmts.getAllUsers.all();
      const result = {};
      for (const r of rows) result[r.authorization] = r.balance;
      return result;
    } else {
      const writeAll = db.transaction(() => {
        for (const [auth, bal] of Object.entries(data)) {
          stmts.updateBalance.run(bal, auth);
        }
      });
      writeAll();
      return true;
    }
  }

  if (base === 'prices.json') {
    if (operation === 'read') {
      const rows = stmts.getAllPrices.all();
      const result = {};
      for (const r of rows) {
        if (!result[r.authorization]) result[r.authorization] = {};
        result[r.authorization][r.endpoint] = r.price;
      }
      return result;
    } else {
      const writeAll = db.transaction(() => {
        for (const [auth, endpoints] of Object.entries(data)) {
          for (const [ep, price] of Object.entries(endpoints)) {
            stmts.upsertPrice.run(auth, ep, price);
          }
        }
      });
      writeAll();
      return true;
    }
  }

  if (base === 'usage.json') {
    if (operation === 'read') return getUsageStatisticsFromDB();
    return true;
  }

  if (base === 'ip_blacklist.json') {
    if (operation === 'read') {
      const rows = stmts.getAllIpBlacklist.all();
      const result = {};
      for (const r of rows) {
        result[r.ip] = { blocked: r.blocked === 1, blocked_at: r.blocked_at, reason: r.reason, unblocked_at: r.unblocked_at };
      }
      return result;
    } else {
      const writeAll = db.transaction(() => {
        for (const [ip, info] of Object.entries(data)) {
          stmts.upsertIp.run(ip, info.blocked ? 1 : 0, info.blocked_at || null, info.reason || null, info.unblocked_at || null);
        }
      });
      writeAll();
      return true;
    }
  }

  console.warn(`safeFileOperation: 未知文件 ${filepath}，回退到文件操作`);
  const fullPath = path.resolve(__dirname, '..', filepath);
  if (operation === 'read') {
    if (!fs.existsSync(fullPath)) return {};
    return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  } else {
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  }
}

// ==================== 加载 / 保存 ====================

function loadData() {
  try {
    console.log('开始加载数据 (SQLite)');

    // 加载 auth
    const users = stmts.getAllUsers.all();
    for (const u of users) {
      dataStore.usersBalance[u.authorization] = u.balance;
      dataStore.authorizations[u.authorization] = {
        name: u.name, description: u.description,
        created_at: u.created_at, enabled: u.enabled === 1,
        initial_balance: u.initial_balance,
        attack_records: JSON.parse(u.attack_records || '[]'),
        blocked: u.blocked === 1, blocked_at: u.blocked_at || '',
        block_reason: u.block_reason || '', unblocked_at: u.unblocked_at || '',
        user_id: u.user_id || null, is_default: u.is_default === 1,
        quota: u.quota == null ? null : u.quota
      };
    }
    console.log(`Auth数据加载成功，数量: ${users.length}`);

    // 加载 auth 级自定义价格
    const prices = stmts.getAllPrices.all();
    for (const p of prices) {
      if (!dataStore.customPrices[p.authorization]) dataStore.customPrices[p.authorization] = {};
      dataStore.customPrices[p.authorization][p.endpoint] = p.price;
    }
    console.log(`Auth价格加载成功`);

    // 加载用户账户
    const userAccounts = stmts.getAllUserAccounts.all();
    for (const ua of userAccounts) {
      dataStore.userAccounts[ua.user_id] = {
        username: ua.username,
        balance: ua.balance,
        created_at: ua.created_at,
        last_used_at: ua.last_used_at || null
      };
    }
    console.log(`用户账户加载成功，数量: ${userAccounts.length}`);

    // 加载用户级价格
    const userPrices = stmts.getAllUserPrices.all();
    for (const p of userPrices) {
      if (!dataStore.userPrices[p.user_id]) dataStore.userPrices[p.user_id] = {};
      dataStore.userPrices[p.user_id][p.endpoint] = p.price;
    }
    console.log(`用户价格加载成功`);

    // 加载 IP 黑名单
    const ips = stmts.getAllIpBlacklist.all();
    for (const ip of ips) {
      dataStore.ipBlacklist[ip.ip] = {
        blocked: ip.blocked === 1, blocked_at: ip.blocked_at,
        reason: ip.reason, unblocked_at: ip.unblocked_at
      };
    }
    console.log(`IP黑名单加载成功，IP数: ${ips.length}`);

    backfillUsageCostOnce();

  } catch (e) {
    console.error(`加载数据失败: ${e.message}`);
    throw e;
  }
}

function saveData() {
  try {
    const syncAll = db.transaction(() => {
      for (const [auth, info] of Object.entries(dataStore.authorizations)) {
        const bal = dataStore.usersBalance[auth] || 0;
        stmts.upsertUser.run(
          auth, info.name || '', info.description || '', info.created_at || '',
          info.enabled === false ? 0 : 1, info.initial_balance || 0, bal,
          info.blocked ? 1 : 0, info.blocked_at || null, info.block_reason || null,
          info.unblocked_at || null, JSON.stringify(info.attack_records || []),
          info.user_id || null, info.is_default ? 1 : 0,
          info.quota == null ? null : info.quota
        );
      }
    });
    syncAll();
    return true;
  } catch (e) {
    console.error(`保存数据失败: ${e.message}`);
    return false;
  }
}

function saveUser(authorization) {
  try {
    const info = dataStore.authorizations[authorization];
    if (!info) return false;
    const bal = dataStore.usersBalance[authorization] || 0;
    stmts.upsertSingleUser.run(
      authorization, info.name || '', info.description || '', info.created_at || '',
      info.enabled === false ? 0 : 1, info.initial_balance || 0, bal,
      info.blocked ? 1 : 0, info.blocked_at || null, info.block_reason || null,
      info.unblocked_at || null, JSON.stringify(info.attack_records || []),
      info.user_id || null, info.is_default ? 1 : 0,
      info.quota == null ? null : info.quota
    );
    return true;
  } catch (e) {
    console.error(`保存单Auth数据失败: ${e.message}`);
    return false;
  }
}

function saveUserAccount(userId) {
  try {
    const ua = dataStore.userAccounts[userId];
    if (!ua) return false;
    stmts.upsertUserAccount.run(userId, ua.username, ua.balance, ua.created_at, ua.last_used_at || null);
    return true;
  } catch (e) {
    console.error(`保存用户账户失败: ${e.message}`);
    return false;
  }
}

function saveUserPrice(userId, endpoint, price) {
  try {
    stmts.upsertUserPrice.run(userId, endpoint, price);
    return true;
  } catch (e) {
    console.error(`保存用户价格失败: ${e.message}`);
    return false;
  }
}

function saveSingleIpBlacklist(ip) {
  try {
    const info = dataStore.ipBlacklist[ip];
    if (!info) return false;
    stmts.upsertSingleIp.run(ip, info.blocked ? 1 : 0, info.blocked_at || null, info.reason || null, info.unblocked_at || null);
    return true;
  } catch (e) {
    console.error(`保存IP黑名单失败: ${e.message}`);
    return false;
  }
}

function saveSinglePrice(authorization, endpoint, price) {
  try {
    stmts.upsertSinglePrice.run(authorization, endpoint, price);
    return true;
  } catch (e) {
    console.error(`保存自定义价格失败: ${e.message}`);
    return false;
  }
}

function initDataDir() {
  const dataDir = path.resolve(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  console.log('数据目录创建成功');
}

// ==================== 导出 ====================
module.exports = {
  db,
  dataStore,
  stmts,
  roundBalance,
  nowStr,
  todayStr,
  cleanErrorMessage,
  cleanResponseData,
  atomicBalanceOperation,
  atomicUserBalanceOperation,
  atomicBalanceOperationForAuth,
  chargeKeyQuota,
  refundKeyQuota,
  setAuthQuota,
  getAuthCurrentBalance,
  getPricesForAuth,
  updateUserLastUsed,
  recordUsageStatistics,
  getUserDirName,
  recordCallLog,
  flushBufferedWrites,
  flushCallLogs,
  flushUsageStatistics,
  loadData,
  saveData,
  saveUser,
  saveUserAccount,
  saveUserPrice,
  saveSingleIpBlacklist,
  saveSinglePrice,
  getUsageStatisticsFromDB,
  initDataDir,
  exportCallLogs,
  deleteUserCallLogs,
  generateUserId,
  generateSkAuth
};
