/**
 * 公开接口 - 无需管理员权限，用于用户自助扩展 auth
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const {
  dataStore,
  stmts,
  nowStr,
  generateSkAuth,
  saveUser,
  saveUserPrice
} = require('../utils/dataManager');

// 限速：每个 user_id 每 60 秒最多创建 5 个 auth
const createRateLimit = new Map(); // { user_id: { count, windowStart } }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 1000;

function checkRateLimit(userId) {
  const now = Date.now();
  const record = createRateLimit.get(userId);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    createRateLimit.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// POST /user/create_auth
// body: { user_id }
// 在指定用户下新建一个 sk- auth，无需管理员密钥
router.post('/create_auth', (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ message: '失败', error: '缺少 user_id' });
    }

    const ua = dataStore.userAccounts[user_id];
    if (!ua) {
      return res.status(404).json({ message: '失败', error: '用户不存在' });
    }

    if (!checkRateLimit(user_id)) {
      return res.status(429).json({ message: '失败', error: '创建频率过高，请稍后再试' });
    }

    const auth = generateSkAuth();
    const now = nowStr();

    dataStore.authorizations[auth] = {
      name: `${ua.username}-auth`,
      description: '',
      created_at: now,
      enabled: true,
      initial_balance: 0,
      attack_records: [],
      blocked: false,
      blocked_at: '',
      block_reason: '',
      unblocked_at: '',
      user_id, is_default: false
    };
    dataStore.usersBalance[auth] = 0;

    stmts.upsertSingleUser.run(
      auth, `${ua.username}-auth`, '', now,
      1, 0, 0, 0, null, null, null, '[]', user_id, 0, null
    );

    return res.json({
      message: '成功',
      data: { authorization: auth, user_id, created_at: now }
    });
  } catch (e) {
    console.error(`创建Auth失败: ${e.message}`);
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

module.exports = router;
