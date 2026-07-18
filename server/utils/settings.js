/**
 * 运行时可调设置（持久化到 app_settings 表 + 内存缓存）。
 * 与 config.js 的区别：config.js 是启动时固定的默认值；这里的值可在后台「系统设置」里
 * 实时修改并落库，重启后仍生效。未设置过的键回落到 config.js 的默认值。
 */
const db = require('./db');
const config = require('../config');

const _getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const _setStmt = db.prepare(
  'INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

// 内存缓存，避免每个请求都读库（限流判定在热路径上）
const _cache = {};

function _readRaw(key) {
  const row = _getStmt.get(key);
  return row ? row.value : undefined;
}

// 单密钥每秒最大请求数（QPS）。未设置过 → 回落 config.KEY_RATE_LIMIT_QPS。
function getRateLimitQps() {
  if (_cache.key_rate_limit_qps !== undefined) return _cache.key_rate_limit_qps;
  const raw = _readRaw('key_rate_limit_qps');
  const n = raw === undefined ? config.KEY_RATE_LIMIT_QPS : parseInt(raw, 10);
  _cache.key_rate_limit_qps = Number.isFinite(n) ? n : config.KEY_RATE_LIMIT_QPS;
  return _cache.key_rate_limit_qps;
}

// 设置 QPS。0 = 关闭限流；必须是 >=0 的整数。返回最终生效值。
function setRateLimitQps(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('QPS 必须是 ≥0 的整数（0 表示关闭限流）');
  }
  _setStmt.run('key_rate_limit_qps', String(n));
  _cache.key_rate_limit_qps = n;
  return n;
}

// 下游连通性测试专用密钥（调本平台 /api/* 会真实计费，故用一个指定密钥）。未设置 → 空串。
function getDownstreamTestKey() {
  if (_cache.downstream_test_key !== undefined) return _cache.downstream_test_key;
  const raw = _readRaw('downstream_test_key');
  _cache.downstream_test_key = raw === undefined ? '' : raw;
  return _cache.downstream_test_key;
}

function setDownstreamTestKey(value) {
  const v = (value === null || value === undefined) ? '' : String(value).trim();
  _setStmt.run('downstream_test_key', v);
  _cache.downstream_test_key = v;
  return v;
}

// ==================== 上游接口成本（按"上游原始接口"粒度）====================
// 成本挂在真正花钱的地方——上游的具体接口（upstream + path/api_id=N），而不是对外接口：
// 一个对外接口可能被多家上游轮流服务（候选链），一个上游接口也可能服务多个对外接口。
// 接口全集：apiRegistry 声明（含 chain 候选）+ 老接口硬编码路径（config.UPSTREAM_API_CONFIGS）。
// 声明里的 unitCost 只是出厂默认值；后台改的覆盖值存 app_settings.upstream_api_cost_overrides，
// 计费结算一律按 (实际服务上游, 上游接口) 查本表：覆盖值 → 声明默认 → 全局兜底。

// 全局兜底单价（元/成功调用），未声明默认值且未覆盖的上游接口用它，默认 0.03 元。
function getFallbackUpstreamUnitCost() {
  const raw = _readRaw('upstream_unit_cost');
  const n = raw === undefined ? 0.03 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.03;
}

const _upstreamApiKey = (upstream, api) => `${upstream}|${api}`;

// 上游接口成本默认价目表（2026-07-06 逐条确认的采购价，元/成功调用）。
// 这是默认值的第一来源（覆盖 apiRegistry 声明的 unitCost）；后台改的覆盖值仍然最优先。
const UPSTREAM_API_DEFAULT_COSTS = {
  // V5：全部 0.025
  'datadrifter|/xhs_app_api/note_detail_sync_v5_upgrade': 0.025,
  'datadrifter|/xhs_app_api/user_info_sync_v4': 0.025,
  'datadrifter|/xhs_app_api/user_posted_sync_v5': 0.025,
  'datadrifter|/xhs_app_api/search_sync_v5': 0.025,
  'datadrifter|/xhs_app_api/comment_sort_sync_v5': 0.025,
  'datadrifter|/xhs_app_api/comment_sync_v5': 0.025,
  'datadrifter|/xhs_app_api/sub_comment_sync_v5': 0.025,
  'datadrifter|/xhs_app_api/topic_sync_v5': 0.025,
  // 蒲公英（pgy_api/*，2026-07-12 接入）：同账号同服务器，成本与其余 V5 接口一致，全部 0.025
  'datadrifter|/pgy_api/pgy_author_info_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_author_data_performance_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_author_growth_performance_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_author_notes_list_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_author_promotion_cost_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_blogger_list_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_core_metrics_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_data_overview_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_fans_growth_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_fans_tags_sync_v3': 0.025,
  'datadrifter|/pgy_api/pgy_note_detail_sync_v3': 0.025,
  // 星河：评论/子评论 0.02，其余 0.03
  'xingyin|/xhsapi/note': 0.03,
  'xingyin|/xhsapi/v2/app_user_info': 0.03,
  'xingyin|/xhsapi/v2/app_user_posted': 0.03,
  'xingyin|/xhsapi/app_search': 0.03,
  'xingyin|/xhsapi/video_note': 0.03,
  'xingyin|/xhsapi/comment': 0.02,
  'xingyin|/xhsapi/sub_comments': 0.02,
  'xingyin|/xhsapi/tag_notes': 0.03,
  // Matcha：一级/二级评论（APP 103/104，Web 11/12）0.02，其余 0.04
  'matcha|api_id=102': 0.04,
  'matcha|api_id=106': 0.04,
  'matcha|api_id=105': 0.04,
  'matcha|api_id=101': 0.04,
  'matcha|api_id=103': 0.02,
  'matcha|api_id=104': 0.02,
  'matcha|api_id=11': 0.02,
  'matcha|api_id=12': 0.02,
  'matcha|api_id=7': 0.04,
  'matcha|api_id=10': 0.04,
  'matcha|api_id=9': 0.04,
  'matcha|api_id=19': 0.04,
  'matcha|api_id=16': 0.04,
  'matcha|api_id=18': 0.04,
  'matcha|api_id=20': 0.04,
  'matcha|api_id=31': 0.04,
  // TikHub 小红书：全部 0.072
  'tikhub|/search_products': 0.072,
  'tikhub|/get_product_detail': 0.072,
  'tikhub|/get_product_reviews': 0.072,
  'tikhub|https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_user_info': 0.072,
  'tikhub|/get_user_posted_notes': 0.072,
  'tikhub|/get_topic_info': 0.072,
  'tikhub|/get_image_note_detail': 0.072,
  'tikhub|/get_video_note_detail': 0.072,
  'tikhub|/get_note_comments': 0.072,
  'tikhub|/get_note_sub_comments': 0.072,
  'tikhub|/get_user_faved_notes': 0.072,
  'tikhub|/get_topic_feed': 0.072,
  'tikhub|/search_notes': 0.072,
  'tikhub|/search_users': 0.072,
  // TikHub 抖音：全部 0.0072
  'tikhub|https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video_v3': 0.0072,
  'tikhub|https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comments': 0.0072,
  'tikhub|https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comment_replies': 0.0072,
  'tikhub|https://api.tikhub.io/api/v1/douyin/app/v3/handler_user_profile': 0.0072,
  'tikhub|https://api.tikhub.io/api/v1/douyin/app/v3/fetch_user_post_videos': 0.0072,
  'tikhub|https://api.tikhub.io/api/v1/douyin/search/fetch_general_search_v2': 0.0072,
};

// 老接口（硬编码在 userApi.js）的上游接口 → 对外接口名，仅用于后台展示"用在哪"
const _OLD_ENDPOINT_TYPES = {
  video_note: 'get_note_detail_video',
  comment: 'get_note_comment',
  sub_comments: 'get_note_sub_comment',
  tag_notes: 'tag_notes'
};

// 上游接口全集（启动时构建，key -> { upstream, api, defaultCost, usedBy, sample }）
// sample = 该物理上游接口的一份代表性调用样本（method/path/apiId/params/mapParams），供「上游 API 测试」
// 页直接复用——同一个物理接口可能被多个对外接口共用（如老版本/V1 版本走同一条候选链），
// 调用方式（怎么拼参数）对物理接口而言是同一件事，只取第一次见到的样本即可，
// 这样「上游接口测试」和「上游接口成本」两处永远是同一份 (upstream, 原生接口) 全集，不会看到重复/对不上的条目。
const UPSTREAM_API_REGISTRY = (() => {
  const map = new Map();
  const add = (upstream, api, defaultCost, type, name, sample) => {
    if (!upstream || !api) return;
    const key = _upstreamApiKey(upstream, api);
    let entry = map.get(key);
    if (!entry) {
      entry = { upstream, api, defaultCost: null, usedBy: new Map(), sample: null };
      map.set(key, entry);
    }
    if (typeof defaultCost === 'number' && entry.defaultCost === null) entry.defaultCost = defaultCost;
    if (type) entry.usedBy.set(type, name || type);
    if (sample && !entry.sample) entry.sample = sample;
  };
  try {
    const { ENDPOINTS } = require('../apiRegistry');
    for (const ep of ENDPOINTS) {
      if (Array.isArray(ep.chain) && ep.chain.length) {
        for (const c of ep.chain) {
          add(c.upstream, c.path || (c.apiId ? `api_id=${c.apiId}` : ''), c.unitCost, ep.type, ep.name, {
            method: ep.method || 'GET', path: c.path || '', apiId: c.apiId || null,
            params: ep.params || [], mapParams: c.mapParams || null
          });
        }
      } else {
        add(ep.upstream || 'xingyin', ep.path || (ep.apiId ? `api_id=${ep.apiId}` : ''), ep.unitCost, ep.type, ep.name, {
          method: ep.method || 'GET', path: ep.path || '', apiId: ep.apiId || null,
          params: ep.params || [], mapParams: ep.mapParams || null
        });
      }
    }
  } catch (e) {
    console.error(`构建上游接口成本全集失败(注册表): ${e.message}`);
  }
  for (const [key, cfg] of Object.entries(config.UPSTREAM_API_CONFIGS || {})) {
    add(cfg.upstream || 'xingyin', cfg.url, undefined, _OLD_ENDPOINT_TYPES[key], cfg.name, {
      method: cfg.method || 'GET', path: cfg.url || '', apiId: null,
      params: (cfg.params || []).map(p => ({ name: p })), mapParams: null
    });
  }
  // 价目表覆盖声明值；表里有但全集里没有的键 = 接口改名/删除了，提示核对
  for (const [key, cost] of Object.entries(UPSTREAM_API_DEFAULT_COSTS)) {
    const entry = map.get(key);
    if (entry) entry.defaultCost = cost;
    else console.warn(`[上游接口成本] 价目表键未匹配到任何上游接口，请核对: ${key}`);
  }
  return map;
})();

// 供「上游 API 测试」页使用：与成本表同一份 (upstream, 原生接口) 全集，每条附一个可直接发起请求的调用样本
function getUpstreamApiTestList() {
  return [...UPSTREAM_API_REGISTRY.values()].map(e => {
    const sample = e.sample || {};
    const params = sample.params || [];
    return {
      upstream: e.upstream,
      api: e.api,
      name: [...e.usedBy.values()][0] || e.api,
      used_by: [...e.usedBy.entries()].map(([type, name]) => ({ type, name })),
      method: sample.method || 'GET',
      path: sample.path || '',
      apiId: sample.apiId || null,
      params: params.map(p => (typeof p === 'string' ? p : p.name)),
      paramExamples: Object.fromEntries(params.filter(p => p && typeof p === 'object' && p.example != null).map(p => [p.name, p.example]))
    };
  });
}

// 按 (upstream, api) 取回原始注册表条目（含 sample.mapParams 函数），供 test_upstream_api 实际发起请求
function getUpstreamApiRegistryEntry(upstream, api) {
  return UPSTREAM_API_REGISTRY.get(_upstreamApiKey(upstream, api));
}

let _uacOverrides; // 内存缓存
function _loadUacOverrides() {
  if (_uacOverrides !== undefined) return _uacOverrides;
  const raw = _readRaw('upstream_api_cost_overrides');
  try { _uacOverrides = raw ? JSON.parse(raw) : {}; } catch (_) { _uacOverrides = {}; }
  return _uacOverrides;
}

// 热路径（计费结算）：按实际服务的上游接口取记账单价
function getUpstreamApiCost(upstream, api) {
  const key = _upstreamApiKey(upstream || '', api || '');
  const o = _loadUacOverrides()[key];
  if (typeof o === 'number') return o;
  const entry = UPSTREAM_API_REGISTRY.get(key);
  if (entry && typeof entry.defaultCost === 'number') return entry.defaultCost;
  return getFallbackUpstreamUnitCost();
}

// 全表（后台展示）：每个上游接口的生效单价、默认值、是否被覆盖、服务哪些对外接口
function getAllUpstreamApiCosts() {
  const ov = _loadUacOverrides();
  const fallback = getFallbackUpstreamUnitCost();
  return [...UPSTREAM_API_REGISTRY.values()].map(e => {
    const key = _upstreamApiKey(e.upstream, e.api);
    const defaultCost = typeof e.defaultCost === 'number' ? e.defaultCost : fallback;
    const isOverride = typeof ov[key] === 'number';
    return {
      upstream: e.upstream,
      api: e.api,
      cost: isOverride ? ov[key] : defaultCost,
      default_cost: defaultCost,
      is_override: isOverride,
      used_by: [...e.usedBy.entries()].map(([type, name]) => ({ type, name }))
    };
  });
}

// 设置某上游接口的成本单价；value 为 null/'' 时清除覆盖、恢复默认。返回最终生效值。
function setUpstreamApiCost(upstream, api, value) {
  const key = _upstreamApiKey(upstream, api);
  if (!upstream || !api || !UPSTREAM_API_REGISTRY.has(key)) {
    throw new Error(`未知上游接口: ${upstream || '?'} ${api || '?'}`);
  }
  const ov = _loadUacOverrides();
  if (value === null || value === undefined || String(value).trim() === '') {
    delete ov[key];
  } else {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('上游成本单价必须是 ≥0 的数字');
    ov[key] = Math.round(n * 10000) / 10000;
  }
  _setStmt.run('upstream_api_cost_overrides', JSON.stringify(ov));
  return getUpstreamApiCost(upstream, api);
}

// ==================== 接口最小调用间隔限流（三级：全局 / 用户 / 密钥）====================
// 规则存 throttle_rules 表：(scope, scope_id, endpoint) -> interval_seconds。
//   scope='global' (scope_id='')      → 对所有用户和密钥的该接口生效（一键全局）
//   scope='user'   (scope_id=user_id) → 对该用户名下所有密钥的该接口生效
//   scope='auth'   (scope_id=密钥)    → 对该密钥的该接口生效
// 优先级（取最先命中）：密钥级 > 用户级 > 全局。interval_seconds 秒内该密钥对该接口只放行一次。
// 全量规则常驻内存（条目很少），热路径零 DB 开销；增删改同步更新内存与库。
const SCOPES = ['global', 'user', 'auth'];
const _throttle = new Map(); // key: `${scope}|${scope_id}|${endpoint}` -> interval_seconds(>0)
const _tkey = (scope, scopeId, endpoint) => `${scope}|${scopeId || ''}|${endpoint}`;

(function loadThrottles() {
  try {
    // 旧表 auth_endpoint_throttle（仅密钥级）一次性迁移到 throttle_rules
    try {
      const old = db.prepare('SELECT authorization, endpoint, interval_seconds FROM auth_endpoint_throttle').all();
      for (const r of old) {
        if (r.interval_seconds > 0) {
          db.prepare(`INSERT INTO throttle_rules(scope, scope_id, endpoint, interval_seconds)
            VALUES('auth', ?, ?, ?) ON CONFLICT(scope, scope_id, endpoint) DO NOTHING`)
            .run(r.authorization, r.endpoint, r.interval_seconds);
        }
      }
      db.prepare('DELETE FROM auth_endpoint_throttle').run();
    } catch (_) { /* 旧表不存在则忽略 */ }

    const rows = db.prepare('SELECT scope, scope_id, endpoint, interval_seconds FROM throttle_rules').all();
    for (const r of rows) {
      if (r.interval_seconds > 0) _throttle.set(_tkey(r.scope, r.scope_id, r.endpoint), r.interval_seconds);
    }
  } catch (e) {
    console.error(`加载接口频率配置失败: ${e.message}`);
  }
})();

// 热路径调用：解析 (密钥, 用户, 接口) 的最小间隔秒数。密钥级 > 用户级 > 全局；0 = 不限。
function getAuthEndpointInterval(authorization, userId, endpoint) {
  let v = _throttle.get(_tkey('auth', authorization, endpoint));
  if (v > 0) return v;
  if (userId) {
    v = _throttle.get(_tkey('user', userId, endpoint));
    if (v > 0) return v;
  }
  v = _throttle.get(_tkey('global', '', endpoint));
  return v > 0 ? v : 0;
}

// 设置/更新某 scope 的某接口间隔；interval<=0 视为删除该条。返回最终生效秒数。
function setThrottleRule(scope, scopeId, endpoint, intervalSeconds) {
  if (!SCOPES.includes(scope)) throw new Error('scope 必须是 global / user / auth');
  if (scope !== 'global' && !scopeId) throw new Error('user/auth 级必须指定 scope_id');
  if (!endpoint) throw new Error('缺少 endpoint');
  const sid = scope === 'global' ? '' : scopeId;
  const n = parseInt(intervalSeconds, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error('间隔必须是 ≥0 的整数（0 表示取消该限制）');
  const k = _tkey(scope, sid, endpoint);
  if (n === 0) {
    db.prepare('DELETE FROM throttle_rules WHERE scope=? AND scope_id=? AND endpoint=?').run(scope, sid, endpoint);
    _throttle.delete(k);
    return 0;
  }
  db.prepare(`INSERT INTO throttle_rules(scope, scope_id, endpoint, interval_seconds)
    VALUES(?, ?, ?, ?) ON CONFLICT(scope, scope_id, endpoint) DO UPDATE SET interval_seconds = excluded.interval_seconds`)
    .run(scope, sid, endpoint, n);
  _throttle.set(k, n);
  return n;
}

// 列出某 scope+scope_id 的全部接口配置（endpoint -> interval）。
function getThrottleRules(scope, scopeId) {
  if (!SCOPES.includes(scope)) throw new Error('scope 必须是 global / user / auth');
  const sid = scope === 'global' ? '' : (scopeId || '');
  const out = {};
  const prefix = `${scope}|${sid}|`;
  for (const [k, v] of _throttle.entries()) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

// 删除某 scope+scope_id 的全部配置（删用户/密钥时清理）。
function deleteThrottleScope(scope, scopeId) {
  const sid = scope === 'global' ? '' : (scopeId || '');
  if (scope !== 'global' && !sid) return;
  db.prepare('DELETE FROM throttle_rules WHERE scope=? AND scope_id=?').run(scope, sid);
  const prefix = `${scope}|${sid}|`;
  for (const k of [..._throttle.keys()]) if (k.startsWith(prefix)) _throttle.delete(k);
}

// ==================== 接口默认价格（创建密钥/用户时的初始价，可在系统设置里改）====================
// 覆盖值存 app_settings 的 default_price_overrides（JSON: {endpoint: price}）。
// 未覆盖的接口回落到 config.DEFAULT_PRICES。只改价格，不改接口集合。
let _dpOverrides; // 内存缓存
function _loadDpOverrides() {
  if (_dpOverrides !== undefined) return _dpOverrides;
  const raw = _readRaw('default_price_overrides');
  try { _dpOverrides = raw ? JSON.parse(raw) : {}; } catch (_) { _dpOverrides = {}; }
  return _dpOverrides;
}

// 单接口默认价（计费兜底用，热路径）
function getDefaultPrice(endpoint) {
  const o = _loadDpOverrides()[endpoint];
  return (typeof o === 'number') ? o : (config.DEFAULT_PRICES[endpoint] ?? 0);
}

// 全部接口默认价（config 打底 + 覆盖值），用于创建用户/密钥、后台展示
function getAllDefaultPrices() {
  const merged = { ...config.DEFAULT_PRICES };
  for (const [k, v] of Object.entries(_loadDpOverrides())) if (typeof v === 'number') merged[k] = v;
  return merged;
}

// 设置某接口默认价；落库 + 更新缓存。price 必须 ≥0。
function setDefaultPrice(endpoint, price) {
  if (!endpoint) throw new Error('缺少 endpoint');
  if (!(endpoint in config.DEFAULT_PRICES)) throw new Error(`未知接口: ${endpoint}`);
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) throw new Error('价格必须是 ≥0 的数字');
  const ov = _loadDpOverrides();
  ov[endpoint] = Math.round(n * 10000) / 10000;
  _setStmt.run('default_price_overrides', JSON.stringify(ov));
  return ov[endpoint];
}

// ==================== 接口状态（健康 / 风控，文档页展示用，可在系统设置里改）====================
// 存 app_settings 的 endpoint_status_overrides（JSON: {endpoint: 'risk'}）。
// 默认全部为 'healthy'，只把被标记为 'risk' 的接口存进去（省空间）。
const STATUS_HEALTHY = 'healthy';
const STATUS_RISK = 'risk';
let _statusOverrides; // 内存缓存
function _loadStatusOverrides() {
  if (_statusOverrides !== undefined) return _statusOverrides;
  const raw = _readRaw('endpoint_status_overrides');
  try { _statusOverrides = raw ? JSON.parse(raw) : {}; } catch (_) { _statusOverrides = {}; }
  return _statusOverrides;
}

// 单接口状态：'healthy' | 'risk'，默认 healthy
function getEndpointStatus(endpoint) {
  return _loadStatusOverrides()[endpoint] === STATUS_RISK ? STATUS_RISK : STATUS_HEALTHY;
}

// 全部已知接口的状态（以 config.DEFAULT_PRICES 为接口全集，未标记的为 healthy）
function getAllEndpointStatuses() {
  const ov = _loadStatusOverrides();
  const out = {};
  for (const ep of Object.keys(config.DEFAULT_PRICES)) {
    out[ep] = ov[ep] === STATUS_RISK ? STATUS_RISK : STATUS_HEALTHY;
  }
  return out;
}

// 设置某接口状态；落库 + 更新缓存。status 仅接受 'healthy' | 'risk'。
function setEndpointStatus(endpoint, status) {
  if (!endpoint) throw new Error('缺少 endpoint');
  if (!(endpoint in config.DEFAULT_PRICES)) throw new Error(`未知接口: ${endpoint}`);
  const s = status === STATUS_RISK ? STATUS_RISK : STATUS_HEALTHY;
  const ov = _loadStatusOverrides();
  if (s === STATUS_HEALTHY) delete ov[endpoint]; else ov[endpoint] = STATUS_RISK;
  _setStmt.run('endpoint_status_overrides', JSON.stringify(ov));
  return s;
}

module.exports = {
  getRateLimitQps, setRateLimitQps, getDownstreamTestKey, setDownstreamTestKey,
  getUpstreamApiCost, getAllUpstreamApiCosts, setUpstreamApiCost, getFallbackUpstreamUnitCost,
  getUpstreamApiTestList, getUpstreamApiRegistryEntry,
  getAuthEndpointInterval, setThrottleRule, getThrottleRules, deleteThrottleScope,
  getDefaultPrice, getAllDefaultPrices, setDefaultPrice,
  getEndpointStatus, getAllEndpointStatuses, setEndpointStatus
};
