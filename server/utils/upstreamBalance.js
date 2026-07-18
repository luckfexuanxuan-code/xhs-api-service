/**
 * 上游余额拦截存储
 * ------------------------------------------------------------
 * 不再主动调用上游的「余额查询」接口（慢、且只能查一个上游）。
 * 改为：每次正常数据调用时，上游响应里都带余额字段，在适配器里顺手拦截下来，
 *       实时更新到内存（热路径零 DB 开销），定时落库以便重启恢复。
 * 仪表盘直接读内存/库，秒回，且天然支持多个上游。
 */
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS upstream_balance (
  upstream    TEXT PRIMARY KEY,
  balance     REAL,
  balance_str TEXT,
  updated_at  TEXT
)`);

const _mem = {};   // { upstream: { balance, balanceStr, updatedAt } }
let _dirty = false;

// 启动时从库恢复
try {
  for (const r of db.prepare('SELECT upstream, balance, balance_str, updated_at FROM upstream_balance').all()) {
    _mem[r.upstream] = { balance: r.balance, balanceStr: r.balance_str, updatedAt: r.updated_at };
  }
} catch (e) { console.error('加载上游余额失败:', e.message); }

function _now() {
  const n = new Date(); const p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

// 拦截：在上游响应里取到余额时调用（热路径，仅更新内存）
function recordUpstreamBalance(upstream, balance, balanceStr) {
  if (!upstream) return;
  _mem[upstream] = {
    balance: (typeof balance === 'number' && isFinite(balance)) ? balance : null,
    balanceStr: balanceStr || null,
    updatedAt: _now()
  };
  _dirty = true;
}

function getAllUpstreamBalances() {
  return _mem;
}

// 定时落库（每 15 秒，仅在有更新时）
const _upsert = db.prepare(`INSERT INTO upstream_balance(upstream, balance, balance_str, updated_at)
  VALUES(?, ?, ?, ?) ON CONFLICT(upstream) DO UPDATE SET
  balance = excluded.balance, balance_str = excluded.balance_str, updated_at = excluded.updated_at`);
function _flush() {
  if (!_dirty) return;
  _dirty = false;
  try { for (const [u, v] of Object.entries(_mem)) _upsert.run(u, v.balance, v.balanceStr, v.updatedAt); }
  catch (e) { console.error('落库上游余额失败:', e.message); }
}
const _timer = setInterval(_flush, 15000);
if (typeof _timer.unref === 'function') _timer.unref();

// ------------------------------------------------------------
// TikHub 例外：其数据接口的响应里不带余额，无法像星河/Matcha 那样顺手拦截。
// 因此用专用的「余额查询」接口主动轮询：启动后查一次，之后每 5 分钟查一次。
// 余额位于 user_data.balance。
const TIKHUB_BALANCE_URL = 'https://api.tikhub.io/api/v1/tikhub/user/get_user_info';
async function _pollTikhubBalance() {
  let config, axios;
  try { config = require('../config'); axios = require('axios'); } catch (_) { return; }
  const up = config.UPSTREAMS && config.UPSTREAMS.tikhub;
  if (!up || !up.authorization) return;
  try {
    const r = await axios.get(TIKHUB_BALANCE_URL, {
      headers: { 'Authorization': `Bearer ${up.authorization}` },
      timeout: 15000
    });
    const ud = r.data && r.data.user_data;
    const bal = ud && Number(ud.balance);
    if (typeof bal === 'number' && isFinite(bal)) {
      recordUpstreamBalance('tikhub', bal, bal.toFixed(3) + '元');
    }
  } catch (e) { /* 余额查询失败不影响主流程，静默重试 */ }
}
// 启动后稍延迟首查（让 config 等就绪），之后每 5 分钟
setTimeout(_pollTikhubBalance, 3000);
const _tikhubTimer = setInterval(_pollTikhubBalance, 5 * 60 * 1000);
if (typeof _tikhubTimer.unref === 'function') _tikhubTimer.unref();

module.exports = { recordUpstreamBalance, getAllUpstreamBalances };
