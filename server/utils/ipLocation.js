/**
 * IP 归属地解析（用于仪表盘"用户地区分布"图）
 * ------------------------------------------------------------
 * 用高德 IP 定位接口(https://restapi.amap.com/v3/ip)查省份，查过的 IP 落库长期缓存
 * （公网IP地理归属基本不变，不用像上游余额那样定时刷新）。
 * 两种用法：
 * - resolveIpLocationAsync(ip)：fire-and-forget，不等待、不阻塞调用方，给每次请求记日志时顺手用
 * - resolveIpLocationsBatch(ips, concurrency)：真正 await，内部并发池控制，给"要马上拿到完整结果"
 *   的场景用（比如地区分布图——按用户去重后IP数量级不大，同步等几秒换一次拿全，比缺数据体验好）
 * 查不到/内网IP/高德限流都静默失败落 status='error'，不重复重试同一个坏IP。
 */
const axios = require('axios');
const db = require('./db');
const config = require('../config');

db.exec(`CREATE TABLE IF NOT EXISTS ip_location_cache (
  ip         TEXT PRIMARY KEY,
  province   TEXT,
  city       TEXT,
  status     TEXT,
  updated_at TEXT
)`);

const _selectStmt = db.prepare('SELECT province, city, status FROM ip_location_cache WHERE ip = ?');
const _upsertStmt = db.prepare(`INSERT INTO ip_location_cache(ip, province, city, status, updated_at)
  VALUES(?, ?, ?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET province=excluded.province, city=excluded.city, status=excluded.status, updated_at=excluded.updated_at`);

const _inFlight = new Map(); // ip -> Promise，同一IP并发请求时复用同一个 in-flight promise，不重复打高德

function _now() {
  const n = new Date(); const p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

// 内网/本机/无效 IP 不用查高德，直接判定
const _PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|localhost$)/i;
function isPrivateIp(ip) {
  return !ip || _PRIVATE_RE.test(ip);
}

// 真正查一次高德并落库，返回 Promise<void>；调用前应已确认不在缓存里
function _fetchAndCache(ip) {
  if (!config.AMAP_KEY) return Promise.resolve();
  return axios.get('https://restapi.amap.com/v3/ip', { params: { ip, key: config.AMAP_KEY }, timeout: 5000 })
    .then(r => {
      const d = r.data || {};
      // 高德对部分IP(海外/无法精确定位)会返回 status:"1" 但 province/city 是空数组 []，
      // 不是字符串——[] 是 truthy，光判断 d.province 会误判成"有效数据"，还会因为把数组
      // 传给SQLite绑定参数而抛异常；这里必须显式判断是非空字符串才算真解析成功。
      const province = typeof d.province === 'string' && d.province ? d.province : '';
      const city = typeof d.city === 'string' ? d.city : '';
      if (d.status === '1' && province) {
        _upsertStmt.run(ip, province, city, 'ok', _now());
      } else {
        _upsertStmt.run(ip, null, null, 'error', _now());
      }
    })
    .catch(() => {
      try { _upsertStmt.run(ip, null, null, 'error', _now()); } catch (_) {}
    });
}

// 解析单个IP：已缓存/内网直接返回；否则去查（多个调用方同时传同一IP会复用同一个in-flight请求）
function _resolveOne(ip) {
  if (!ip) return Promise.resolve();
  if (isPrivateIp(ip)) {
    try {
      const row = _selectStmt.get(ip);
      if (!row) _upsertStmt.run(ip, null, null, 'private', _now());
    } catch (_) {}
    return Promise.resolve();
  }
  try {
    if (_selectStmt.get(ip)) return Promise.resolve(); // 已缓存（含之前的 error），不重复查
  } catch (_) { return Promise.resolve(); }
  if (_inFlight.has(ip)) return _inFlight.get(ip);
  const p = _fetchAndCache(ip).finally(() => { _inFlight.delete(ip); });
  _inFlight.set(ip, p);
  return p;
}

// fire-and-forget：调用方不等待、不关心结果，给高频请求路径（recordBillingOutcome）用
function resolveIpLocationAsync(ip) {
  _resolveOne(ip).catch(() => {});
}

// 批量并发解析，真正 await 到全部完成再返回；内部用简单并发池控制，避免瞬间打爆高德配额
async function resolveIpLocationsBatch(ips, concurrency = 10) {
  const queue = [...new Set(ips)].filter(ip => ip && !isPrivateIp(ip));
  let idx = 0;
  const workers = new Array(Math.min(concurrency, queue.length || 1)).fill(0).map(async () => {
    while (idx < queue.length) {
      const ip = queue[idx++];
      await _resolveOne(ip);
    }
  });
  await Promise.all(workers);
}

module.exports = { resolveIpLocationAsync, resolveIpLocationsBatch, isPrivateIp };
