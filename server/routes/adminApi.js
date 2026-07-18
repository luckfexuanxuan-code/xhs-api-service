/**
 * 管理员API路由 - 处理管理员接口请求
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const config = require('../config');
const { adminRequired } = require('../middleware/auth');
const { getRateLimitQps, setRateLimitQps, getDownstreamTestKey, setDownstreamTestKey,
  getAllUpstreamApiCosts, setUpstreamApiCost, getFallbackUpstreamUnitCost,
  getUpstreamApiTestList, getUpstreamApiRegistryEntry,
  setThrottleRule, getThrottleRules, deleteThrottleScope,
  getDefaultPrice, getAllDefaultPrices, setDefaultPrice,
  getAllEndpointStatuses, setEndpointStatus } = require('../utils/settings');
const { getAllUpstreamBalances } = require('../utils/upstreamBalance');
const { isPrivateIp, resolveIpLocationsBatch } = require('../utils/ipLocation');
const {
  db,
  dataStore,
  stmts,
  roundBalance,
  nowStr,
  todayStr,
  saveUser,
  saveUserAccount,
  saveUserPrice,
  saveSingleIpBlacklist,
  saveSinglePrice,
  getUsageStatisticsFromDB,
  exportCallLogs,
  getUserDirName,
  deleteUserCallLogs,
  atomicBalanceOperation,
  atomicUserBalanceOperation,
  flushBufferedWrites,
  flushCallLogs,
  flushUsageStatistics,
  generateUserId,
  generateSkAuth,
  setAuthQuota
} = require('../utils/dataManager');
const { listUserUsageSummary, listDailyUserUsageSummary } = require('../utils/accountUsage');
const { firewallBlockIp, firewallUnblockIp } = require('../utils/firewall');

// ==================== 充值记录 ====================
function addRechargeRecord(authorization, type, amount, beforeBalance, afterBalance, remark) {
  const userName = (dataStore.authorizations[authorization] || {}).name || '未知';
  try {
    db.prepare(`INSERT INTO recharge_log (timestamp, authorization, user_name, type, amount, before_balance, after_balance, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(nowStr(), authorization, userName, type, amount, beforeBalance, afterBalance, remark);
  } catch (e) {
    console.error('保存充值记录失败:', e.message);
  }
}

// 日志缓冲区
const logBuffer = [];
const MAX_LOG_BUFFER = 500;
let logBufferSeq = 0; // 单调递增序号，每次 push 自增，缓冲区满不影响

// ==================== 登录接口 ====================
// 登录速率限制：每 IP 最多 10 次失败尝试，锁定 15 分钟
const loginAttempts = new Map(); // { ip: { count, firstAttempt, lockedUntil } }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { blocked: false };

  // 锁定到期，重置
  if (record.lockedUntil && now > record.lockedUntil) {
    loginAttempts.delete(ip);
    return { blocked: false };
  }

  if (record.lockedUntil && now <= record.lockedUntil) {
    return { blocked: true, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }

  // 窗口到期，重置
  if (now - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { blocked: false };
  }

  return { blocked: false };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  if (success) {
    loginAttempts.delete(ip);
    return;
  }

  let record = loginAttempts.get(ip);
  if (!record || now - record.firstAttempt > LOGIN_WINDOW_MS) {
    record = { count: 0, firstAttempt: now, lockedUntil: null };
  }

  record.count++;
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_WINDOW_MS;
    console.warn(`IP ${ip} 登录失败次数过多，已锁定 ${LOGIN_WINDOW_MS / 60000} 分钟`);
  }

  loginAttempts.set(ip, record);
}

router.post('/login', (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    const rateLimit = checkLoginRateLimit(clientIp);

    if (rateLimit.blocked) {
      console.warn(`登录被速率限制拦截，IP: ${clientIp}`);
      return res.status(429).json({
        message: '失败',
        error: `登录尝试过多，请 ${rateLimit.retryAfter} 秒后重试`
      });
    }

    const { username, password } = req.body;

    if (username === config.ADMIN_USERNAME && password === config.ADMIN_PASSWORD) {
      recordLoginAttempt(clientIp, true);
      console.log(`管理员登录成功，IP: ${clientIp}`);
      return res.json({
        message: '成功',
        admin_key: config.ADMIN_SECRET_KEY,
        username
      });
    } else {
      recordLoginAttempt(clientIp, false);
      console.warn(`管理员登录失败，IP: ${clientIp}, 用户名: ${username}`);
      return res.status(401).json({
        message: '失败',
        error: '用户名或密码错误'
      });
    }
  } catch (e) {
    console.error(`登录接口异常: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/verify_login', (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;

  if (adminKey === config.ADMIN_SECRET_KEY) {
    return res.json({
      message: '成功',
      logged_in: true
    });
  } else {
    return res.status(401).json({
      message: '失败',
      logged_in: false
    });
  }
});

// ==================== 用户管理 ====================
router.post('/create_auth', adminRequired, async (req, res) => {
  try {
    const { name, description = '' } = req.body;
    const initial_balance = Math.max(0, parseFloat(req.body.initial_balance) || 0);

    if (!name) {
      return res.status(400).json({
        message: '失败',
        error: '缺少name参数'
      });
    }

    const auth = generateSkAuth();

    dataStore.authorizations[auth] = {
      name,
      description,
      created_at: nowStr(),
      enabled: true,
      initial_balance
    };

    dataStore.usersBalance[auth] = initial_balance;

    // 新用户默认价目：使用「系统设置」里的接口默认价（可改，落库），未改的回落 config
    const defaultPrices = getAllDefaultPrices();
    dataStore.customPrices[auth] = defaultPrices;

    try {
      saveUser(auth);
      for (const [ep, price] of Object.entries(defaultPrices)) {
        saveSinglePrice(auth, ep, price);
      }
    } catch (e) {
      console.error(`保存数据失败: ${e.message}`);
    }

    if (initial_balance > 0) {
      addRechargeRecord(auth, 'create', initial_balance, 0, initial_balance, `创建用户，初始余额 ${initial_balance} 元`);
    }

    return res.json({
      message: '成功',
      authorization: auth,
      name,
      description,
      initial_balance
    });
  } catch (e) {
    console.error(`创建authorization失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/set_balance', adminRequired, async (req, res) => {
  const { authorization, amount } = req.body;

  if (!authorization || amount === undefined || amount === null) {
    return res.status(400).json({
      message: '失败',
      error: '缺少必要参数'
    });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount < 0) {
    return res.status(400).json({
      message: '失败',
      error: '余额不能为负数'
    });
  }

  try {
    const previousBalance = dataStore.usersBalance[authorization] || 0;
    const result = await atomicBalanceOperation(authorization, 'set', parsedAmount);

    if (!result.success) {
      return res.status(400).json({
        message: '失败',
        error: result.error
      });
    }

    addRechargeRecord(authorization, 'set_balance', roundBalance(parsedAmount - previousBalance), previousBalance, parsedAmount, `设置余额为 ${parsedAmount}`);
    console.log(`管理员设置用户 ${authorization} 余额为: ${parsedAmount}`);
    return res.json({
      message: '成功',
      balance: result.balance
    });
  } catch (e) {
    console.error(`设置余额失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/recharge', adminRequired, async (req, res) => {
  const { authorization, amount } = req.body;

  if (!authorization || amount === undefined) {
    return res.status(400).json({
      message: '失败',
      error: '缺少必要参数'
    });
  }

  if (amount <= 0) {
    return res.status(400).json({
      message: '失败',
      error: '充值金额必须大于0'
    });
  }

  try {
    const currentBalance = dataStore.usersBalance[authorization] || 0;
    const result = await atomicBalanceOperation(authorization, 'add', amount);

    if (!result.success) {
      return res.status(400).json({
        message: '失败',
        error: result.error
      });
    }

    addRechargeRecord(authorization, 'recharge', amount, currentBalance, result.balance, `充值 ${amount} 元`);
    console.log(`管理员为用户 ${authorization} 充值: ${amount}，原余额: ${currentBalance}，新余额: ${result.balance}`);
    return res.json({
      message: '成功',
      previous_balance: currentBalance,
      recharge_amount: amount,
      new_balance: result.balance
    });
  } catch (e) {
    console.error(`充值失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 获取用户自定义价格
// 查询充值记录
router.get('/get_recharge_log', adminRequired, (req, res) => {
  try {
    const { authorization, user_id, channel, type, start_date, end_date } = req.query;
    let sql = 'SELECT * FROM recharge_log WHERE 1=1';
    const params = [];

    if (authorization) { sql += ' AND authorization = ?'; params.push(authorization); }
    if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
    if (channel) { sql += ' AND channel = ?'; params.push(channel); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (start_date) { sql += ' AND timestamp >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND timestamp <= ?'; params.push(end_date + ' 23:59:59'); }
    sql += ' ORDER BY id DESC';

    const records = db.prepare(sql).all(...params);

    let totalRecharge = 0;
    records.forEach(r => {
      if (r.type === 'recharge' || r.type === 'create') totalRecharge += r.amount;
    });

    return res.json({
      message: '成功',
      data: { records, count: records.length, total_recharge: roundBalance(totalRecharge) }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 注：/get_user_prices 的完整实现在文件后部（同时支持 user_id 与 authorization）。
// 此处原有一个仅支持 authorization 的旧版本，会遮蔽后者导致用户级定价读不出，已移除。

router.post('/set_custom_price', adminRequired, async (req, res) => {
  const { authorization, endpoint, price } = req.body;

  if (!authorization || !endpoint || price === undefined) {
    return res.status(400).json({
      message: '失败',
      error: '缺少必要参数'
    });
  }

  try {
    if (!dataStore.customPrices[authorization]) {
      dataStore.customPrices[authorization] = {};
    }
    dataStore.customPrices[authorization][endpoint] = price;

    if (saveSinglePrice(authorization, endpoint, price)) {
      console.log(`管理员设置用户 ${authorization} 接口 ${endpoint} 价格为: ${price}`);
      return res.json({
        message: '成功',
        price
      });
    } else {
      return res.status(500).json({
        message: '失败',
        error: '保存数据失败'
      });
    }
  } catch (e) {
    console.error(`设置自定义价格失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 修改用户名 / 备注
router.post('/rename_user', adminRequired, async (req, res) => {
  const { authorization, name, description } = req.body;
  if (!authorization || (name === undefined && description === undefined)) {
    return res.status(400).json({ message: '失败', error: '缺少参数' });
  }
  try {
    if (!dataStore.authorizations[authorization]) {
      return res.status(404).json({ message: '失败', error: '用户不存在' });
    }
    if (typeof name === 'string' && name.trim()) dataStore.authorizations[authorization].name = name.trim();
    if (typeof description === 'string') dataStore.authorizations[authorization].description = description;

    saveUser(authorization);

    // 把 recharge_log 里该用户的 user_name 也同步刷新（显示用）
    if (typeof name === 'string' && name.trim()) {
      try { db.prepare('UPDATE recharge_log SET user_name = ? WHERE authorization = ?').run(name.trim(), authorization); } catch (e) {}
    }

    console.log(`管理员修改用户: ${authorization} → name=${dataStore.authorizations[authorization].name}`);
    return res.json({ message: '成功', user: dataStore.authorizations[authorization] });
  } catch (e) {
    console.error(`修改用户失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

router.post('/delete_user', adminRequired, async (req, res) => {
  const { authorization } = req.body;

  if (!authorization) {
    return res.status(400).json({
      message: '失败',
      error: '缺少authorization参数'
    });
  }

  try {
    flushBufferedWrites();
    // 直接用 SQL DELETE（safeFileOperation 的 write 走 upsert，不删行）
    const counts = { user: 0, prices: 0, usage: 0, recharge: 0, call_logs: 0 };
    try { counts.user     = db.prepare('DELETE FROM users WHERE authorization = ?').run(authorization).changes; } catch (e) {}
    try { counts.prices   = db.prepare('DELETE FROM custom_prices WHERE authorization = ?').run(authorization).changes; } catch (e) {}
    try { counts.usage    = db.prepare('DELETE FROM usage_statistics WHERE authorization = ?').run(authorization).changes; } catch (e) {}
    try { counts.recharge = db.prepare('DELETE FROM recharge_log WHERE authorization = ?').run(authorization).changes; } catch (e) {}
    try { counts.call_logs = db.prepare('DELETE FROM call_logs WHERE authorization = ?').run(authorization).changes; } catch (e) {}
    try { deleteThrottleScope('auth', authorization); } catch (e) {}

    // 内存缓存同步清理
    delete dataStore.authorizations[authorization];
    delete dataStore.usersBalance[authorization];
    delete dataStore.customPrices[authorization];
    if (dataStore.usageStatistics) delete dataStore.usageStatistics[authorization];

    if (counts.user === 0) {
      return res.status(404).json({ message: '失败', error: '用户不存在' });
    }

    console.log(`管理员删除用户: ${authorization} | 清理 user=${counts.user} prices=${counts.prices} usage=${counts.usage} recharge=${counts.recharge} call_logs=${counts.call_logs}`);
    return res.json({ message: '成功', cleaned: counts });
  } catch (e) {
    console.error(`删除用户失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/list_auth', (req, res) => {
  try {
    // 鉴权策略：
    // - 带管理员密钥(X-Admin-Key)：可列全部，也可用 user_id 过滤（后台用）。
    // - 不带管理员密钥：必须提供 user_id，且只返回该用户的密钥；缺 user_id 直接打回，
    //   杜绝无密钥时被公网拖走全平台密钥。user_id 此时即唯一凭据，务必保密。
    const filterUserId = String(req.query.user_id || '').trim();
    const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
    const isAdmin = !!adminKey && adminKey === config.ADMIN_SECRET_KEY;
    if (!isAdmin && !filterUserId) {
      return res.status(401).json({ message: '失败', error: '缺少 user_id（或管理员密钥）' });
    }
    const result = [];
    for (const [auth, info] of Object.entries(dataStore.authorizations)) {
      const userId = info.user_id || null;
      if (filterUserId && userId !== filterUserId) continue;
      const ua = userId ? dataStore.userAccounts[userId] : null;
      result.push({
        authorization: auth,
        name: info.name,
        description: info.description,
        created_at: info.created_at,
        enabled: info.enabled,
        blocked: info.blocked || false,
        blocked_at: info.blocked_at || '',
        block_reason: info.block_reason || '',
        attack_count: (info.attack_records || []).length,
        balance: dataStore.usersBalance[auth] || 0,
        quota: info.quota == null ? 'unlimited' : roundBalance(info.quota),
        user_id: userId,
        username: ua ? ua.username : null,
        is_default: info.is_default || false
      });
    }

    return res.json({
      message: '成功',
      data: result
    });
  } catch (e) {
    console.error(`获取authorization列表失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 设置某个密钥的配额（剩余额度）。普通调用必须传 >=0 的数字；
// 只有可信管理员调用可以传 null / "unlimited"，用于保证默认 API Key 永久不限额。
// 鉴权：带管理员密钥(X-Admin-Key)直接放行（后台用）；否则必须提供 user_id，
//       且该 user_id 与 authorization 的归属一致才放行（user_id 即唯一凭据，须保密）。
router.post('/set_auth_quota', (req, res) => {
  try {
    const { authorization, user_id } = req.body;
    let { quota } = req.body;
    if (!authorization) {
      return res.status(400).json({ message: '失败', error: '缺少 authorization' });
    }
    const info = dataStore.authorizations[authorization];
    if (!info) {
      return res.status(404).json({ message: '失败', error: '密钥不存在' });
    }
    // 鉴权：管理员密钥 或 (user_id + authorization 归属匹配)
    const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
    const isAdmin = !!adminKey && adminKey === config.ADMIN_SECRET_KEY;
    if (!isAdmin) {
      const uid = String(user_id || '').trim();
      if (!uid) {
        return res.status(401).json({ message: '失败', error: '缺少 user_id（或管理员密钥）' });
      }
      if (info.user_id !== uid) {
        return res.status(403).json({ message: '失败', error: 'user_id 与该密钥不匹配' });
      }
    }
    const unlimitedRequested = quota === null || quota === 'unlimited';
    if (unlimitedRequested && !isAdmin) {
      return res.status(403).json({ message: '失败', error: '只有管理员可以设置不限额' });
    }
    if (!unlimitedRequested) {
      if (quota === '' || quota === undefined) {
        return res.status(400).json({ message: '失败', error: '配额不能为空，请填写数字' });
      }
      quota = Number(quota);
      if (Number.isNaN(quota) || quota < 0) {
        return res.status(400).json({ message: '失败', error: '配额必须是 ≥0 的数字' });
      }
    }
    const result = setAuthQuota(authorization, unlimitedRequested ? null : quota);
    if (!result.success) {
      return res.status(400).json({ message: '失败', error: result.error });
    }
    console.log(`[设置配额] ${authorization} -> ${result.quota == null ? '不限额' : `${result.quota}元`}`);
    return res.json({ message: '成功', data: { authorization, quota: result.quota, unlimited: result.quota == null } });
  } catch (e) {
    console.error(`设置配额失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

router.get('/check_auth', (req, res) => {
  try {
    const authorization = String(req.query.authorization || req.query.auth || '').trim();

    if (!authorization) {
      return res.status(400).json({
        message: '失败',
        error: '缺少authorization参数'
      });
    }

    const info = dataStore.authorizations[authorization];
    if (!info) {
      return res.json({
        message: '成功',
        exists: false,
        authorization
      });
    }

    return res.json({
      message: '成功',
      exists: true,
      data: {
        authorization,
        name: info.name,
        description: info.description,
        created_at: info.created_at,
        enabled: info.enabled,
        blocked: info.blocked || false,
        blocked_at: info.blocked_at || '',
        block_reason: info.block_reason || '',
        attack_count: (info.attack_records || []).length,
        balance: roundBalance(dataStore.usersBalance[authorization] || 0)
      }
    });
  } catch (e) {
    console.error(`查询authorization失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/toggle_auth', adminRequired, async (req, res) => {
  const { authorization, enabled } = req.body;

  if (!authorization || enabled === undefined) {
    return res.status(400).json({
      message: '失败',
      error: '缺少必要参数'
    });
  }

  if (!dataStore.authorizations[authorization]) {
    return res.status(404).json({
      message: '失败',
      error: 'authorization不存在'
    });
  }

  dataStore.authorizations[authorization].enabled = enabled;

  try {
    saveUser(authorization);
  } catch (e) {
    console.error(`保存数据失败: ${e.message}`);
  }

  return res.json({
    message: '成功',
    enabled
  });
});

// ==================== 屏蔽管理 ====================
router.post('/block_user', adminRequired, async (req, res) => {
  try {
    const { authorization, reason = '管理员手动屏蔽' } = req.body;

    if (!authorization) {
      return res.status(400).json({
        message: '失败',
        error: '缺少authorization参数'
      });
    }

    if (!dataStore.authorizations[authorization]) {
      return res.status(404).json({
        message: '失败',
        error: 'authorization不存在'
      });
    }

    dataStore.authorizations[authorization].blocked = true;
    dataStore.authorizations[authorization].blocked_at = nowStr();
    dataStore.authorizations[authorization].block_reason = reason;

    try {
      saveUser(authorization);
      console.log(`管理员手动屏蔽用户: ${authorization}, 原因: ${reason}`);
    } catch (e) {
      console.error(`保存屏蔽数据失败: ${e.message}`);
    }

    return res.json({
      message: '成功',
      authorization,
      blocked: true,
      reason
    });
  } catch (e) {
    console.error(`屏蔽用户失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/unblock_user', adminRequired, async (req, res) => {
  try {
    const { authorization } = req.body;

    if (!authorization) {
      return res.status(400).json({
        message: '失败',
        error: '缺少authorization参数'
      });
    }

    if (!dataStore.authorizations[authorization]) {
      return res.status(404).json({
        message: '失败',
        error: 'authorization不存在'
      });
    }

    dataStore.authorizations[authorization].blocked = false;
    dataStore.authorizations[authorization].unblocked_at = nowStr();
    dataStore.authorizations[authorization].attack_records = [];

    try {
      saveUser(authorization);
      console.log(`管理员解除屏蔽用户: ${authorization}`);
    } catch (e) {
      console.error(`保存解除屏蔽数据失败: ${e.message}`);
    }

    return res.json({
      message: '成功',
      authorization,
      blocked: false
    });
  } catch (e) {
    console.error(`解除屏蔽用户失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/list_blocked_users', adminRequired, (req, res) => {
  try {
    const blockedUsers = [];
    for (const [auth, info] of Object.entries(dataStore.authorizations)) {
      if (info.blocked) {
        blockedUsers.push({
          authorization: auth,
          name: info.name,
          description: info.description,
          blocked_at: info.blocked_at || '',
          block_reason: info.block_reason || '',
          attack_count: (info.attack_records || []).length,
          balance: dataStore.usersBalance[auth] || 0
        });
      }
    }

    return res.json({
      message: '成功',
      data: blockedUsers,
      count: blockedUsers.length
    });
  } catch (e) {
    console.error(`获取屏蔽用户列表失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/clear_attack_records', adminRequired, async (req, res) => {
  try {
    const { authorization } = req.body;

    if (!authorization) {
      return res.status(400).json({
        message: '失败',
        error: '缺少authorization参数'
      });
    }

    if (!dataStore.authorizations[authorization]) {
      return res.status(404).json({
        message: '失败',
        error: 'authorization不存在'
      });
    }

    const oldCount = (dataStore.authorizations[authorization].attack_records || []).length;
    dataStore.authorizations[authorization].attack_records = [];

    try {
      saveUser(authorization);
      console.log(`管理员清理用户攻击记录: ${authorization}, 清理数量: ${oldCount}`);
    } catch (e) {
      console.error(`保存清理记录失败: ${e.message}`);
    }

    return res.json({
      message: '成功',
      authorization,
      cleared_count: oldCount
    });
  } catch (e) {
    console.error(`清理攻击记录失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/get_attack_config', adminRequired, (req, res) => {
  return res.json({
    message: '成功',
    config: {
      // 机制一：余额不足攻击 → 封禁密钥
      attack_threshold: config.ATTACK_THRESHOLD,
      attack_window: config.ATTACK_WINDOW,
      description: `${config.ATTACK_WINDOW}秒内余额不足攻击${config.ATTACK_THRESHOLD}次将被自动屏蔽`,
      // 机制二：客户端错误(非法参数) → 封禁密钥 + 拉黑来源IP（下沉防火墙DROP）
      key_ban_threshold: config.KEY_AUTO_BAN_THRESHOLD,
      key_ban_window: config.KEY_AUTO_BAN_WINDOW,
      key_ban_description: `${config.KEY_AUTO_BAN_WINDOW}秒内客户端错误(非法参数)${config.KEY_AUTO_BAN_THRESHOLD}次将被自动封禁密钥，并拉黑来源IP`
    }
  });
});

// 读取单密钥 QPS 限流阈值（运行时可调）
router.get('/get_rate_limit', adminRequired, (req, res) => {
  const qps = getRateLimitQps();
  return res.json({
    message: '成功',
    config: {
      key_rate_limit_qps: qps,
      enabled: qps > 0,
      description: qps > 0
        ? `单个密钥每秒最多 ${qps} 次请求，超出直接 429（不转发上游、不扣费、不写库）`
        : '限流已关闭（0）：单个密钥不限速，注意被异常重试打满风险'
    }
  });
});

// 设置单密钥 QPS 限流阈值。body: { qps }。0=关闭限流；必须 >=0 整数。立即生效并落库。
router.post('/set_rate_limit', adminRequired, (req, res) => {
  try {
    const { qps } = req.body;
    if (qps === '' || qps === null || qps === undefined) {
      return res.status(400).json({ message: '失败', error: 'QPS 不能为空（0 表示关闭限流）' });
    }
    const applied = setRateLimitQps(qps);
    console.warn(`[系统设置] 单密钥 QPS 限流改为 ${applied}`);
    return res.json({ message: '成功', data: { key_rate_limit_qps: applied } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// ==================== 接口最小调用间隔限流（三级：global / user / auth）====================
// 查询某 scope 的全部频率配置。?scope=global|user|auth&scope_id=...
// 返回 { endpoint: interval_seconds }，未配置的接口不出现。
router.get('/get_throttles', adminRequired, (req, res) => {
  try {
    const { scope, scope_id } = req.query;
    return res.json({ message: '成功', data: getThrottleRules(scope, scope_id) });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// 设置某 scope 某接口的最小调用间隔（秒）。interval=0 取消该限制。立即生效并落库。
// body: { scope:'global'|'user'|'auth', scope_id, endpoint, interval_seconds }
router.post('/set_throttle', adminRequired, (req, res) => {
  try {
    const { scope, scope_id, endpoint, interval_seconds } = req.body;
    const applied = setThrottleRule(scope, scope_id, endpoint, interval_seconds);
    console.warn(`[频率设置] ${scope}:${String(scope_id || '全局').slice(0, 10)}… 接口 ${endpoint} 最小间隔 ${applied}s`);
    return res.json({ message: '成功', data: { scope, scope_id: scope === 'global' ? '' : scope_id, endpoint, interval_seconds: applied } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// ==================== 接口默认价格（创建密钥/用户时的初始价）====================
// 读取默认价列表统一走公开接口 GET /api/prices（文档页/后台共用），此处只保留写入。
// 设置某接口默认价。body: { endpoint, price }。立即生效并落库，影响之后新建的密钥/用户与计费兜底。
router.post('/set_default_price', adminRequired, (req, res) => {
  try {
    const { endpoint, price } = req.body;
    const applied = setDefaultPrice(endpoint, price);
    console.warn(`[系统设置] 接口 ${endpoint} 默认价改为 ${applied} 元`);
    return res.json({ message: '成功', data: { endpoint, price: applied } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// ==================== 接口状态（健康 / 风控，文档页对客户展示）====================
// 读取全部接口状态：{ endpoint: 'healthy' | 'risk' }
router.get('/get_endpoint_status', adminRequired, (req, res) => {
  try {
    return res.json({ message: '成功', data: getAllEndpointStatuses() });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 设置某接口状态。body: { endpoint, status:'healthy'|'risk' }。立即生效并落库。
router.post('/set_endpoint_status', adminRequired, (req, res) => {
  try {
    const { endpoint, status } = req.body;
    const applied = setEndpointStatus(endpoint, status);
    console.warn(`[系统设置] 接口 ${endpoint} 状态改为 ${applied === 'risk' ? '风控' : '健康'}`);
    return res.json({ message: '成功', data: { endpoint, status: applied } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// 上游接口成本表（按"上游原始接口"粒度，所有成本记账以此表为准）。单位：元 / 成功调用。
router.get('/get_upstream_api_costs', adminRequired, (req, res) => {
  try {
    const items = getAllUpstreamApiCosts().map(i => ({
      ...i,
      upstream_name: UPSTREAM_DISPLAY_NAMES[i.upstream] || i.upstream
    }));
    return res.json({ message: '成功', data: { items, default_unit_cost: getFallbackUpstreamUnitCost() } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// unit_cost 传空（null/''）= 清除覆盖、恢复默认值
router.post('/set_upstream_api_cost', adminRequired, (req, res) => {
  try {
    const { upstream, api, unit_cost } = req.body;
    const applied = setUpstreamApiCost(upstream, api, unit_cost);
    console.warn(`[系统设置] 上游接口 ${upstream} ${api} 成本单价改为 ${applied} 元/成功调用`);
    return res.json({ message: '成功', data: { upstream, api, unit_cost: applied } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

// ==================== IP黑名单 ====================
router.post('/block_ip', adminRequired, async (req, res) => {
  try {
    const { ip, reason = '管理员手动封禁' } = req.body;

    if (!ip) {
      return res.status(400).json({
        message: '失败',
        error: '缺少ip参数'
      });
    }

    dataStore.ipBlacklist[ip] = {
      blocked: true,
      blocked_at: nowStr(),
      reason
    };

    if (saveSingleIpBlacklist(ip)) {
      firewallBlockIp(ip).catch(() => {}); // 同步下沉到内核 ipset
      console.log(`管理员封禁IP: ${ip}, 原因: ${reason}`);
      return res.json({
        message: '成功',
        ip,
        blocked: true,
        reason
      });
    } else {
      return res.status(500).json({
        message: '失败',
        error: '保存数据失败'
      });
    }
  } catch (e) {
    console.error(`封禁IP失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.post('/unblock_ip', adminRequired, async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({
        message: '失败',
        error: '缺少ip参数'
      });
    }

    if (!dataStore.ipBlacklist[ip]) {
      return res.status(404).json({
        message: '失败',
        error: 'IP不在黑名单中'
      });
    }

    dataStore.ipBlacklist[ip].blocked = false;
    dataStore.ipBlacklist[ip].unblocked_at = nowStr();

    if (saveSingleIpBlacklist(ip)) {
      firewallUnblockIp(ip).catch(() => {}); // 同步从内核 ipset 移除
      console.log(`管理员解封IP: ${ip}`);
      return res.json({
        message: '成功',
        ip,
        blocked: false
      });
    } else {
      return res.status(500).json({
        message: '失败',
        error: '保存数据失败'
      });
    }
  } catch (e) {
    console.error(`解封IP失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/list_blocked_ips', adminRequired, (req, res) => {
  try {
    const blockedIps = [];
    for (const [ip, info] of Object.entries(dataStore.ipBlacklist)) {
      if (info.blocked) {
        blockedIps.push({
          ip,
          blocked_at: info.blocked_at || '',
          reason: info.reason || ''
        });
      }
    }

    return res.json({
      message: '成功',
      data: blockedIps,
      count: blockedIps.length
    });
  } catch (e) {
    console.error(`获取封禁IP列表失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// ==================== 统计接口 ====================
// 真实用户维度：按 users.user_id 聚合该用户拥有的全部 API Key；与下方按 authorization 的密钥统计分开。
router.get('/get_user_usage_statistics', adminRequired, (req, res) => {
  try {
    flushUsageStatistics();
    const users = listUserUsageSummary(db);
    return res.json({ message: '成功', data: { total_users: users.length, users } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

router.get('/get_usage_statistics', adminRequired, async (req, res) => {
  try {
    const { authorization } = req.query;

    const currentUsageData = getUsageStatisticsFromDB(authorization || null);

    if (authorization) {
      if (currentUsageData) {
        const userStats = currentUsageData;

        return res.json({
          message: '成功',
          data: {
            authorization,
            total_stats: {
              total_calls: userStats.total_calls || 0,
              total_amount: roundBalance(userStats.total_amount || 0),
              total_cost: roundBalance(userStats.total_cost || 0),
              total_profit: roundBalance(userStats.total_profit || 0),
              first_call: userStats.first_call || '',
              last_call: userStats.last_call || '',
              endpoints: userStats.endpoints || {}
            },
            daily_stats: userStats.daily_stats || {},
            has_daily_stats: Object.keys(userStats.daily_stats || {}).length > 0
          }
        });
      } else {
        return res.status(404).json({
          message: '失败',
          error: '未找到该用户的统计数据'
        });
      }
    } else {
      const summary = [];
      for (const [auth, stats] of Object.entries(currentUsageData)) {
        const userName = (dataStore.authorizations[auth] || {}).name || '未知用户';
        summary.push({
          authorization: auth,
          name: userName,
          total_calls: stats.total_calls || 0,
          total_amount: roundBalance(stats.total_amount || 0),
          total_cost: roundBalance(stats.total_cost || 0),
          total_profit: roundBalance(stats.total_profit || 0),
          first_call: stats.first_call || '',
          last_call: stats.last_call || '',
          endpoints_count: Object.keys(stats.endpoints || {}).length,
          daily_count: Object.keys(stats.daily_stats || {}).length
        });
      }

      summary.sort((a, b) => b.total_calls - a.total_calls);

      return res.json({
        message: '成功',
        data: {
          total_users: summary.length,
          users: summary
        }
      });
    }
  } catch (e) {
    console.error(`获取使用统计失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 接口统计（支持日期范围）
router.get('/get_endpoint_statistics', adminRequired, (req, res) => {
  try {
    flushUsageStatistics();
    const { start_date, end_date } = req.query;

    // 读预聚合的 usage_statistics 汇总表（grain: 密钥+日期+接口），不再扫 call_logs 大表（71万行→2.2s）。
    // date 列是 'YYYY-MM-DD'；上界天然排除特殊累计行 date='TOTAL'；endpoint!='ALL' 排除每日全接口汇总行。
    const startDate = start_date || '2020-01-01';
    const endDate = end_date || '2099-12-31';
      const sql = `SELECT endpoint,
        SUM(calls) as total_calls, SUM(success_calls) as success_calls,
        SUM(failed_calls) as failed_calls, SUM(amount) as total_amount,
        SUM(cost) as total_cost,
        COUNT(DISTINCT authorization) as unique_users
        FROM usage_statistics
        WHERE date >= ? AND date <= ? AND endpoint != 'ALL'
        GROUP BY endpoint ORDER BY total_calls DESC`;
    const rows = db.prepare(sql).all(startDate, endDate);
    const endpoints = rows.map(r => ({
      endpoint: r.endpoint,
      total_calls: r.total_calls,
      total_amount: roundBalance(r.total_amount || 0),
      total_cost: roundBalance(r.total_cost || 0),
      total_profit: roundBalance((r.total_amount || 0) - (r.total_cost || 0)),
      success_calls: r.success_calls || 0,
      failed_calls: r.failed_calls || 0,
      success_rate: r.total_calls > 0 ? Math.round((r.success_calls / r.total_calls) * 10000) / 100 : 0,
      unique_users: r.unique_users,
      default_price: getDefaultPrice(r.endpoint) || 0
    }));

    return res.json({
      message: '成功',
      data: { total_endpoints: endpoints.length, endpoints, start_date: start_date || null, end_date: end_date || null }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 用户地区分布（仪表盘地图用）：每个 authorization 取调用次数最多的IP作为"代表IP"解析地区，
// 不看调用量——是"这个用户大概在哪"，不是"这个省份被调用了多少次"。
// 按用户去重后IP数量级远小于全部历史IP，直接同步 await 并发解析完再返回，一次请求就能拿到完整
// 结果（不像之前按调用量聚合那版IP基数太大只能每次限流解析一批、要多刷新几次才能补全）。
router.get('/get_user_region_distribution', adminRequired, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const startTs = (start_date || '2020-01-01') + ' 00:00:00';
    const endTs = (end_date || '2099-12-31') + ' 23:59:59';
    const rows = db.prepare(`
      SELECT authorization, client_ip, COUNT(*) as cnt
      FROM call_logs
      WHERE timestamp >= ? AND timestamp <= ? AND authorization IS NOT NULL
        AND client_ip IS NOT NULL AND client_ip != ''
      GROUP BY authorization, client_ip
    `).all(startTs, endTs);

    // 每个 authorization 取出现次数最多的IP作为代表
    const bestIpByAuth = new Map();
    for (const r of rows) {
      const cur = bestIpByAuth.get(r.authorization);
      if (!cur || r.cnt > cur.cnt) bestIpByAuth.set(r.authorization, { ip: r.client_ip, cnt: r.cnt });
    }

    const nameStmt = db.prepare('SELECT name FROM users WHERE authorization = ?');
    const locStmt = db.prepare('SELECT province, city, status FROM ip_location_cache WHERE ip = ?');

    // 并发解析所有还没缓存过的代表IP，等它们全部完成再拼结果
    const toResolve = [];
    for (const { ip } of bestIpByAuth.values()) {
      if (isPrivateIp(ip)) continue;
      if (!locStmt.get(ip)) toResolve.push(ip);
    }
    if (toResolve.length) await resolveIpLocationsBatch(toResolve, 10);

    const items = [...bestIpByAuth.entries()].map(([authorization, { ip }]) => {
      const nameRow = nameStmt.get(authorization);
      let province = '未知', city = '';
      if (isPrivateIp(ip)) {
        province = '内网/本机';
      } else {
        const loc = locStmt.get(ip);
        if (loc && loc.status === 'ok' && loc.province) { province = loc.province; city = loc.city || ''; }
      }
      return { authorization, name: (nameRow && nameRow.name) || authorization, ip, province, city };
    });

    return res.json({
      message: '成功',
      data: { items, start_date: start_date || null, end_date: end_date || null }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

router.post('/clear_usage_statistics', adminRequired, async (req, res) => {
  try {
    flushUsageStatistics();
    const { authorization, confirm = false } = req.body;

    if (!confirm) {
      return res.status(400).json({
        message: '失败',
        error: '请确认操作，设置confirm=true'
      });
    }

    if (authorization) {
      const check = db.prepare('SELECT COUNT(*) AS cnt FROM usage_statistics WHERE authorization = ?').get(authorization);
      if (!check || check.cnt === 0) {
        return res.status(404).json({
          message: '失败',
          error: '用户统计数据不存在'
        });
      }
      db.prepare('DELETE FROM usage_statistics WHERE authorization = ?').run(authorization);
      delete dataStore.usageStatistics[authorization];
      console.log(`管理员清空用户 ${authorization} 的使用统计`);
      return res.json({
        message: '成功',
        cleared_user: authorization
      });
    } else {
      db.prepare('DELETE FROM usage_statistics').run();
      Object.keys(dataStore.usageStatistics).forEach(key => {
        delete dataStore.usageStatistics[key];
      });
      console.warn('管理员清空了所有使用统计数据');
      return res.json({
        message: '成功',
        cleared: '所有统计数据'
      });
    }
  } catch (e) {
    console.error(`清空使用统计失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// ==================== 调用日志 ====================
router.get('/export_call_logs', adminRequired, async (req, res) => {
  try {
    const { authorization, start_date, end_date, sort_by_time = 'false', download = '' } = req.query;

    const sortByTime = sort_by_time.toLowerCase() === 'true';
    // 预览条数上限：避免几十万条一次性塞进前端把浏览器卡死；下载文件时不限。
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 1000;
    const dl = String(download).toLowerCase();

    const result = await exportCallLogs(authorization, start_date, end_date, sortByTime);

    if (!result.success) {
      return res.status(500).json({ message: '失败', error: result.error || '未知错误' });
    }

    console.log(`管理员导出调用日志: 用户=${authorization || '全部'}, 日期范围=${start_date || '不限'}~${end_date || '不限'}, 记录数=${result.count}, 方式=${dl || '预览'}`);

    // ---- 完整文件下载（不进前端 state，直接作为附件流给浏览器）----
    if (dl === 'csv' || dl === 'json') {
      const fname = `call_logs_${(start_date || 'all')}_${(end_date || 'all')}_${Date.now()}`;
      if (dl === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}.json"`);
        return res.send(JSON.stringify(result.records, null, 2));
      }
      // CSV
      const headers = ['时间', '密钥备注', '所属账户', '密钥', '接口', '状态', '失败原因', '扣费', '成本', '上游', '切换明细', 'IP', 'UA', '请求参数'];
      const esc = (c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`;
      let csv = '﻿' + headers.join(',') + '\n';
      for (const r of result.records) {
        csv += [r.timestamp, r.user_name, r.username || '', r.authorization, r.endpoint, r.success ? '成功' : '失败',
          r.error_message, r.amount, r.cost ?? 0, r.upstream || '', r.upstream_attempts || '', r.client_ip, r.user_agent, r.request_params].map(esc).join(',') + '\n';
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
      return res.send(csv);
    }

    // ---- 聚合统计（按全量数据，而非预览子集，保证统计准确）----
    const statMap = {};
    let totalCost = 0, successCount = 0;
    for (const r of result.records) {
      const ep = r.endpoint || '未知';
      if (!statMap[ep]) statMap[ep] = { endpoint: ep, count: 0, success: 0, cost: 0 };
      statMap[ep].count++;
      if (r.success) { statMap[ep].success++; successCount++; }
      const c = parseFloat(r.amount) || 0;
      statMap[ep].cost += c; totalCost += c;
    }
    const stats = {
      total: result.count,
      success: successCount,
      cost: Math.round(totalCost * 100) / 100,
      endpoints: Object.values(statMap).sort((a, b) => b.count - a.count)
        .map(s => ({ ...s, cost: Math.round(s.cost * 100) / 100 }))
    };

    // ---- 预览：只返回前 limit 条，附带总数与全量统计 ----
    const records = result.records.slice(0, limit);
    return res.json({
      message: '成功',
      data: {
        records,
        count: records.length,
        total: result.count,
        truncated: result.count > records.length,
        stats,
        start_date: result.start_date,
        end_date: result.end_date,
        sorted: result.sorted
      }
    });
  } catch (e) {
    console.error(`导出调用日志失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 调用记录查询（只取最新一页，按 id 倒序走主键，极快；不做全表 COUNT）
router.get('/get_call_logs', adminRequired, (req, res) => {
  try {
    flushCallLogs();
    const { authorization = '', endpoint = '', status = '' } = req.query;

    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(200, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);

    const where = [];
    const args = [];
    if (authorization) { where.push('authorization = ?'); args.push(authorization); }
    if (endpoint) { where.push('endpoint = ?'); args.push(endpoint); }
    if (status === 'success') { where.push('success = 1'); }
    else if (status === 'failed') { where.push('success = 0'); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.prepare(
      `SELECT id, authorization, timestamp, endpoint, success, amount, client_ip, user_agent, request_params, error_message, cost, upstream, upstream_attempts
       FROM call_logs ${whereSql} ORDER BY id DESC LIMIT ?`
    ).all(...args, limit);

    const records = rows.map(r => {
      const info = dataStore.authorizations[r.authorization];
      const userId = info ? (info.user_id || null) : null;
      const ua = userId ? dataStore.userAccounts[userId] : null;
      let attempts = null;
      if (r.upstream_attempts) { try { attempts = JSON.parse(r.upstream_attempts); } catch (_) {} }
      return {
        id: r.id,
        timestamp: r.timestamp,
        endpoint: r.endpoint,
        success: r.success === 1,
        amount: r.amount,
        cost: r.cost || 0,
        upstream: r.upstream || '',
        upstream_attempts: attempts,
        client_ip: r.client_ip,
        user_agent: r.user_agent,
        request_params: r.request_params,
        error_message: r.error_message,
        authorization: r.authorization,
        // user_name 是密钥自己的备注名（可能是"评论采集"这种按用途起的名字，不代表真人）；
        // username 是这个密钥绑定的真实账户用户名，管理员想知道"这把钥匙到底是谁的"看这个字段。
        user_name: info ? (info.name || '') : '',
        user_id: userId,
        username: ua ? ua.username : null
      };
    });

    return res.json({ message: '成功', data: { records, count: records.length, limit } });
  } catch (e) {
    console.error(`查询调用记录失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 删除指定用户的所有调用日志
router.delete('/delete_user_call_logs', adminRequired, async (req, res) => {
  try {
    const { authorization } = req.query;
    if (!authorization) {
      return res.status(400).json({ message: '失败', error: '请指定用户 authorization' });
    }

    // 验证用户存在
    const userInfo = dataStore.authorizations[authorization];
    const userName = userInfo ? userInfo.name : authorization.substring(0, 8);

    const result = await deleteUserCallLogs(authorization);

    if (result.success) {
      console.log(`管理员删除用户调用日志: ${userName}, ${result.message}`);
      return res.json({ message: '成功', data: { user_name: userName, ...result } });
    } else {
      return res.status(500).json({ message: '失败', error: result.message });
    }
  } catch (e) {
    console.error(`删除用户调用日志失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 调用日志摘要 (SQL)
router.get('/get_call_logs_summary', adminRequired, (req, res) => {
  try {
    flushCallLogs();
    const { authorization } = req.query;

    let sql = `SELECT authorization, COUNT(*) AS cnt,
      MIN(timestamp) AS earliest, MAX(timestamp) AS latest
      FROM call_logs`;
    const params = [];
    if (authorization) { sql += ' WHERE authorization = ?'; params.push(authorization); }
    sql += ' GROUP BY authorization';

    const rows = db.prepare(sql).all(...params);

    const totalRow = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT authorization) AS users,
      MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM call_logs`).get();

    return res.json({
      message: '成功',
      data: {
        total_users: totalRow.users,
        total_records: totalRow.total,
        date_range: { earliest: totalRow.earliest, latest: totalRow.latest },
        users: rows.map(r => ({
          user_hash: getUserDirName(r.authorization),
          record_count: r.cnt,
          earliest_date: r.earliest ? r.earliest.substring(0, 10) : null,
          latest_date: r.latest ? r.latest.substring(0, 10) : null
        }))
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// ==================== 上游API测试 ====================
router.post('/test_upstream_api', adminRequired, async (req, res) => {
  try {
    const { api_type, params = {} } = req.body;

    if (!api_type) {
      return res.status(400).json({
        message: '失败',
        error: '缺少api_type参数'
      });
    }

    // api_type 就是「上游接口成本」表的 key（upstream|原生接口），两处永远对应同一份注册表全集
    const sepIdx = api_type.indexOf('|');
    const entry = sepIdx > 0 ? getUpstreamApiRegistryEntry(api_type.slice(0, sepIdx), api_type.slice(sepIdx + 1)) : null;
    if (!entry) {
      return res.status(400).json({
        message: '失败',
        error: `未知的API类型: ${api_type}`
      });
    }

    const sample = entry.sample || {};
    const apiName = [...entry.usedBy.values()][0] || entry.api;
    const upstream = config.UPSTREAMS[entry.upstream] || config.UPSTREAMS[Object.keys(config.UPSTREAMS)[0]];
    const filtered = {};
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') filtered[k] = v;
    const mapped = typeof sample.mapParams === 'function' ? sample.mapParams(filtered) : filtered;
    const startTime = Date.now();
    try {
      let response;
      if (entry.upstream === 'matcha') {
        response = await axios.post(`${upstream.baseURL}/v1/call`,
          { api_id: sample.apiId, params: mapped },
          { headers: { 'Authorization': `Bearer ${upstream.authorization}`, 'Content-Type': 'application/json' }, timeout: config.REQUEST_TIMEOUT });
      } else if (entry.upstream === 'datadrifter') {
        // datadrifter：POST JSON + X-API-KEY 认证，超时用上游独立配置（接口偶有 10s+ 响应）
        response = await axios.post(`${upstream.baseURL}${sample.path}`, mapped,
          { headers: { 'X-API-KEY': upstream.authorization, 'Content-Type': 'application/json' }, timeout: upstream.timeoutMs || config.REQUEST_TIMEOUT });
      } else if (entry.upstream === 'swagger') {
        // swagger：GET + X-API-Key 头认证（不带Bearer前缀），跟 sendV6Request 保持一致
        const url = /^https?:\/\//i.test(sample.path || '') ? sample.path : `${upstream.baseURL}${sample.path}`;
        response = await axios.get(url, { params: mapped, headers: { 'X-API-Key': upstream.authorization }, timeout: upstream.timeoutMs || config.REQUEST_TIMEOUT });
      } else {
        const url = /^https?:\/\//i.test(sample.path || '') ? sample.path : `${upstream.baseURL}${sample.path}`;
        // TikHub 需 Bearer 前缀；星河用原始 Authorization。与 userApi 各适配器保持一致。
        const authValue = entry.upstream === 'tikhub' ? `Bearer ${upstream.authorization}` : upstream.authorization;
        const headers = { 'Authorization': authValue };
        response = (sample.method || 'GET').toUpperCase() === 'POST'
          ? await axios.post(url, mapped, { headers, timeout: config.REQUEST_TIMEOUT })
          : await axios.get(url, { params: mapped, headers, timeout: config.REQUEST_TIMEOUT });
      }
      const elapsedTime = Date.now() - startTime;
      console.log(`上游API测试: ${api_type}, 状态码: ${response.status}, 耗时: ${elapsedTime}ms`);
      return res.json({
        message: '成功',
        data: { api_type, api_name: apiName, request_url: response.config.url, status_code: response.status, elapsed_time_ms: elapsedTime, response: response.data }
      });
    } catch (e) {
      const elapsedTime = Date.now() - startTime;
      if (e.code === 'ECONNABORTED') return res.status(504).json({ message: '失败', error: '请求超时', data: { api_type, api_name: apiName, elapsed_time_ms: elapsedTime } });
      return res.status(500).json({ message: '失败', error: `请求失败: ${e.message}`, data: { api_type, api_name: apiName, elapsed_time_ms: elapsedTime } });
    }
  } catch (e) {
    console.error(`测试上游API失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// 与「上游接口成本」同一份 (upstream, 原生接口) 全集（settings.getUpstreamApiTestList），
// 一个物理接口只出现一行，不再按"对外接口/候选链候选"重复罗列，两个页面永远对得上。
router.get('/get_upstream_api_list', adminRequired, (req, res) => {
  try {
    const apiList = getUpstreamApiTestList().map(e => {
      const upstream = config.UPSTREAMS[e.upstream] || config.UPSTREAMS[Object.keys(config.UPSTREAMS)[0]];
      const fullUrlPath = /^https?:\/\//i.test(e.path || '');
      // 同一客户端接口名可能对应上游多个不同变体（如一级评论：排序版/无排序版/V2），光看 name 分不清是哪个，
      // 附上原生接口标识（vendor path 末段，或 Matcha 的 api_id）辅助辨认
      const variantHint = e.apiId ? `api_id=${e.apiId}` : (e.path || '').split('/').filter(Boolean).pop();
      const baseName = e.used_by.length > 1 ? `${e.name}（等${e.used_by.length}个接口复用）` : e.name;
      return {
        type: `${e.upstream}|${e.api}`,
        name: variantHint ? `${baseName} · ${variantHint}` : baseName,
        url: e.upstream === 'matcha' ? '/v1/call' : (e.path || ''),
        method: e.upstream === 'matcha' ? 'POST' : e.method,
        params: e.params,
        paramExamples: e.paramExamples,
        baseURL: fullUrlPath ? '' : upstream.baseURL,
        authorization: upstream.authorization,
        upstream: e.upstream,
        api_id: e.apiId,
        used_by: e.used_by
      };
    });

    return res.json({
      message: '成功',
      data: {
        upstreams: Object.fromEntries(Object.entries(config.UPSTREAMS).map(([k, v]) => [k, v.baseURL])),
        apis: apiList
      }
    });
  } catch (e) {
    console.error(`获取上游API列表失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// ==================== 数据API连通性测试 ====================
// 已知可用的探活参数（取自历史成功调用，上游参数命名）。仅探活：不计费、不写库、不影响余额。
const CONNECTIVITY_SAMPLES = {
  note:                     { noteId: '6a1f9a650000000007026c3a' },
  video_note:               { noteId: '68663c5e000000000d027a20' },
  comment:                  { noteId: '6a102fb0000000000803c2ec', sortStrategy: '2' },
  sub_comments:             { noteId: '6a0c1721000000000603085d', commentId: '6a1429520000000027028175' },
  app_search:               { keyword: '咖啡', page: '1' },
  app_user_info:            { userId: '5659223450c4b4595d6c312c' },
  app_user_posted:          { userId: '5659223450c4b4595d6c312c' },
  tag_notes:                { pageId: '5c014b045b29cb0001ead530', sort: 'hot', first_load_time: '1780646337077' }
};

router.get('/test_connectivity', adminRequired, async (req, res) => {
  const TIMEOUT_MS = 20000; // 单接口 20 秒超时
  const types = Object.keys(CONNECTIVITY_SAMPLES).filter(t => config.UPSTREAM_API_CONFIGS[t]);

  const runOne = async (apiType) => {
    const apiConfig = config.UPSTREAM_API_CONFIGS[apiType];
    const upstreamKey = apiConfig.upstream || 'xingyin';
    const upstream = config.UPSTREAMS[upstreamKey] || config.UPSTREAMS[Object.keys(config.UPSTREAMS)[0]];
    const url = `${upstream.baseURL}${apiConfig.url}`;
    const headers = { 'Authorization': upstream.authorization };
    const params = CONNECTIVITY_SAMPLES[apiType];
    const started = Date.now();
    try {
      if (apiConfig.method === 'GET') {
        await axios.get(url, { params, headers, timeout: TIMEOUT_MS });
      } else {
        await axios.post(url, params, { headers, timeout: TIMEOUT_MS });
      }
      // 拿到 HTTP 2xx 即视为接口可达，记录响应时间
      return { type: apiType, name: apiConfig.name, status: 'successful', response_time_ms: Date.now() - started, error: null };
    } catch (e) {
      // 超时（>5s 或连接中断）
      if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
        return { type: apiType, name: apiConfig.name, status: 'timeout', response_time_ms: null, error: `超过 ${TIMEOUT_MS / 1000} 秒未响应` };
      }
      // 其它失败（连接被拒/DNS/上游返回 4xx/5xx）。能拿到 e.response 说明链路其实是通的，标出 HTTP 码。
      const httpStatus = e.response && e.response.status;
      return { type: apiType, name: apiConfig.name, status: 'error', response_time_ms: Date.now() - started, error: httpStatus ? `HTTP ${httpStatus}` : (e.code || e.message) };
    }
  };

  try {
    const results = await Promise.all(types.map(runOne));
    const summary = {
      total: results.length,
      successful: results.filter(r => r.status === 'successful').length,
      error: results.filter(r => r.status === 'error').length,
      timeout: results.filter(r => r.status === 'timeout').length
    };
    return res.json({ message: '成功', data: { timeout_ms: TIMEOUT_MS, tested_at: nowStr(true), summary, results } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// ============ 下游接口（本平台对外 /api/*）连通性测试 ============
// 走完整链路（鉴权→计费→转发上游），用指定测试密钥，成功会真实扣费。参数为下游命名(note_id等)。
const DOWNSTREAM_SAMPLES = {
  get_note_detail:          { name: '获取笔记详情',   method: 'GET',  params: { note_id: '6a1f9a650000000007026c3a' } },
  get_note_detail_video:    { name: '获取视频笔记详情', method: 'GET',  params: { note_id: '6a0ae55400000000350212e6' } },
  get_note_comment:         { name: '获取笔记评论',   method: 'GET',  params: { note_id: '6a102fb0000000000803c2ec', sortStrategy: '2' } },
  get_note_sub_comment:     { name: '获取子评论',     method: 'GET',  params: { note_id: '6a0c1721000000000603085d', comment_id: '6a1429520000000027028175' } },
  search_note:              { name: '搜索笔记',       method: 'GET',  params: { keyword: '咖啡', page: '1' } },
  get_user_info:            { name: '获取用户信息',   method: 'GET',  params: { user_id: '5659223450c4b4595d6c312c' } },
  user_note_list:           { name: '获取用户笔记列表', method: 'GET',  params: { user_id: '5659223450c4b4595d6c312c' } },
  tag_notes:                { name: '获取话题标签笔记', method: 'GET',  params: { pageId: '5c014b045b29cb0001ead530', first_load_time: '1780646337077', sort: 'hot' } }
};

function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? k : `${k.slice(0, 8)}…${k.slice(-4)}`;
}

router.get('/get_downstream_test_key', adminRequired, (req, res) => {
  const key = getDownstreamTestKey();
  return res.json({ message: '成功', data: { configured: !!key, masked: maskKey(key) } });
});

router.post('/set_downstream_test_key', adminRequired, (req, res) => {
  try {
    const { key } = req.body;
    const v = setDownstreamTestKey(key);
    console.warn(`[系统设置] 下游测试密钥已更新为 ${maskKey(v) || '(空)'}`);
    return res.json({ message: '成功', data: { configured: !!v, masked: maskKey(v) } });
  } catch (e) {
    return res.status(400).json({ message: '失败', error: e.message });
  }
});

router.get('/test_connectivity_downstream', adminRequired, async (req, res) => {
  const TIMEOUT_MS = 20000;
  const key = (req.query.key && String(req.query.key).trim()) || getDownstreamTestKey();
  if (!key) {
    return res.status(400).json({ message: '失败', error: '未配置下游测试密钥，请先在连通性测试页设置' });
  }
  const base = `http://127.0.0.1:${config.SERVICE_PORT}`;
  const types = Object.keys(DOWNSTREAM_SAMPLES);

  const runOne = async (endpoint) => {
    const { name, method, params } = DOWNSTREAM_SAMPLES[endpoint];
    const url = `${base}/api/${endpoint}`;
    const headers = { 'Authorization': key };
    const started = Date.now();
    try {
      if (method === 'GET') {
        await axios.get(url, { params, headers, timeout: TIMEOUT_MS });
      } else {
        await axios.post(url, params, { headers, timeout: TIMEOUT_MS });
      }
      return { type: endpoint, name, status: 'successful', response_time_ms: Date.now() - started, error: null };
    } catch (e) {
      if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
        return { type: endpoint, name, status: 'timeout', response_time_ms: null, error: `超过 ${TIMEOUT_MS / 1000} 秒未响应` };
      }
      const httpStatus = e.response && e.response.status;
      // 下游返回的业务错误信息（余额不足/参数错误/上游失败等）
      const bizErr = e.response && e.response.data && (e.response.data.error || e.response.data.message);
      return { type: endpoint, name, status: 'error', response_time_ms: Date.now() - started, error: httpStatus ? `HTTP ${httpStatus}${bizErr ? ' · ' + bizErr : ''}` : (e.code || e.message) };
    }
  };

  try {
    const results = await Promise.all(types.map(runOne));
    const summary = {
      total: results.length,
      successful: results.filter(r => r.status === 'successful').length,
      error: results.filter(r => r.status === 'error').length,
      timeout: results.filter(r => r.status === 'timeout').length
    };
    return res.json({ message: '成功', data: { timeout_ms: TIMEOUT_MS, tested_at: nowStr(true), test_key: maskKey(key), summary, results } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// ==================== 实时日志 ====================
function addLog(level, message, module = 'server') {
  const logEntry = {
    timestamp: nowStr(true),
    level,
    logger: module,
    message,
    module,
    funcName: '',
    lineno: 0
  };

  logEntry._seq = ++logBufferSeq;
  logBuffer.push(logEntry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }
}

// 覆盖console方法以捕获日志
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
  addLog('INFO', args.join(' '));
  originalConsoleLog.apply(console, args);
};

console.warn = function(...args) {
  addLog('WARNING', args.join(' '));
  originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
  addLog('ERROR', args.join(' '));
  originalConsoleError.apply(console, args);
};

router.get('/get_realtime_logs', adminRequired, (req, res) => {
  try {
    let limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const levelFilter = (req.query.level || '').toUpperCase();
    const sinceTimestamp = req.query.since_timestamp || '';

    let logs = [...logBuffer];

    if (levelFilter) {
      logs = logs.filter(log => log.level === levelFilter);
    }

    if (sinceTimestamp) {
      logs = logs.filter(log => log.timestamp > sinceTimestamp);
    }

    logs = logs.slice(-limit);

    return res.json({
      message: '成功',
      data: {
        logs,
        count: logs.length,
        total_in_buffer: logBuffer.length,
        server_time: nowStr()
      }
    });
  } catch (e) {
    console.error(`获取实时日志失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

router.get('/stream_logs', adminRequired, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let lastSeq = logBufferSeq;

  const interval = setInterval(() => {
    if (logBufferSeq <= lastSeq) return;
    const newLogs = logBuffer.filter(l => l._seq > lastSeq);
    for (const log of newLogs) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
    lastSeq = logBufferSeq;
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
  });
});

router.post('/clear_log_buffer', adminRequired, (req, res) => {
  try {
    logBuffer.length = 0;
    console.log('管理员清空了日志缓冲区');
    return res.json({ message: '成功' });
  } catch (e) {
    console.error(`清空日志缓冲区失败: ${e.message}`);
    return res.status(500).json({
      message: '失败',
      error: e.message
    });
  }
});

// ==================== 图表统计 ====================
// 获取某天的小时级调用统计
// 获取小时级统计 (SQL)
// 图表接口短时缓存：这些要扫 call_logs 大表，缓存 20 秒，避免每次刷新/切换都阻塞事件循环（圆环图卡顿主因）
const _chartCache = new Map();
function getChartCache(key) {
  const c = _chartCache.get(key);
  return (c && Date.now() - c.at < 20000) ? c.data : null;
}
function setChartCache(key, data) {
  if (_chartCache.size > 200) _chartCache.clear();
  _chartCache.set(key, { data, at: Date.now() });
  return data;
}

function dayRange(dateStr) {
  return {
    start: `${dateStr} 00:00:00`,
    end: `${dateStr} 23:59:59.999`
  };
}

router.get('/get_hourly_statistics', adminRequired, (req, res) => {
  try {
    const { date, endpoint } = req.query;
    const targetDate = date || todayStr();
    const cacheKey = `hourly|${targetDate}|${endpoint || ''}`;
    const cachedH = getChartCache(cacheKey);
    if (cachedH) return res.json({ message: '成功', data: cachedH });
    flushCallLogs();
    const range = dayRange(targetDate);

    // 配额不足排除在健康度统计外，理由同 get_hourly_health：客户没充配额不代表接口/上游有问题。
    let sql = `SELECT substr(timestamp, 12, 2) AS hour, COUNT(*) AS total, SUM(success) AS success
      FROM call_logs WHERE timestamp >= ? AND timestamp <= ? AND IFNULL(error_message, '') != '配额不足'`;
    const params = [range.start, range.end];
    if (endpoint) { sql += ' AND endpoint = ?'; params.push(endpoint); }
    sql += ' GROUP BY hour ORDER BY hour';

    const rows = db.prepare(sql).all(...params);
    const hourMap = {};
    for (const r of rows) hourMap[r.hour] = r;

    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const hs = h.toString().padStart(2, '0');
      const r = hourMap[hs];
      const total = r ? r.total : 0;
      const success = r ? (r.success || 0) : 0;
      // 接口健康程度 = 原始成功率（成功 ÷ 全部调用，含全部失败）。无调用则为 null（无数据）
      hourly.push({
        hour: `${hs}:00`,
        total,
        success,
        failed: total - success,
        success_rate: total > 0 ? Math.round((success / total) * 10000) / 100 : null
      });
    }

    return res.json({ message: '成功', data: setChartCache(cacheKey, { date: targetDate, endpoint_filter: endpoint || null, hourly }) });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 接口健康程度：按「接口 × 小时」返回**滚动近24小时**（以当前整点往回数24个小时桶，跨天）每接口每小时成功率（原始口径，含全部失败）
router.get('/get_hourly_health', adminRequired, (req, res) => {
  try {
    const cachedHealth = getChartCache('health');
    if (cachedHealth) return res.json({ message: '成功', data: cachedHealth });
    flushCallLogs();
    // 以服务器当前整点为终点，往回 24 个整点小时桶
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    const fmt = (d) => {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      return { key: `${d.getFullYear()}-${m}-${da} ${h}`, hour: `${h}:00`, date: `${m}-${da}` };
    };
    const buckets = [];
    for (let i = 23; i >= 0; i--) {
      buckets.push(fmt(new Date(base.getTime() - i * 3600 * 1000)));
    }
    const startTs = `${buckets[0].key}:00:00`;
    const endTs = `${buckets[23].key}:59:59`;

    // 配额不足是密钥自身状态（客户没充配额），不代表接口/上游有问题，排除在健康度统计外，
    // 否则某个大客户配额用完会把这段时间的"接口健康度"拉低，误导成上游故障。
    const rows = db.prepare(`
      SELECT endpoint, substr(timestamp, 1, 13) AS hk, COUNT(*) AS total, SUM(success) AS success
      FROM call_logs WHERE timestamp >= ? AND timestamp <= ? AND IFNULL(error_message, '') != '配额不足'
      GROUP BY endpoint, hk
    `).all(startTs, endTs);

    const epMap = {};
    // 先以全部数据接口（DEFAULT_PRICES）打底，零调用的接口也保留（前端按健康展示），不会因没调用就消失
    for (const ep of Object.keys(config.DEFAULT_PRICES)) {
      epMap[ep] = { endpoint: ep, total: 0, success: 0, byHk: {} };
    }
    for (const r of rows) {
      if (!epMap[r.endpoint]) epMap[r.endpoint] = { endpoint: r.endpoint, total: 0, success: 0, byHk: {} };
      const e = epMap[r.endpoint];
      e.total += r.total;
      e.success += (r.success || 0);
      e.byHk[r.hk] = { total: r.total, success: r.success || 0 };
    }

    const endpoints = Object.values(epMap).map(e => {
      const hourly = buckets.map(b => {
        const hr = e.byHk[b.key];
        const total = hr ? hr.total : 0;
        const success = hr ? hr.success : 0;
        return { hour: b.hour, date: b.date, total, success, success_rate: total > 0 ? Math.round((success / total) * 10000) / 100 : null };
      });
      return {
        endpoint: e.endpoint,
        total: e.total,
        success: e.success,
        success_rate: e.total > 0 ? Math.round((e.success / e.total) * 10000) / 100 : null,
        hourly
      };
    }).sort((a, b) => b.total - a.total);

    // ===== 上游维度（同样的24小时桶，细分到上游具体接口）=====
    // 服务记录（upstream 非空）按 (上游, 具体接口) × 小时聚合成功率；再把切换明细里"作为失败候选"
    // 的尝试计入对应 (上游, 接口) 的失败（总数+1、成功不加），避免候选链切换把上游故障掩盖掉。
    // 历史记录（未记 upstream_api 的旧行）归到 api='' 一行，只显示上游名。
    const upRows = db.prepare(`
      SELECT upstream, upstream_api AS api, substr(timestamp, 1, 13) AS hk, COUNT(*) AS total, SUM(success) AS success
      FROM call_logs WHERE timestamp >= ? AND timestamp <= ? AND length(upstream) > 0
      GROUP BY upstream, upstream_api, hk
    `).all(startTs, endTs);
    const attRows = db.prepare(`
      SELECT substr(timestamp, 1, 13) AS hk, upstream_attempts
      FROM call_logs WHERE timestamp >= ? AND timestamp <= ? AND length(upstream_attempts) > 0
    `).all(startTs, endTs);

    // 上游接口路径简写：完整URL/长路径只留最后一段；api_id=N 原样保留
    const shortApi = (api) => {
      if (!api) return '';
      if (/^api_id=/.test(api)) return api;
      const path = api.replace(/^https?:\/\/[^/]+/i, '');
      const segs = path.split('/').filter(Boolean);
      return segs.length ? segs[segs.length - 1] : api;
    };

    const upMap = {};
    const upEnsure = (up, api) => {
      const k = `${up}|${api || ''}`;
      return (upMap[k] = upMap[k] || { upstream: up, api: api || '', total: 0, success: 0, byHk: {} });
    };
    for (const r of upRows) {
      const e = upEnsure(r.upstream, r.api);
      e.total += r.total; e.success += (r.success || 0);
      const h = (e.byHk[r.hk] = e.byHk[r.hk] || { total: 0, success: 0 });
      h.total += r.total; h.success += (r.success || 0);
    }
    for (const r of attRows) {
      let arr; try { arr = JSON.parse(r.upstream_attempts); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        if (!a || !a.upstream) continue;
        const e = upEnsure(a.upstream, a.api);
        e.total += 1;
        const h = (e.byHk[r.hk] = e.byHk[r.hk] || { total: 0, success: 0 });
        h.total += 1;
      }
    }
    const upstreams = Object.values(upMap).map(e => {
      const hourly = buckets.map(b => {
        const hr = e.byHk[b.key];
        const total = hr ? hr.total : 0;
        const success = hr ? hr.success : 0;
        return { hour: b.hour, date: b.date, total, success, success_rate: total > 0 ? Math.round((success / total) * 10000) / 100 : null };
      });
      const dispName = UPSTREAM_DISPLAY_NAMES[e.upstream] || e.upstream;
      return {
        upstream: e.upstream,
        api: e.api,
        name: e.api ? `${dispName} · ${shortApi(e.api)}` : dispName,
        total: e.total,
        success: e.success,
        success_rate: e.total > 0 ? Math.round((e.success / e.total) * 10000) / 100 : null,
        hourly
      };
    }).sort((a, b) => (a.upstream === b.upstream ? b.total - a.total : String(a.upstream).localeCompare(String(b.upstream))));

    return res.json({
      message: '成功',
      data: setChartCache('health', {
        range: `${buckets[0].date} ${buckets[0].hour} ~ ${buckets[23].date} ${buckets[23].hour}`,
        hours: buckets.map(b => ({ hour: b.hour, date: b.date })),
        endpoints,
        upstreams
      })
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取分钟级统计 (SQL)
router.get('/get_minute_statistics', adminRequired, (req, res) => {
  try {
    const { date, endpoint } = req.query;
    const targetDate = date || todayStr();
    const cacheKeyM = `minute|${targetDate}|${endpoint || ''}`;
    const cachedM = getChartCache(cacheKeyM);
    if (cachedM) return res.json({ message: '成功', data: cachedM });
    flushCallLogs();
    const range = dayRange(targetDate);

    let sql = `SELECT substr(timestamp, 12, 5) AS minute, COUNT(*) AS cnt
      FROM call_logs WHERE timestamp >= ? AND timestamp <= ?`;
    const params = [range.start, range.end];
    if (endpoint) { sql += ' AND endpoint = ?'; params.push(endpoint); }
    sql += ' GROUP BY minute ORDER BY minute';

    const rows = db.prepare(sql).all(...params);
    const minuteMap = {};
    for (const r of rows) minuteMap[r.minute] = r.cnt;

    const minutes = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m++) {
        const key = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        minutes.push({ time: key, count: minuteMap[key] || 0 });
      }
    }

    return res.json({ message: '成功', data: setChartCache(cacheKeyM, { date: targetDate, endpoint_filter: endpoint || null, minutes }) });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取某天的真实用户调用统计：按 user_id 合并同一账户下的全部 API Key。
router.get('/get_daily_user_statistics', adminRequired, (req, res) => {
  try {
    // 读 usage_statistics 预聚合表；endpoint='ALL' 是每个密钥的当日汇总，再按 user_id 合并。
    flushUsageStatistics();
    const { date, endpoint } = req.query;
    const targetDate = date || todayStr();
    const ep = endpoint || 'ALL';
    const users = listDailyUserUsageSummary(db, targetDate, ep);

    return res.json({ message: '成功', data: { date: targetDate, endpoint_filter: endpoint || null, users } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取日粒度调用量 & 消费趋势
router.get('/get_daily_statistics', adminRequired, (req, res) => {
  try {
    flushUsageStatistics();
    const { start_date, end_date } = req.query;
    const startStr = start_date || todayStr();
    const endStr = end_date || todayStr();
    const startTs = startStr + ' 00:00:00';
    const endTs = endStr + ' 23:59:59';

    // 每日总量改读 usage_statistics 的每日全接口汇总行（endpoint='ALL'），不再扫 call_logs。
    // date 上下界天然排除特殊累计行 date='TOTAL'。
    const callRows = db.prepare(`
      SELECT date,
        SUM(calls) AS total_calls,
        SUM(success_calls) AS success_calls,
        SUM(amount) AS total_amount,
        SUM(cost) AS total_cost
      FROM usage_statistics
      WHERE date >= ? AND date <= ? AND endpoint = 'ALL'
      GROUP BY date ORDER BY date
    `).all(startStr, endStr);

    const rechargeRows = db.prepare(`
      SELECT substr(timestamp, 1, 10) AS date,
        SUM(amount) AS total_recharge
      FROM recharge_log
      WHERE timestamp >= ? AND timestamp <= ?
        AND type IN ('recharge', 'create', 'bind_transfer')
        AND amount > 0
      GROUP BY date ORDER BY date
    `).all(startTs, endTs);

    // 每日去重用户：按账户(user_id)归并，未绑定的 Auth 各算独立用户
    // active = 当天有调用的去重用户；paying = 当天有实际扣费(amount>0)的去重用户
    // 每日去重用户也读 usage_statistics（每个 密钥×日 一行 endpoint='ALL'，amount 即当日该密钥消费）。
    const userRows = db.prepare(`
      SELECT date, authorization, amount AS amt
      FROM usage_statistics
      WHERE date >= ? AND date <= ? AND endpoint = 'ALL'
    `).all(startStr, endStr);

    const activeMap = {};
    const payingMap = {};
    for (const r of userRows) {
      const info = dataStore.authorizations[r.authorization] || {};
      const identity = info.user_id || r.authorization;
      (activeMap[r.date] || (activeMap[r.date] = new Set())).add(identity);
      if ((r.amt || 0) > 0) {
        (payingMap[r.date] || (payingMap[r.date] = new Set())).add(identity);
      }
    }

    const callMap = {};
    for (const r of callRows) callMap[r.date] = r;
    const rechargeMap = {};
    for (const r of rechargeRows) rechargeMap[r.date] = r;

    const days = [];
    const cur = new Date(startStr + 'T00:00:00');
    const endD = new Date(endStr + 'T00:00:00');
    const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    while (cur <= endD) {
      const key = localDate(cur);
      const c = callMap[key];
      const r = rechargeMap[key];
      days.push({
        date: key,
        total_calls: c ? c.total_calls : 0,
        success_calls: c ? (c.success_calls || 0) : 0,
        total_amount: roundBalance(c ? (c.total_amount || 0) : 0),
        total_cost: roundBalance(c ? (c.total_cost || 0) : 0),
        total_profit: roundBalance(c ? ((c.total_amount || 0) - (c.total_cost || 0)) : 0),
        total_recharge: roundBalance(r ? (r.total_recharge || 0) : 0),
        active_users: activeMap[key] ? activeMap[key].size : 0,
        paying_users: payingMap[key] ? payingMap[key].size : 0
      });
      cur.setDate(cur.getDate() + 1);
    }

    return res.json({ message: '成功', data: { days } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 上游余额：不再主动查上游（慢），改为从「拦截存储」实时读取（每次数据调用都拦截了上游返回的余额）。
// 天然支持多个上游，秒回。
const UPSTREAM_DISPLAY_NAMES = { xingyin: '星河', matcha: 'Matcha', tikhub: 'TikHub', datadrifter: 'Datadrifter', swagger: 'Swagger' };
// 各上游币种符号：星河/Matcha/Datadrifter 人民币(¥)，TikHub 美元($)。Datadrifter 原始计价为点数，入库时已按 1000点=1元 换算
const UPSTREAM_CURRENCY = { xingyin: '¥', matcha: '¥', tikhub: '$' };
router.get('/get_upstream_balance', adminRequired, (req, res) => {
  const all = getAllUpstreamBalances();
  const items = Object.keys(config.UPSTREAMS).map(key => {
    const b = all[key] || {};
    const balNum = (b.balance === undefined ? null : b.balance);
    const sym = UPSTREAM_CURRENCY[key] || '¥';
    const balance_str = (typeof balNum === 'number' && isFinite(balNum)) ? `${sym}${balNum}` : (b.balanceStr || null);
    return {
      key,
      name: UPSTREAM_DISPLAY_NAMES[key] || key,
      balance: balNum,
      balance_str,
      updated_at: b.updatedAt || null
    };
  });
  return res.json({ message: '成功', data: { items } });
});

// ==================== 上游使用分布（近24小时，按实际服务的上游聚合）====================
// 与「接口健康程度」互补：健康图是客户视角（切换救回的调用不显故障），
// 这里是上游视角——各上游实际服务次数/成功率/成本，以及作为失败候选被切换掉的次数，
// V5 等主力上游掉链子会在 switched_away 上直接现形。
router.get('/get_upstream_usage', adminRequired, (req, res) => {
  try {
    const cached = getChartCache('upstream_usage');
    if (cached) return res.json({ message: '成功', data: cached });
    flushCallLogs();
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const p2 = (v) => String(v).padStart(2, '0');
    const sinceTs = `${since.getFullYear()}-${p2(since.getMonth() + 1)}-${p2(since.getDate())} ${p2(since.getHours())}:${p2(since.getMinutes())}:${p2(since.getSeconds())}`;

    // 实际服务：upstream 非空的记录（有上游参与转发且留下服务者标记）
    const rows = db.prepare(`
      SELECT upstream, COUNT(*) AS total, SUM(success) AS success, SUM(cost) AS cost
      FROM call_logs WHERE timestamp >= ? AND length(upstream) > 0
      GROUP BY upstream
    `).all(sinceTs);

    // 被切换次数：解析切换明细，统计各上游作为"失败候选"出现的次数
    const switchedAway = {};
    const arows = db.prepare(`
      SELECT upstream_attempts FROM call_logs
      WHERE timestamp >= ? AND length(upstream_attempts) > 0
    `).all(sinceTs);
    for (const r of arows) {
      try {
        for (const a of JSON.parse(r.upstream_attempts)) {
          if (a && a.upstream) switchedAway[a.upstream] = (switchedAway[a.upstream] || 0) + 1;
        }
      } catch (_) {}
    }

    const keys = new Set([...rows.map(r => r.upstream), ...Object.keys(switchedAway)]);
    const items = [...keys].map(k => {
      const r = rows.find(x => x.upstream === k) || { total: 0, success: 0, cost: 0 };
      return {
        upstream: k,
        name: UPSTREAM_DISPLAY_NAMES[k] || k,
        total: r.total,
        success: r.success || 0,
        success_rate: r.total > 0 ? Math.round(((r.success || 0) / r.total) * 10000) / 100 : null,
        cost: Math.round((r.cost || 0) * 10000) / 10000,
        switched_away: switchedAway[k] || 0
      };
    }).sort((a, b) => b.total - a.total);

    return res.json({ message: '成功', data: setChartCache('upstream_usage', { since: sinceTs, items }) });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 接口元数据 —— 新增接口只需在此加一条，前端自动同步
const ENDPOINT_META = [
  { type: 'get_note_detail',         name: '获取笔记详情',       shortName: '笔记详情',   method: 'GET',  url: '/api/get_note_detail',         params: ['note_id'] },
  { type: 'get_note_detail_video',   name: '获取视频笔记详情',   shortName: '视频详情',   method: 'GET',  url: '/api/get_note_detail_video',   params: ['note_id'], paramExamples: { note_id: '6a0ae55400000000350212e6' } },
  { type: 'search_note',             name: '搜索笔记',           shortName: '搜索笔记',   method: 'GET',  url: '/api/search_note',             params: ['keyword', 'page', 'sortType', 'filterNoteType', 'filterNoteTime', 'searchId', 'sessionId', 'filter_hot'] },
  { type: 'get_note_comment',        name: '获取笔记评论',       shortName: '笔记评论',   method: 'GET',  url: '/api/get_note_comment',        params: ['note_id', 'start', 'sortStrategy'] },
  { type: 'get_note_sub_comment',    name: '获取子评论',         shortName: '子评论',     method: 'GET',  url: '/api/get_note_sub_comment',    params: ['note_id', 'comment_id', 'start'] },
  { type: 'get_user_info',           name: '获取用户信息',       shortName: '用户信息',   method: 'GET',  url: '/api/get_user_info',           params: ['user_id'] },
  { type: 'user_note_list',          name: '获取用户笔记列表',   shortName: '笔记列表',   method: 'GET',  url: '/api/user_note_list',          params: ['user_id', 'cursor'] },
  { type: 'tag_notes',               name: '获取话题标签笔记',   shortName: '话题笔记',   method: 'GET',  url: '/api/tag_notes',               params: ['pageId', 'first_load_time', 'sort', 'last_note_ct', 'last_note_id', 'cursor_score', 'session_id'] },
];

// 追加「集中注册表」里的新接口（含 Matcha），使后台列表/定价/频率/统计自动带上。
// 老接口迁入注册表后（如 get_note_detail 改多上游候选链）type 会与上面硬编码重复，按 type 去重（硬编码优先）。
try {
  const { metaFromRegistry } = require('../apiRegistry');
  const seen = new Set(ENDPOINT_META.map(e => e.type));
  ENDPOINT_META.push(...metaFromRegistry().filter(m => !seen.has(m.type)));
} catch (e) {
  console.error('合并接口注册表 META 失败:', e.message);
}

router.get('/get_endpoint_list', adminRequired, (req, res) => {
  try {
    const endpoints = ENDPOINT_META.map(ep => ({
      ...ep,
      price: getDefaultPrice(ep.type) ?? 0
    }));
    return res.json({ message: '成功', data: { endpoints } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// ==================== 用户账户管理 ====================

// extra（可选）：{ channel, out_trade_no, pay_type, trade_no }。手动充值不传 → channel 默认 'manual'。
function addUserRechargeRecord(userId, type, amount, beforeBalance, afterBalance, remark, extra = {}) {
  const ua = dataStore.userAccounts[userId] || {};
  try {
    // authorization 用空字符串占位（旧表有 NOT NULL 约束，无法存 NULL）
    db.prepare(`INSERT INTO recharge_log
      (timestamp, authorization, user_id, user_name, type, amount, before_balance, after_balance, remark, channel, out_trade_no, pay_type, trade_no)
      VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nowStr(), userId, ua.username || '未知', type, amount, beforeBalance, afterBalance, remark,
      extra.channel || 'manual', extra.out_trade_no || null, extra.pay_type || null, extra.trade_no || null
    );
  } catch (e) {
    console.error('保存用户充值记录失败:', e.message);
  }
}

// 创建用户账户（同时自动生成一个初始 auth）
router.post('/create_user_account', adminRequired, (req, res) => {
  try {
    const { user_id: inputUserId, username, initial_balance = 0 } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ message: '失败', error: '缺少 username' });
    }

    const userId = inputUserId ? String(inputUserId).trim() : generateUserId();

    if (dataStore.userAccounts[userId]) {
      return res.status(409).json({ message: '失败', error: '用户ID已存在' });
    }

    const now = nowStr();
    const balance = Math.max(0, parseFloat(initial_balance) || 0);

    // 创建用户账户
    dataStore.userAccounts[userId] = { username: username.trim(), balance, created_at: now, last_used_at: null };
    stmts.upsertUserAccount.run(userId, username.trim(), balance, now, null);

    // 初始化用户级默认价格：用「系统设置」里的接口默认价（可改，落库）
    const initPrices = getAllDefaultPrices();
    dataStore.userPrices[userId] = { ...initPrices };
    const insertPriceBatch = db.transaction(() => {
      for (const [ep, price] of Object.entries(initPrices)) {
        stmts.upsertUserPrice.run(userId, ep, price);
      }
    });
    insertPriceBatch();

    // 自动生成第一个 auth
    const auth = generateSkAuth();
    dataStore.authorizations[auth] = {
      name: username.trim(), description: '',
      created_at: now, enabled: true, initial_balance: 0,
      attack_records: [], blocked: false,
      blocked_at: '', block_reason: '', unblocked_at: '',
      user_id: userId, is_default: true
    };
    dataStore.usersBalance[auth] = 0;
    stmts.upsertSingleUser.run(auth, username.trim(), '', now, 1, 0, 0, 0, null, null, null, '[]', userId, 1, null);

    if (balance > 0) {
      addUserRechargeRecord(userId, 'create', balance, 0, balance, `创建用户账户，初始余额 ${balance} 元`);
    }

    console.log(`创建用户账户: ${userId} (${username}), 初始余额: ${balance}, auth: ${auth}`);
    return res.json({
      message: '成功',
      data: { user_id: userId, username: username.trim(), balance, authorization: auth, created_at: now }
    });
  } catch (e) {
    console.error(`创建用户账户失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取用户账户列表（含各账户下的 auth 列表）
router.get('/list_user_accounts', adminRequired, (req, res) => {
  try {
    const result = [];
    for (const [userId, ua] of Object.entries(dataStore.userAccounts)) {
      const auths = stmts.getAuthsByUserId.all(userId).map(r => ({
        authorization: r.authorization,
        name: r.name,
        enabled: r.enabled === 1,
        blocked: r.blocked === 1,
        is_default: r.is_default === 1,
        created_at: r.created_at
      }));
      result.push({
        user_id: userId,
        username: ua.username,
        balance: roundBalance(ua.balance),
        created_at: ua.created_at,
        last_used_at: ua.last_used_at || null,
        auth_count: auths.length,
        auths
      });
    }
    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return res.json({ message: '成功', data: result });
  } catch (e) {
    console.error(`获取用户账户列表失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取单个用户账户详情
router.get('/get_user_account', adminRequired, (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ message: '失败', error: '缺少 user_id' });
    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const auths = stmts.getAuthsByUserId.all(user_id).map(r => ({
      authorization: r.authorization,
      name: r.name,
      enabled: r.enabled === 1,
      blocked: r.blocked === 1,
      blocked_at: r.blocked_at || '',
      block_reason: r.block_reason || '',
      is_default: r.is_default === 1,
      created_at: r.created_at
    }));

    const prices = dataStore.userPrices[user_id] || {};

    return res.json({
      message: '成功',
      data: {
        user_id, username: ua.username,
        balance: roundBalance(ua.balance),
        created_at: ua.created_at,
        last_used_at: ua.last_used_at || null,
        auths, prices
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 修改用户账户名
router.post('/rename_user_account', adminRequired, (req, res) => {
  try {
    const { user_id, username } = req.body;
    if (!user_id || !username?.trim()) {
      return res.status(400).json({ message: '失败', error: '缺少参数' });
    }
    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    ua.username = username.trim();
    saveUserAccount(user_id);
    console.log(`修改用户账户名: ${user_id} → ${username.trim()}`);
    return res.json({ message: '成功', data: { user_id, username: ua.username } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 删除用户账户（级联删除所有 auth 及相关数据）
router.post('/delete_user_account', adminRequired, (req, res) => {
  try {
    flushBufferedWrites();
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ message: '失败', error: '缺少 user_id' });
    if (!dataStore.userAccounts[user_id]) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const auths = stmts.getAuthsByUserId.all(user_id).map(r => r.authorization);

    const deleteTx = db.transaction(() => {
      for (const auth of auths) {
        db.prepare('DELETE FROM users WHERE authorization = ?').run(auth);
        db.prepare('DELETE FROM custom_prices WHERE authorization = ?').run(auth);
        db.prepare('DELETE FROM usage_statistics WHERE authorization = ?').run(auth);
        db.prepare('DELETE FROM call_logs WHERE authorization = ?').run(auth);
        db.prepare('DELETE FROM recharge_log WHERE authorization = ?').run(auth);
      }
      db.prepare('DELETE FROM user_prices WHERE user_id = ?').run(user_id);
      db.prepare('DELETE FROM recharge_log WHERE user_id = ?').run(user_id);
      db.prepare('DELETE FROM user_accounts WHERE user_id = ?').run(user_id);
    });
    deleteTx();

    // 清理内存
    for (const auth of auths) {
      delete dataStore.authorizations[auth];
      delete dataStore.usersBalance[auth];
      delete dataStore.customPrices[auth];
      delete dataStore.usageStatistics[auth];
    }
    delete dataStore.userAccounts[user_id];
    delete dataStore.userPrices[user_id];

    // 清理频率配置：用户级 + 名下各密钥的密钥级
    try { deleteThrottleScope('user', user_id); } catch (e) {}
    for (const auth of auths) { try { deleteThrottleScope('auth', auth); } catch (e) {} }

    console.log(`删除用户账户: ${user_id}, 级联删除 auth 数量: ${auths.length}`);
    return res.json({ message: '成功', data: { user_id, deleted_auths: auths.length } });
  } catch (e) {
    console.error(`删除用户账户失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 充值到用户账户
router.post('/recharge_user', adminRequired, async (req, res) => {
  try {
    const { user_id, amount, recharge_type } = req.body;
    if (!user_id || amount === undefined || amount === null) return res.status(400).json({ message: '失败', error: '缺少参数' });
    const parsedAmount = parseFloat(amount);
    // 正数=增加（充值），负数=减少（扣减）。
    if (isNaN(parsedAmount) || parsedAmount === 0) return res.status(400).json({ message: '失败', error: '金额不能为0' });

    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const currentBalance = ua.balance;
    let result;
    if (parsedAmount > 0) {
      result = await atomicUserBalanceOperation(user_id, 'add', parsedAmount);
    } else {
      // 扣减：用 charge（带余额检查，避免扣成负数）
      result = await atomicUserBalanceOperation(user_id, 'charge', -parsedAmount);
      if (!result.success && result.error === '余额不足') {
        return res.status(400).json({ message: '失败', error: `扣减金额超过当前余额（当前 ¥${currentBalance}）` });
      }
    }
    if (!result.success) return res.status(400).json({ message: '失败', error: result.error });

    const isAdd = parsedAmount > 0;
    const recordType = isAdd && recharge_type === 'register_bonus' ? 'register_bonus' : (isAdd ? 'recharge' : 'deduct');
    addUserRechargeRecord(user_id, recordType, parsedAmount, currentBalance, result.balance,
      isAdd ? `充值 ${parsedAmount} 元` : `扣减 ${-parsedAmount} 元`);
    console.log(`${isAdd ? '充值' : '扣减'}用户账户 ${user_id}: ${parsedAmount}, 新余额: ${result.balance}`);
    return res.json({ message: '成功', data: { user_id, previous_balance: currentBalance, recharge_amount: parsedAmount, new_balance: result.balance } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// ==================== 在线充值入账（门户支付成功后服务器到服务器回调）====================
// 签名规则（与门户约定）：取除 sign 外的全部非空参数，按参数名 ASCII 升序拼成 a=b&c=d（值不做 URL 编码），
// 末尾直接拼共享密钥，再 md5，结果小写：sign = md5("amount=..&out_trade_no=..&timestamp=..&user_id=.." + SECRET)
function _buildRechargeSign(params, secret) {
  const keys = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(str + secret, 'utf8').digest('hex');
}
// 防重放：timestamp 为秒级，允许 ±SECONDS 偏差
const _RECHARGE_TS_WINDOW = 300;
// 核心入账：以 out_trade_no 幂等。无论被回调还是人工补单调用，同一订单号只入账一次。
// 失败模式优先「绝不重复加钱」：已 paid → 直接返回；订单行已存在(pending/failed/并发) → 不再加钱，返回 processing 让人工对账。
// 返回 { http, body }。remark/pay_type/trade_no 可选。
async function _creditRechargeOrder({ user_id, amt, out_trade_no, pay_type, trade_no, remark }) {
  const ua = dataStore.userAccounts[user_id];
  if (!ua) return { http: 404, body: { message: '失败', error: '用户不存在' } };

  // 1) 幂等：已入账的订单直接返回成功（不重复加钱）
  const existed = db.prepare('SELECT status, after_balance FROM recharge_orders WHERE out_trade_no = ?').get(out_trade_no);
  if (existed && existed.status === 'paid') {
    return { http: 200, body: { message: '成功', data: { user_id, out_trade_no, recharge_amount: amt, new_balance: existed.after_balance, duplicate: true } } };
  }
  // 2) 用 PRIMARY KEY 抢占订单号；冲突＝并发/重发/上次未完成 → 不再加钱（避免重复），交给对账
  if (existed) {
    return { http: 200, body: { message: '成功', data: { user_id, out_trade_no, status: existed.status, processing: true, note: '订单已存在但未完成入账，请用对账接口核对，勿重复加钱' } } };
  }
  try {
    db.prepare(`INSERT INTO recharge_orders (out_trade_no, user_id, amount, pay_type, trade_no, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(out_trade_no, user_id, amt, pay_type || null, trade_no || null, nowStr());
  } catch (e) {
    return { http: 200, body: { message: '成功', data: { user_id, out_trade_no, recharge_amount: amt, processing: true } } };
  }

  // 3) 加余额
  const currentBalance = ua.balance;
  const result = await atomicUserBalanceOperation(user_id, 'add', amt);
  if (!result.success) {
    db.prepare("UPDATE recharge_orders SET status='failed' WHERE out_trade_no=?").run(out_trade_no);
    return { http: 400, body: { message: '失败', error: result.error } };
  }

  // 4) 落订单 + 记流水（channel=online）
  db.prepare("UPDATE recharge_orders SET status='paid', before_balance=?, after_balance=?, paid_at=? WHERE out_trade_no=?")
    .run(currentBalance, result.balance, nowStr(), out_trade_no);
  addUserRechargeRecord(user_id, 'recharge', amt, currentBalance, result.balance, remark || `在线充值 ${amt} 元`,
    { channel: 'online', out_trade_no, pay_type, trade_no });
  console.log(`[在线充值] 用户 ${user_id} 订单 ${out_trade_no} 入账 ${amt}，新余额: ${result.balance}`);
  return { http: 200, body: { message: '成功', data: { user_id, out_trade_no, recharge_amount: amt, previous_balance: currentBalance, new_balance: result.balance } } };
}

// 入账接口。门户在易支付回调验签通过、确认支付成功后，再服务器到服务器调本接口给用户加余额。
// body: { user_id, amount, out_trade_no, timestamp, sign, pay_type?, trade_no? }
router.post('/recharge_by_order', async (req, res) => {
  try {
    const secret = config.RECHARGE_CALLBACK_SECRET;
    if (!secret) return res.status(503).json({ message: '失败', error: '在线充值未启用' });

    const { user_id, amount, out_trade_no, timestamp, sign, pay_type, trade_no } = req.body || {};
    if (!user_id || amount === undefined || amount === null || !out_trade_no || !timestamp || !sign) {
      return res.status(400).json({ message: '失败', error: '缺少必要参数（user_id/amount/out_trade_no/timestamp/sign）' });
    }
    // 验签
    const expect = _buildRechargeSign({ user_id, amount, out_trade_no, timestamp, pay_type, trade_no }, secret);
    if (String(sign).toLowerCase() !== expect) {
      return res.status(401).json({ message: '失败', error: '签名校验失败' });
    }
    // 防重放（时间戳过期）
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > _RECHARGE_TS_WINDOW) {
      return res.status(400).json({ message: '失败', error: '时间戳无效或已过期' });
    }
    // 金额合法性
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: '失败', error: '金额必须大于0' });

    const r = await _creditRechargeOrder({ user_id, amt, out_trade_no, pay_type, trade_no });
    return res.status(r.http).json(r.body);
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 对账：查单个充值订单状态（门户支付完跳回页 / 管理员对账用）。?out_trade_no=...
router.get('/get_recharge_order', adminRequired, (req, res) => {
  try {
    const { out_trade_no } = req.query;
    if (!out_trade_no) return res.status(400).json({ message: '失败', error: '缺少 out_trade_no' });
    const order = db.prepare('SELECT * FROM recharge_orders WHERE out_trade_no = ?').get(out_trade_no);
    if (!order) return res.json({ message: '成功', data: { found: false, out_trade_no } });
    return res.json({ message: '成功', data: { found: true, ...order } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 对账：列出充值订单（默认列未完成的，供管理员排查丢通知/卡单）。?status=pending|failed|paid&user_id=&limit=
router.get('/list_recharge_orders', adminRequired, (req, res) => {
  try {
    const { status, user_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    let sql = 'SELECT * FROM recharge_orders WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const orders = db.prepare(sql).all(...params);
    return res.json({ message: '成功', data: { count: orders.length, orders } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 人工补单：丢通知/卡单时，管理员核实已付款后手动入账。走同一幂等逻辑，已入账则不重复加钱。
// body: { user_id, amount, out_trade_no, pay_type?, trade_no? }（管理员密钥鉴权，无需签名）
router.post('/recharge_order_makeup', adminRequired, async (req, res) => {
  try {
    const { user_id, amount, out_trade_no, pay_type, trade_no } = req.body || {};
    if (!user_id || amount === undefined || amount === null || !out_trade_no) {
      return res.status(400).json({ message: '失败', error: '缺少必要参数（user_id/amount/out_trade_no）' });
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: '失败', error: '金额必须大于0' });
    const r = await _creditRechargeOrder({ user_id, amt, out_trade_no, pay_type, trade_no, remark: `人工补单 ${amt} 元` });
    if (r.http === 200 && r.body.data) console.warn(`[人工补单] 管理员对订单 ${out_trade_no} 补单，用户 ${user_id}，金额 ${amt}`);
    return res.status(r.http).json(r.body);
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 设置用户账户余额
router.post('/set_user_balance', adminRequired, async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    if (!user_id || amount === undefined || amount === null) return res.status(400).json({ message: '失败', error: '缺少参数' });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) return res.status(400).json({ message: '失败', error: '余额不能为负数' });

    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const previousBalance = ua.balance;
    const result = await atomicUserBalanceOperation(user_id, 'set', parsedAmount);
    if (!result.success) return res.status(400).json({ message: '失败', error: result.error });

    addUserRechargeRecord(user_id, 'set_balance', roundBalance(parsedAmount - previousBalance), previousBalance, parsedAmount, `设置余额为 ${parsedAmount}`);
    return res.json({ message: '成功', data: { user_id, balance: result.balance } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 获取用户账户价格
router.get('/get_user_prices', adminRequired, (req, res) => {
  try {
    const { user_id, authorization } = req.query;
    if (user_id) {
      // 用户级价格
      if (!dataStore.userAccounts[user_id]) return res.status(404).json({ message: '失败', error: '用户不存在' });
      return res.json({ message: '成功', data: dataStore.userPrices[user_id] || {} });
    }
    if (authorization) {
      // auth 级价格（兼容旧逻辑）
      return res.json({ message: '成功', data: dataStore.customPrices[authorization] || {} });
    }
    return res.status(400).json({ message: '失败', error: '缺少 user_id 或 authorization' });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 设置用户账户接口价格
router.post('/set_user_price', adminRequired, (req, res) => {
  try {
    const { user_id, authorization, endpoint, price } = req.body;
    if (!endpoint || price === undefined) return res.status(400).json({ message: '失败', error: '缺少参数' });

    if (user_id) {
      if (!dataStore.userAccounts[user_id]) return res.status(404).json({ message: '失败', error: '用户不存在' });
      if (!dataStore.userPrices[user_id]) dataStore.userPrices[user_id] = {};
      dataStore.userPrices[user_id][endpoint] = parseFloat(price);
      saveUserPrice(user_id, endpoint, parseFloat(price));
      console.log(`设置用户 ${user_id} 接口 ${endpoint} 价格: ${price}`);
      return res.json({ message: '成功', data: { user_id, endpoint, price: parseFloat(price) } });
    }

    if (authorization) {
      // 兼容旧的 auth 级价格设置
      if (!dataStore.customPrices[authorization]) dataStore.customPrices[authorization] = {};
      dataStore.customPrices[authorization][endpoint] = parseFloat(price);
      saveSinglePrice(authorization, endpoint, parseFloat(price));
      return res.json({ message: '成功', data: { authorization, endpoint, price: parseFloat(price) } });
    }

    return res.status(400).json({ message: '失败', error: '缺少 user_id 或 authorization' });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 将已有 auth 绑定到用户（余额转入用户账户）
router.post('/bind_auth_to_user', adminRequired, (req, res) => {
  try {
    const { authorization, user_id } = req.body;
    if (!authorization || !user_id) return res.status(400).json({ message: '失败', error: '缺少参数' });

    const authInfo = dataStore.authorizations[authorization];
    if (!authInfo) return res.status(404).json({ message: '失败', error: 'Auth不存在' });
    if (authInfo.user_id) return res.status(409).json({ message: '失败', error: '该Auth已绑定用户，请先解绑' });

    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const authBalance = dataStore.usersBalance[authorization] || 0;

    const bindTx = db.transaction(() => {
      // auth 余额转入用户账户
      if (authBalance > 0) {
        stmts.refundUserAccountBalance.run(authBalance, user_id);
      }
      // 绑定 auth 到用户，auth 自身余额清零
      stmts.setUserIdOnAuth.run(user_id, authorization);
    });
    bindTx();

    // 更新内存
    authInfo.user_id = user_id;
    dataStore.usersBalance[authorization] = 0;
    if (ua) ua.balance = roundBalance(ua.balance + authBalance);

    if (authBalance > 0) {
      const beforeBal = roundBalance(ua.balance - authBalance);
      addUserRechargeRecord(user_id, 'bind_transfer', authBalance, beforeBal, ua.balance, `绑定Auth ${authorization.substring(0, 8)}...，余额转入 ${authBalance} 元`);
    }

    console.log(`绑定Auth ${authorization} 到用户 ${user_id}，转移余额: ${authBalance}`);
    return res.json({
      message: '成功',
      data: { authorization, user_id, transferred_balance: authBalance, user_balance: ua.balance }
    });
  } catch (e) {
    console.error(`绑定Auth失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 管理员在用户下创建新 auth
router.post('/create_auth_for_user', adminRequired, (req, res) => {
  try {
    const { user_id, name } = req.body;
    if (!user_id) return res.status(400).json({ message: '失败', error: '缺少 user_id' });

    const ua = dataStore.userAccounts[user_id];
    if (!ua) return res.status(404).json({ message: '失败', error: '用户不存在' });

    const auth = generateSkAuth();
    const now = nowStr();
    const authName = name?.trim() || ua.username;

    dataStore.authorizations[auth] = {
      name: authName, description: '',
      created_at: now, enabled: true, initial_balance: 0,
      attack_records: [], blocked: false,
      blocked_at: '', block_reason: '', unblocked_at: '',
      user_id, is_default: false
    };
    dataStore.usersBalance[auth] = 0;
    stmts.upsertSingleUser.run(auth, authName, '', now, 1, 0, 0, 0, null, null, null, '[]', user_id, 0, null);

    console.log(`管理员在用户 ${user_id} 下创建Auth: ${auth}`);
    return res.json({ message: '成功', data: { authorization: auth, user_id, created_at: now } });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 用户账户的充值记录
router.get('/get_user_recharge_log', adminRequired, (req, res) => {
  try {
    const { user_id, type, start_date, end_date } = req.query;
    if (!user_id) return res.status(400).json({ message: '失败', error: '缺少 user_id' });
    if (!dataStore.userAccounts[user_id]) return res.status(404).json({ message: '失败', error: '用户不存在' });

    let sql = 'SELECT * FROM recharge_log WHERE user_id = ?';
    const params = [user_id];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (start_date) { sql += ' AND timestamp >= ?'; params.push(start_date + ' 00:00:00'); }
    if (end_date) { sql += ' AND timestamp <= ?'; params.push(end_date + ' 23:59:59'); }
    sql += ' ORDER BY id DESC';

    const records = db.prepare(sql).all(...params);
    let totalRecharge = 0;
    records.forEach(r => { if (r.type === 'recharge' || r.type === 'create') totalRecharge += r.amount; });

    return res.json({
      message: '成功',
      data: { records, count: records.length, total_recharge: roundBalance(totalRecharge) }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 未绑定用户的散号列表
router.get('/list_unbound_auths', adminRequired, (req, res) => {
  try {
    const result = [];
    for (const [auth, info] of Object.entries(dataStore.authorizations)) {
      if (!info.user_id) {
        result.push({
          authorization: auth,
          name: info.name,
          description: info.description,
          created_at: info.created_at,
          enabled: info.enabled,
          blocked: info.blocked || false,
          blocked_at: info.blocked_at || '',
          block_reason: info.block_reason || '',
          attack_count: (info.attack_records || []).length,
          balance: dataStore.usersBalance[auth] || 0
        });
      }
    }
    return res.json({ message: '成功', data: result });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

module.exports = router;
