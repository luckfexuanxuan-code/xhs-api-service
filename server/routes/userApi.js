/**
 * 用户API路由
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../config');
const { checkBalanceAndCharge } = require('../middleware/auth');
const { db, dataStore, roundBalance, cleanResponseData, flushCallLogs, flushUsageStatistics, getAuthCurrentBalance } = require('../utils/dataManager');
const { getUsageSummary, listCallLogsPage } = require('../utils/accountUsage');
const { getAllDefaultPrices, getAllEndpointStatuses } = require('../utils/settings');
const { recordUpstreamBalance } = require('../utils/upstreamBalance');

// 公开接口：返回各接口默认价（供用户文档页同步展示，无需鉴权）
router.get('/prices', (req, res) => {
  try {
    return res.json({ message: '成功', data: getAllDefaultPrices() });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 公开接口：返回各接口状态（'healthy' | 'risk'，供用户文档页展示状态标签，无需鉴权）
router.get('/endpoint_status', (req, res) => {
  try {
    return res.json({ message: '成功', data: getAllEndpointStatuses() });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 直传 code：10200(成功) 10400(参数错误) 10503(通道繁忙)
const PASSTHROUGH_CODES = [10200, 10400, 10503];

/**
 * 统一处理上游响应
 * - 10200/10400/10503: 直接返回上游数据
 * - 其他: 清洗敏感词后返回
 */
// 把上游 code 转成下游对外码：10200→200，10400→400，10503→503 …
function normalizeCode(code) {
  if (typeof code === 'number' && code >= 10000) {
    return code - 10000;
  }
  return code;
}

function buildResponse(upstreamData, authorization, extra = {}) {
  const code = upstreamData.code;
  const outCode = normalizeCode(code);
  const balance = getAuthCurrentBalance(authorization);

  if (PASSTHROUGH_CODES.includes(code)) {
    return {
      code: outCode,
      message: code === 10200 ? '成功' : upstreamData.message || '失败',
      data: upstreamData.body,
      balance,
      ...extra
    };
  }

  // 10403/10504/10505 等：清洗敏感词
  const cleaned = cleanResponseData(upstreamData.body);
  let msg = upstreamData.message || '服务异常';
  // 去掉联系客服相关
  msg = msg.replace(/[。，,\s]*[（(]?联系客服.*?[)）]?/gi, '').trim();
  msg = msg.replace(/客服\S*/gi, '').trim();
  if (!msg) msg = '服务异常，请稍后重试';

  return {
    code: outCode,
    message: msg,
    data: cleaned,
    balance,
    ...extra
  };
}

// 上游账户余额/额度不足检测（如 TikHub 用 HTTP 4xx + {detail:{message_zh:"余额不足..."}} 表示）
const _UPSTREAM_LOW_RE = /余额不足|余额不够|账户余额|余额已用尽|欠费|额度不足|额度已用尽|insufficient|not\s*enough\s*balance/i;

// 上游错误话术里可能夹带内部实现细节（如 "子接口调用失败: 无可用cookie"），属于我们侧的供给问题，
// 不能原样透传给下游客户（会暴露上游身份/实现，也对客户无意义）。命中则统一兜底成中性话术。
// 注意：刻意收窄到这些“供给/实现”词，避免误伤对客户有用的报错（如 xsec_token 失效、参数错误）。
const _UPSTREAM_LEAK_RE = /cookie|子接口|无可用|账号池|代理|风控|fail/i;
function sanitizeUpstreamMsg(rawMsg, fallback = '服务繁忙，请稍后再试') {
  if (!rawMsg || typeof rawMsg !== 'string') return fallback;
  return _UPSTREAM_LEAK_RE.test(rawMsg) ? fallback : rawMsg;
}
let _ubLowWarnAt = 0; // 告警节流（秒）
function _warnUpstreamLowBalance(detail) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - _ubLowWarnAt >= 30) {
    _ubLowWarnAt = nowSec;
    console.error(`[上游余额不足] 上游账户余额/额度不足，客户调用已自动退费，请尽快给上游充值！上游原文: ${String(detail).slice(0, 120)}`);
  }
}

function buildUpstreamError(error, authorization) {
  // 统一成中性话术，不暴露 axios 内部信息（如 "Request failed with status code 502"）或供应商身份
  let msg;
  if (error.code === 'ECONNABORTED') {
    msg = '服务响应超时，请稍后重试';
  } else if (error.response) {
    // 上游返回了非 2xx。先看错误体里是不是“余额不足”，是则告警提醒充值（客户仍只看到中性话术）
    const body = error.response.data;
    const text = typeof body === 'string' ? body : JSON.stringify(body || '');
    if (_UPSTREAM_LOW_RE.test(text)) {
      _warnUpstreamLowBalance(text);
      msg = '服务繁忙，请稍后再试';
    } else {
      msg = error.response.status >= 500 ? '服务繁忙，请稍后再试' : '请求失败，请检查参数后重试';
    }
  } else {
    msg = '网络异常，请稍后重试';
  }
  return {
    message: '失败',
    error: msg,
    balance: roundBalance(dataStore.usersBalance[authorization] || 0)
  };
}

async function sendUpstreamRequest(req, res, options) {
  const authorization = req.headers['authorization'];
  const upstreamKey = options.upstream || 'xingyin';
  const upstream = config.UPSTREAMS[upstreamKey];
  if (!upstream) {
    return res.status(500).json({ message: '失败', error: '服务暂时不可用，请稍后再试' });
  }

  try {
    const response = await axios({
      method: options.method || 'GET',
      url: `${upstream.baseURL}${options.path}`,
      params: options.params,
      data: options.body,
      headers: {
        'Authorization': upstream.authorization,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      timeout: config.REQUEST_TIMEOUT
    });

    const upstreamData = response.data;
    // 拦截上游余额（星河：顶层 balanceString + balance(厘，÷1000=元)）
    if (upstreamData && upstreamData.balanceString) {
      const num = typeof upstreamData.balance === 'number' ? upstreamData.balance / 1000 : null;
      recordUpstreamBalance(upstreamKey, num, upstreamData.balanceString);
    }
    const extra = typeof options.extra === 'function' ? options.extra(upstreamData) : (options.extra || {});
    const body = buildResponse(upstreamData, authorization, extra);
    body._servedUpstream = upstreamKey;   // 调用日志的"上游/上游接口"列（中间件记录后删除）
    body._servedApi = options.path || '';
    return res.json(body);
  } catch (e) {
    return res.status(500).json(buildUpstreamError(e, authorization));
  }
}

// ==================== Matcha 上游适配器 ====================
// Matcha 的协议与星河不同：统一 POST /v1/call，body={api_id, params}，Bearer 认证。
// 把 Matcha 的响应归一化成平台统一结构 { code, message, data, balance }，
// 让计费中间件按 message==='成功' && data 非空 来决定扣费/退费。
//
// Matcha 有三种返回结构，本函数统一归一化：
// (1) 旧三层嵌套（小红书类）：
//   { code:200, msg, data:{ success:true, message,
//       data:{ api_id, api_name, cost, balance, call_time, sub_api_response:{ code, msg, data: 业务数据 } } } }
// (2) 扁平一层（小红书类，2026-06 起）：
//   { code:200, msg, data:{ api_id, api_name, cost, balance, call_time, sub_api_response:{ code, msg, data: 业务数据 } } }
// (3) APP端（api_id 101-107）：无 sub_api_response 包装，data 直接就是业务数据（对象或数组）：
//   { code:200, msg, data: [ {user, note_list, comment_list}, ... ] }
// 注意：data 里的 balance/cost 是平台在 Matcha 的余额/成本，绝不能透传给客户。
// 业务载荷是否“空”（null / 空数组 / 空对象）。用于详情类接口判定“资源不存在”。
function isEmptyPayload(d) {
  if (d === undefined || d === null) return true;
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d === 'object') return Object.keys(d).length === 0;
  return false;
}

// 从 Matcha 响应里提取“本次上游对我方的扣费额”cost（>0 表示上游真扣了我们）。
// 扁平结构在顶层 outer.cost；三层结构在 data.cost 或 data.data.cost。
function matchaCost(outer) {
  if (typeof outer.cost === 'number') return outer.cost;
  const lvl1 = outer.data;
  if (lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1)) {
    if (typeof lvl1.cost === 'number') return lvl1.cost;
    const nested = lvl1.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested) && typeof nested.cost === 'number') return nested.cost;
  }
  return null;
}

// 包装：在归一化结果上附带 _upstreamCost（上游对我方扣费额）。计费中间件据此实现
// “上游扣了我们 → 就向客户收费”（即使结果为空/未找到）。_upstreamCost 会在返回客户前被删除。
function buildMatchaResponse(upstreamData, authorization, ep) {
  const r = buildMatchaResponseInner(upstreamData, authorization, ep);
  const cost = matchaCost(upstreamData || {});
  if (typeof cost === 'number') r._upstreamCost = cost;
  return r;
}

// ep.notFoundMsg：详情类接口专用。资源不存在/获取失败时，返回干净的业务提示（如“笔记不存在或已删除”）
// 直接传给客户，而不是被 sanitize 成“服务繁忙”或返回“成功+空数据”。code 用 404。
function buildMatchaResponseInner(upstreamData, authorization, ep) {
  const balance = roundBalance(getAuthCurrentBalance(authorization));
  const notFoundMsg = ep && ep.notFoundMsg;
  const outer = upstreamData || {};
  const lvl1 = outer.data;
  const lvl1Obj = (lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1)) ? lvl1 : null;

  // 定位业务子响应 sub_api_response：扁平结构在 data 层，旧三层在 data.data 层。
  // APP端没有 sub_api_response（保持 sub=null，走 APP端分支）。
  let sub = null;
  if (lvl1Obj) {
    if (lvl1Obj.sub_api_response) sub = lvl1Obj.sub_api_response;
    else if (lvl1Obj.data && typeof lvl1Obj.data === 'object' && !Array.isArray(lvl1Obj.data) && lvl1Obj.data.sub_api_response) {
      sub = lvl1Obj.data.sub_api_response;
    }
  }

  // 外层失败：外层 code!==200，或旧三层 wrapper success===false
  const wrapperOk = !lvl1Obj || lvl1Obj.success === undefined || lvl1Obj.success === true;
  if (Number(outer.code) !== 200 || !wrapperOk) {
    // 详情类：上游获取失败即视为“资源不存在”，返回干净提示
    if (notFoundMsg) return { code: 404, message: notFoundMsg, data: null, balance };
    const rawMsg = (sub && (sub.msg || sub.message)) || (lvl1Obj && (lvl1Obj.message || lvl1Obj.msg)) || outer.message || outer.msg;
    return { code: Number(sub && sub.code) || Number(outer.code) || 503, message: sanitizeUpstreamMsg(rawMsg), data: null, balance };
  }

  if (sub) {
    // 小红书类：业务结果在 sub_api_response 里
    if (Number(sub.code) !== 200) {
      if (notFoundMsg) return { code: 404, message: notFoundMsg, data: null, balance };
      return { code: Number(sub.code) || 503, message: sanitizeUpstreamMsg(sub.msg || sub.message || outer.msg), data: null, balance };
    }
    // 成功：返回 sub.data 作为载荷；sub.data 为空则原样返回 sub（让计费中间件按“数据无效”退费）。
    const payload = (sub.data !== undefined && sub.data !== null) ? sub.data : sub;
    if (notFoundMsg && isEmptyPayload(payload)) return { code: 404, message: notFoundMsg, data: null, balance };
    return { code: 200, message: '成功', data: payload, balance };
  }

  // APP端：data 本身就是业务数据（对象/数组），外层 code===200 即成功
  const appPayload = (lvl1 !== undefined ? lvl1 : null);
  if (notFoundMsg && isEmptyPayload(appPayload)) return { code: 404, message: notFoundMsg, data: null, balance };
  return { code: 200, message: '成功', data: appPayload, balance };
}

async function sendMatchaRequest(req, res, ep, input) {
  const authorization = req.headers['authorization'];
  const upstream = config.UPSTREAMS[ep.upstream];
  if (!upstream) return res.status(500).json({ message: '失败', error: '服务暂时不可用，请稍后再试' });

  // 客户参数 → 上游参数（不写 mapParams 则按声明的 name 原样透传）
  const params = typeof ep.mapParams === 'function'
    ? ep.mapParams(input)
    : Object.fromEntries((ep.params || []).map(p => [p.name, input[p.name]]).filter(([, v]) => v !== undefined && v !== ''));

  try {
    const response = await axios({
      method: 'POST',
      url: `${upstream.baseURL}/v1/call`,
      data: { api_id: ep.apiId, params },
      headers: { 'Authorization': `Bearer ${upstream.authorization}`, 'Content-Type': 'application/json' },
      timeout: config.REQUEST_TIMEOUT
    });
    // 拦截 Matcha 余额（三层结构里的 data.data.balance，已是元）
    const d = response.data || {};
    const lvl1 = d.data || {};
    const nested = lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1) ? lvl1.data : null;
    const meta = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested
      : (lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1) ? lvl1 : {});
    const mb = typeof meta.balance === 'number' ? meta.balance : (typeof d.balance === 'number' ? d.balance : undefined);
    if (typeof mb === 'number') recordUpstreamBalance(ep.upstream, mb, mb.toFixed(2) + '元');
    const body = buildMatchaResponse(response.data, authorization, ep);
    body._servedUpstream = ep.upstream;   // 成本走 _upstreamCost（Matcha 实际扣费额）
    body._servedApi = ep.apiId ? `api_id=${ep.apiId}` : '';
    return res.json(body);
  } catch (e) {
    return res.status(500).json(buildUpstreamError(e, authorization));
  }
}

// ==================== TikHub 上游适配器 ====================
// 协议：GET {baseURL}{ep.path}?params，Bearer 认证。
// 响应外壳 { code:200, message_zh, request_id, support, docs, cache_url, ..., data:{真实数据} }。
// 成功看 code===200，载荷取 data；其余 TikHub 元数据（计费提示/cache链接/docs 等）全部屏蔽不外传。
function buildTikhubResponse(upstreamData, authorization, ep) {
  const balance = roundBalance(getAuthCurrentBalance(authorization));
  const notFoundMsg = ep && ep.notFoundMsg;
  const d = upstreamData || {};
  const success = Number(d.code) === 200;
  if (!success) {
    if (notFoundMsg) return { code: 404, message: notFoundMsg, data: null, balance };
    const rawMsg = d.message_zh || d.message;
    return { code: Number(d.code) || 500, message: sanitizeUpstreamMsg(rawMsg), data: null, balance };
  }
  // d.data 是 xhs/TikHub 的内层包装：剔除内部噪声字段，保留真实数据(data)与翻页字段(search_id/page/next_page 等)
  let payload = d.data;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const { code, success: _s, msg, debug_id, debug_info, ...rest } = payload;
    payload = rest;
  }
  // 详情类：业务数据为空视为“资源不存在”（真实数据在内层 payload.data）
  if (notFoundMsg) {
    const inner = (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.data !== undefined) ? payload.data : payload;
    if (isEmptyPayload(inner)) return { code: 404, message: notFoundMsg, data: null, balance };
  }
  return { code: 200, message: '成功', data: (payload !== undefined ? payload : null), balance };
}

async function sendTikhubRequest(req, res, ep, input) {
  const authorization = req.headers['authorization'];
  const upstream = config.UPSTREAMS[ep.upstream];
  if (!upstream) return res.status(500).json({ message: '失败', error: '服务暂时不可用，请稍后再试' });

  const params = typeof ep.mapParams === 'function'
    ? ep.mapParams(input)
    : Object.fromEntries((ep.params || []).map(p => [p.name, input[p.name]]).filter(([, v]) => v !== undefined && v !== ''));

  try {
    const url = /^https?:\/\//i.test(ep.path || '') ? ep.path : `${upstream.baseURL}${ep.path}`;
    // TikHub：GET 接口参数走 query；POST 接口（如抖音综合搜索）参数走 JSON body。
    const method = (ep.method || 'GET').toUpperCase();
    const response = await axios({
      method,
      url,
      ...(method === 'POST'
        ? { data: params, headers: { 'Authorization': `Bearer ${upstream.authorization}`, 'Content-Type': 'application/json' } }
        : { params, headers: { 'Authorization': `Bearer ${upstream.authorization}` } }),
      timeout: config.REQUEST_TIMEOUT
    });
    const body = buildTikhubResponse(response.data, authorization, ep);
    body._servedUpstream = ep.upstream;
    body._servedApi = ep.path || '';
    return res.json(body);
  } catch (e) {
    // 详情类：上游对不存在/非法的 ID 多返回 4xx，归一化成干净的“资源不存在”提示直传客户
    if (ep && ep.notFoundMsg && e.response && [400, 404, 422].includes(e.response.status)) {
      return res.json({ code: 404, message: ep.notFoundMsg, data: null, balance: roundBalance(getAuthCurrentBalance(authorization)), _servedUpstream: ep.upstream, _servedApi: ep.path || '' });
    }
    return res.status(500).json(buildUpstreamError(e, authorization));
  }
}

// ==================== V5 上游适配器 ====================
// 协议：POST {baseURL}{ep.path}，JSON body，X-API-KEY 认证。
// 计费为点数制，1000点=1元：实测成功一律 25点/次 = 0.025元/次，失败不扣。对外统一按元显示。
// 成功判定兼容两种约定：多数接口 code===200；用户信息V4 为 code===0 && success===true。
// 载荷默认取 data；各接口包装层级不一（如详情升级版业务核心在 data.data.result.data），
// 注册接口时可用 ep.unwrap(data) 剥到业务核心，保证与其他同构上游返回一致。
function buildV5Response(upstreamData, authorization, ep) {
  const balance = roundBalance(getAuthCurrentBalance(authorization));
  const notFoundMsg = ep && ep.notFoundMsg;
  const d = upstreamData || {};
  const code = Number(d.code);
  const success = code === 200 || (code === 0 && d.success !== false);
  if (!success) {
    if (notFoundMsg) return { code: 404, message: notFoundMsg, data: null, balance };
    let msg = sanitizeUpstreamMsg(d.msg || d.message);
    msg = msg.replace(/[，,\s]*(或)?联系管理员/g, '').trim() || '服务繁忙，请稍后再试';
    return { code: code || 503, message: msg, data: null, balance };
  }
  let payload = d.data;
  if (ep && typeof ep.unwrap === 'function') {
    try { payload = ep.unwrap(payload); } catch (_) {}
  }
  if (notFoundMsg && isEmptyPayload(payload)) {
    // 资源不存在：上游对"查了但没有"同样收费（如 V5 墓碑响应也扣点）→ 声明了 unitCost 的接口照常向客户计费
    const r = { code: 404, message: notFoundMsg, data: null, balance };
    if (ep && typeof ep.unitCost === 'number' && ep.unitCost > 0) r._upstreamCost = ep.unitCost;
    return r;
  }
  return { code: 200, message: '成功', data: (payload !== undefined ? payload : null), balance };
}

// V5 数据响应里不带余额，用免费的 /login 查点数（V5 余额接口可无限查询，无需节流；异步不阻塞客户请求）。
// 点数换算成元入库（1000点=1元），与其他上游余额统一按元展示。
function refreshV5Points(upstream) {
  if (!upstream || !upstream.loginUsername) return;
  axios.post(`${upstream.baseURL}/login`,
    { username: upstream.loginUsername, password: upstream.loginPassword },
    { timeout: 10000 }
  ).then(r => {
    const pts = r.data && r.data.points;
    if (typeof pts === 'number') {
      const yuan = pts / 1000;
      recordUpstreamBalance('datadrifter', yuan, `${yuan.toFixed(2)}元`);
    }
  }).catch(() => {});
}

// 定时刷新：每 60 秒查一次，V5 没有流量时仪表盘余额也保持新鲜；启动时立即查一次
if (config.UPSTREAMS.datadrifter && config.UPSTREAMS.datadrifter.loginUsername) {
  const _v5Timer = setInterval(() => refreshV5Points(config.UPSTREAMS.datadrifter), 60 * 1000);
  if (_v5Timer.unref) _v5Timer.unref();
  refreshV5Points(config.UPSTREAMS.datadrifter);
}

async function sendV5Request(req, res, ep, input) {
  const authorization = req.headers['authorization'];
  const upstream = config.UPSTREAMS[ep.upstream];
  if (!upstream) return res.status(500).json({ message: '失败', error: '服务暂时不可用，请稍后再试' });

  const params = typeof ep.mapParams === 'function'
    ? ep.mapParams(input)
    : Object.fromEntries((ep.params || []).map(p => [p.name, input[p.name]]).filter(([, v]) => v !== undefined && v !== ''));

  try {
    const response = await axios({
      method: 'POST',
      url: `${upstream.baseURL}${ep.path}`,
      data: params,
      headers: { 'X-API-KEY': upstream.authorization, 'Content-Type': 'application/json' },
      timeout: upstream.timeoutMs || config.REQUEST_TIMEOUT
    });
    refreshV5Points(upstream);
    const body = buildV5Response(response.data, authorization, ep);
    body._servedUpstream = ep.upstream;
    body._servedApi = ep.path || '';
    return res.json(body);
  } catch (e) {
    return res.status(500).json(buildUpstreamError(e, authorization));
  }
}

// ==================== V6 上游适配器（2026-07-11 加）====================
// 协议：GET {baseURL}{ep.path}，参数走 query string，X-API-Key 头认证（不带 Bearer 前缀，跟星河/TikHub 不同）。
// 成功统一 code:0（跟 V5 的 200/0 混用不同，V6 目前实测全部端点成功都是 code:0，失败是 400/401 等真实HTTP语义码）。
// C端接口暂不对外公开文档（static/index.html 不展示 _v6 后缀的接口），仅供内部验证阶段调用。
function buildV6Response(upstreamData, authorization, ep) {
  const balance = roundBalance(getAuthCurrentBalance(authorization));
  const notFoundMsg = ep && ep.notFoundMsg;
  const d = upstreamData || {};
  const code = Number(d.code);
  const success = code === 0;
  if (!success) {
    if (notFoundMsg) return { code: 404, message: notFoundMsg, data: null, balance };
    const msg = sanitizeUpstreamMsg(d.msg || d.message);
    return { code: code || 503, message: msg || '服务繁忙，请稍后再试', data: null, balance };
  }
  let payload = d.data;
  if (ep && typeof ep.unwrap === 'function') {
    try { payload = ep.unwrap(payload); } catch (_) {}
  }
  if (notFoundMsg && isEmptyPayload(payload)) {
    const r = { code: 404, message: notFoundMsg, data: null, balance };
    if (ep && typeof ep.unitCost === 'number' && ep.unitCost > 0) r._upstreamCost = ep.unitCost;
    return r;
  }
  return { code: 200, message: '成功', data: (payload !== undefined ? payload : null), balance };
}

async function sendV6Request(req, res, ep, input) {
  const authorization = req.headers['authorization'];
  const upstream = config.UPSTREAMS[ep.upstream];
  if (!upstream) return res.status(500).json({ message: '失败', error: '服务暂时不可用，请稍后再试' });

  const params = typeof ep.mapParams === 'function'
    ? ep.mapParams(input)
    : Object.fromEntries((ep.params || []).map(p => [p.name, input[p.name]]).filter(([, v]) => v !== undefined && v !== ''));

  try {
    const response = await axios({
      method: 'GET',
      url: `${upstream.baseURL}${ep.path}`,
      params,
      headers: { 'X-API-Key': upstream.authorization },
      timeout: upstream.timeoutMs || config.REQUEST_TIMEOUT
    });
    const body = buildV6Response(response.data, authorization, ep);
    body._servedUpstream = ep.upstream;
    body._servedApi = ep.path || '';
    refreshSwaggerBalance(upstream);
    return res.json(body);
  } catch (e) {
    return res.status(500).json(buildUpstreamError(e, authorization));
  }
}

// swagger 余额查询走 GET /api/v1/balance（免费，不计费），直接返回元，不用像 V5 那样点数换算。
// 每次成功调用顺手刷新一次 + 定时兜底（无流量时仪表盘余额也保持新鲜），跟 refreshV5Points 同一个模式。
function refreshSwaggerBalance(upstream) {
  if (!upstream) return;
  axios.get(`${upstream.baseURL}/api/v1/balance`, {
    headers: { 'X-API-Key': upstream.authorization },
    timeout: 10000
  }).then(r => {
    const bal = r.data && r.data.data && r.data.data.balance;
    if (typeof bal === 'number') {
      recordUpstreamBalance('swagger', bal, `${bal.toFixed(2)}元`);
    }
  }).catch(() => {});
}
if (config.UPSTREAMS.swagger) {
  const _swaggerTimer = setInterval(() => refreshSwaggerBalance(config.UPSTREAMS.swagger), 60 * 1000);
  if (_swaggerTimer.unref) _swaggerTimer.unref();
  refreshSwaggerBalance(config.UPSTREAMS.swagger);
}

// ==================== 多上游候选链（故障切换）====================
// 声明了 ep.chain 的接口走这里：按序尝试候选，上游失败/超时→切下一家；
// 成功且有数据→立即返回；成功但数据为空=资源不存在→直接 404 且照常计费（不切换、不退费，
// 因为上游对"查了但没有"同样收我们的钱）；全部失败→中性话术，计费中间件自动退费。
// 每候选连续失败 3 次熔断跳过 60 秒（全被熔断则照常尝试，保证探活）。

const _chainCb = new Map();       // `${type}#${候选序号}` -> { fails, skipUntil }
const CHAIN_CB_FAILS = 3;
const CHAIN_CB_COOLDOWN_MS = 60 * 1000;
const _chainWarnAt = new Map();   // type -> 上次切换告警时间戳（5秒节流，防日志洪水）

// 候选的"具体上游接口"标识（路径或 api_id=N），用于调用日志 upstream_api 列与切换明细
function chainCandApi(cand) {
  return cand.path || (cand.apiId ? `api_id=${cand.apiId}` : '');
}

function chainWarn(type, idx, upstreamKey, why) {
  const now = Date.now();
  if (now - (_chainWarnAt.get(type) || 0) < 5000) return;
  _chainWarnAt.set(type, now);
  if (_chainWarnAt.size > 500) _chainWarnAt.clear();
  console.warn(`[上游切换] ${type}: 候选#${idx}(${upstreamKey}) 失败(${why})，尝试下一候选`);
}

// 调一次候选上游，返回 { outer } 或 { netError, errMsg }。协议按 upstream 分派，超时优先级：候选 > 上游配置 > 全局
async function callChainCandidate(cand, input) {
  const upstream = config.UPSTREAMS[cand.upstream];
  if (!upstream) return { netError: true, errMsg: '上游未配置' };
  const params = typeof cand.mapParams === 'function' ? cand.mapParams(input) : { ...input };
  const timeout = cand.timeoutMs || upstream.timeoutMs || config.REQUEST_TIMEOUT;
  try {
    let response;
    if (cand.upstream === 'matcha') {
      response = await axios({
        method: 'POST', url: `${upstream.baseURL}/v1/call`,
        data: { api_id: cand.apiId, params },
        headers: { 'Authorization': `Bearer ${upstream.authorization}`, 'Content-Type': 'application/json' },
        timeout
      });
      interceptChainMatchaBalance(response.data);
    } else if (cand.upstream === 'datadrifter') {
      // datadrifter：POST JSON + X-API-KEY，同账号下 V5/V4 两版接口都走这个协议，仅 path 版本不同
      response = await axios({
        method: 'POST', url: `${upstream.baseURL}${cand.path}`,
        data: params,
        headers: { 'X-API-KEY': upstream.authorization, 'Content-Type': 'application/json' },
        timeout
      });
      refreshV5Points(upstream);
    } else if (cand.upstream === 'swagger') {
      // swagger：GET + X-API-Key 头认证（不带Bearer前缀），跟 sendV6Request 一致
      response = await axios({
        method: 'GET', url: `${upstream.baseURL}${cand.path}`,
        params,
        headers: { 'X-API-Key': upstream.authorization },
        timeout
      });
    } else {
      // 星河风格：GET + 原始 Authorization；顺手拦截余额（balanceString + balance厘）
      response = await axios({
        method: 'GET', url: `${upstream.baseURL}${cand.path}`,
        params,
        headers: { 'Authorization': upstream.authorization },
        timeout
      });
      const ud = response.data;
      if (ud && ud.balanceString) {
        const num = typeof ud.balance === 'number' ? ud.balance / 1000 : null;
        recordUpstreamBalance(cand.upstream, num, ud.balanceString);
      }
    }
    return { outer: response.data };
  } catch (e) {
    return {
      netError: true,
      errMsg: e.code === 'ECONNABORTED' ? '超时' : (e.response ? `HTTP ${e.response.status}` : (e.code || e.message))
    };
  }
}

// Matcha 余额拦截（链内复用 sendMatchaRequest 里的同款逻辑）
function interceptChainMatchaBalance(d) {
  try {
    const lvl1 = (d || {}).data || {};
    const nested = lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1) ? lvl1.data : null;
    const meta = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested
      : (lvl1 && typeof lvl1 === 'object' && !Array.isArray(lvl1) ? lvl1 : {});
    const mb = typeof meta.balance === 'number' ? meta.balance : (typeof (d || {}).balance === 'number' ? d.balance : undefined);
    if (typeof mb === 'number') recordUpstreamBalance('matcha', mb, mb.toFixed(2) + '元');
  } catch (_) {}
}

async function sendChainRequest(req, res, ep, input) {
  const authorization = req.headers['authorization'];
  const now = Date.now();

  // 候选能力过滤：声明了 supports(input) 的候选，不支持本次请求的参数组合则直接跳过
  // （如 Matcha 101 不支持时间筛选，带 filterNoteTime 的搜索请求不进它）
  const eligible = ep.chain.map((cand, i) => ({ cand, i }))
    .filter(({ cand }) => typeof cand.supports !== 'function' || cand.supports(input));
  // 再过滤熔断中的候选；全被熔断则全量尝试（探活）——但始终尊重 supports
  let order = eligible.filter(({ i }) => { const s = _chainCb.get(`${ep.type}#${i}`); return !s || now >= s.skipUntil; });
  if (!order.length) order = eligible;

  // 切换追溯：记录每个被切换掉的候选及其失败原因，随 _chainAttempts 落到调用日志 upstream_attempts 列
  const attempts = [];

  for (let k = 0; k < order.length; k++) {
    const { cand, i } = order[k];
    const cbKey = `${ep.type}#${i}`;
    const r = await callChainCandidate(cand, input);

    let ex = null;
    if (!r.netError) {
      try { ex = cand.extractCore(r.outer); } catch (_) { ex = null; }
    }
    if (!ex || !ex.ok) {
      // 上游失败：记录尝试明细 + 熔断计数，切下一候选
      const failMsg = r.netError ? r.errMsg : ((ex && ex.msg) || '上游返回失败');
      attempts.push({
        upstream: cand.upstream,
        api: chainCandApi(cand),
        error: String(failMsg || '').slice(0, 200)
      });
      const s = _chainCb.get(cbKey) || { fails: 0, skipUntil: 0 };
      s.fails++;
      if (s.fails >= CHAIN_CB_FAILS) { s.skipUntil = Date.now() + CHAIN_CB_COOLDOWN_MS; s.fails = 0; }
      if (_chainCb.size > 1000) _chainCb.clear();
      _chainCb.set(cbKey, s);
      if (k < order.length - 1) chainWarn(ep.type, i, cand.upstream, failMsg);
      continue;
    }

    _chainCb.delete(cbKey);
    const balance = roundBalance(getAuthCurrentBalance(authorization));
    const trace = attempts.length ? { _chainAttempts: attempts } : {};
    // 资源不存在（核心为空，或 coreNotFound 判定为墓碑占位如"当前内容无法展示"）：
    // 确定性结论，不切换。上游对"查了但没有"同样收费 → 照常向客户计费
    // （_upstreamCost>0 触发计费中间件的"上游扣了我们→就向客户收费"，返回前会被删除）
    if (isEmptyPayload(ex.core) || (typeof ep.coreNotFound === 'function' && ep.coreNotFound(ex.core))) {
      return res.json({ code: 404, message: ep.notFoundMsg || '资源不存在', data: null, balance, _upstreamCost: cand.unitCost || 0.01, _servedUpstream: cand.upstream, _servedApi: chainCandApi(cand), ...trace });
    }
    const data = typeof ep.shapeData === 'function' ? ep.shapeData(ex.core, ex.raw) : ex.core;
    // 接口级附加顶层字段（如老搜索接口契约的 searchId/sessionId 翻页令牌）
    const extraFields = typeof ep.shapeExtra === 'function' ? (ep.shapeExtra(ex) || {}) : {};
    return res.json({ code: 200, message: '成功', data, balance, ...extraFields, _servedUpstream: cand.upstream, _servedApi: chainCandApi(cand), ...trace });
  }

  // 所有候选都失败：中性话术，客户自动退费（切换明细照记，便于追溯是每一家怎么失败的）
  return res.status(500).json({
    message: '失败', error: '服务繁忙，请稍后再试',
    balance: roundBalance(getAuthCurrentBalance(authorization)),
    ...(attempts.length ? { _chainAttempts: attempts } : {})
  });
}

// ==================== 集中注册表：自动注册新接口路由 ====================
function registerRegistryEndpoints() {
  let registry;
  try { registry = require('../apiRegistry'); } catch (e) { console.error('加载接口注册表失败:', e.message); return; }
  for (const ep of registry.ENDPOINTS) {
    const method = (ep.method || 'GET').toLowerCase();
    if (method !== 'get' && method !== 'post') { console.error(`接口 ${ep.type} 的 method 非法: ${ep.method}`); continue; }
    router[method](`/${ep.type}`, checkBalanceAndCharge(ep.type), async (req, res) => {
      const input = method === 'get' ? { ...req.query } : { ...req.query, ...req.body };
      // 参数校验：必填 + 格式(pattern)。校验不过返回 400，计费中间件会对 4xx 自动退费，不扣客户。
      if (Array.isArray(ep.oneOfRequired) && ep.oneOfRequired.length) {
        const hasOne = ep.oneOfRequired.some(name => {
          const v = input[name];
          return v !== undefined && v !== null && String(v).trim() !== '';
        });
        if (!hasOne) {
          return res.status(400).json({ code: 400, message: '失败', error: `${ep.oneOfRequired.join(' 或 ')} 至少传一个` });
        }
      }
      for (const p of (ep.params || [])) {
        const v = input[p.name];
        const empty = (v === undefined || v === null || v === '');
        if (p.required && empty) {
          return res.status(400).json({ code: 400, message: '失败', error: `缺少${p.name}参数` });
        }
        if (!empty && p.pattern && !p.pattern.test(String(v))) {
          // patternMsg 可自定义整句提示语；未定义则用通用格式提示。body 带 code:400 与成功(200)/不存在(404)统一
          return res.status(400).json({ code: 400, message: '失败', error: p.patternMsg || `${p.name} 格式不正确${p.patternDesc ? '（应为' + p.patternDesc + '）' : ''}` });
        }
      }
      // 多上游候选链优先（get_note_detail / get_note_detail_v1 等）：忽略单上游派发
      if (Array.isArray(ep.chain) && ep.chain.length) return sendChainRequest(req, res, ep, input);
      if (ep.upstream === 'matcha') return sendMatchaRequest(req, res, ep, input);
      if (ep.upstream === 'tikhub') return sendTikhubRequest(req, res, ep, input);
      if (ep.upstream === 'datadrifter') return sendV5Request(req, res, ep, input);
      if (ep.upstream === 'swagger') return sendV6Request(req, res, ep, input);
      // 星河风格上游（path + 原样/映射参数）
      const params = typeof ep.mapParams === 'function' ? ep.mapParams(input)
        : Object.fromEntries((ep.params || []).map(p => [p.name, input[p.name]]).filter(([, v]) => v !== undefined && v !== ''));
      return sendUpstreamRequest(req, res, {
        upstream: ep.upstream || 'xingyin',
        method: ep.method, path: ep.path,
        params: method === 'get' ? params : undefined,
        body: method === 'post' ? params : undefined
      });
    });
  }
  if (registry.ENDPOINTS.length) console.log(`[接口注册表] 已注册 ${registry.ENDPOINTS.length} 个新接口`);
}

// get_note_detail 已迁入 apiRegistry（多上游候选链 V5→星河→Matcha），由 registerRegistryEndpoints 注册

// get_note_detail_video 已迁入 apiRegistry（多上游候选链 datadrifter V4→星河），由 registerRegistryEndpoints 注册

// get_note_comment / get_note_sub_comment 已迁入 apiRegistry（多上游候选链 星河→Matcha，
// 星河服务时 body 字符串原样透传保证契约不变），由 registerRegistryEndpoints 注册

// search_note 已迁入 apiRegistry（多上游候选链 V5→星河→Matcha101，含参数词表映射与
// searchId/sessionId 顶层令牌契约），由 registerRegistryEndpoints 注册

// get_user_info 已迁入 apiRegistry（多上游候选链 V5→星河→Matcha），由 registerRegistryEndpoints 注册

// user_note_list 已迁入 apiRegistry（多上游候选链 V5→星河→Matcha），由 registerRegistryEndpoints 注册

// tag_notes 已迁入 apiRegistry（多上游候选链 V5→V4，2026-07-10 从星河单点迁出），由 registerRegistryEndpoints 注册


// ==================== 获取余额 ====================
router.get('/get_balance', async (req, res) => {
  const authorization = req.headers['authorization'];
  if (!authorization) {
    return res.status(401).json({ message: '失败', error: '缺少Authorization' });
  }
  const authInfo = dataStore.authorizations[authorization];
  if (!authInfo || !authInfo.enabled) {
    return res.status(401).json({ message: '失败', error: '无效的Authorization' });
  }

  let displayName = authInfo.name || '';
  if (authInfo.user_id) {
    const ua = dataStore.userAccounts[authInfo.user_id];
    if (ua) displayName = ua.username;
  }

  // 若该 Key 设了配额，balance 返回它的剩余配额（而非用户余额）；未设配额(不限)则返回用户/账户余额。
  const hasQuota = authInfo.quota != null;
  const balance = hasQuota ? roundBalance(authInfo.quota) : getAuthCurrentBalance(authorization);

  res.json({
    message: '成功',
    data: {
      balance,
      is_quota: hasQuota,
      name: displayName,
      created_at: authInfo.created_at || '',
      user_id: authInfo.user_id || null
    }
  });
});

function getValidAuth(req, res) {
  const authorization = req.headers['authorization'];
  if (!authorization) {
    res.status(401).json({ message: '失败', error: '缺少Authorization' });
    return null;
  }

  const authInfo = dataStore.authorizations[authorization];
  if (!authInfo || !authInfo.enabled) {
    res.status(401).json({ message: '失败', error: '无效的Authorization' });
    return null;
  }

  return { authorization, authInfo };
}

function parseLimit(value, defaultLimit = 100, maxLimit = 1000) {
  let limit = parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  return Math.min(limit, maxLimit);
}

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

// 查询当前 Authorization 的预聚合调用统计（免费，不扣费）
router.get('/get_usage_statistics', async (req, res) => {
  try {
    const auth = getValidAuth(req, res);
    if (!auth) return;

    flushUsageStatistics();
    const usage = getUsageSummary(db, auth.authorization, req.query);
    return res.json({
      message: '成功',
      data: {
        authorization: auth.authorization,
        name: auth.authInfo.name || '',
        ...usage
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 查询当前 Authorization 的调用记录（v2：游标分页，禁止无界全量读取）
router.get('/v2/call_logs', async (req, res) => {
  try {
    const auth = getValidAuth(req, res);
    if (!auth) return;

    flushCallLogs();
    const page = listCallLogsPage(db, auth.authorization, req.query);
    const records = page.records.map((row) => ({
      ...row,
      amount: roundBalance(row.amount || 0)
    }));

    return res.json({
      message: '成功',
      data: {
        authorization: auth.authorization,
        name: auth.authInfo.name || '',
        count: records.length,
        limit: page.limit,
        has_more: page.has_more,
        next_cursor: page.next_cursor,
        records
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 兼容旧客户端：保持原 get_call_logs 响应和无分页语义，待所有调用方迁移到 v2 后再单独废弃。
router.get('/get_call_logs', async (req, res) => {
  try {
    const auth = getValidAuth(req, res);
    if (!auth) return;

    flushCallLogs();
    const { start_date, end_date, endpoint, success } = req.query;
    const params = [auth.authorization];
    let sql = `SELECT timestamp, endpoint, success, amount, client_ip, request_params, error_message
      FROM call_logs WHERE authorization = ?`;

    if (start_date) {
      sql += ' AND timestamp >= ?';
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      sql += ' AND timestamp <= ?';
      params.push(`${end_date} 23:59:59.999`);
    }
    if (endpoint) {
      sql += ' AND endpoint = ?';
      params.push(endpoint);
    }
    if (success === 'true' || success === 'false') {
      sql += ' AND success = ?';
      params.push(success === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY timestamp DESC';
    const records = db.prepare(sql).all(...params).map((row) => ({
      timestamp: row.timestamp,
      endpoint: row.endpoint,
      success: row.success === 1,
      amount: roundBalance(row.amount || 0),
      client_ip: row.client_ip || '',
      request_params: parseJsonOrNull(row.request_params),
      error_message: row.error_message || ''
    }));

    return res.json({
      message: '成功',
      data: {
        authorization: auth.authorization,
        name: auth.authInfo.name || '',
        count: records.length,
        records
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 查询当前 Authorization 的充值记录（免费，不扣费）
router.get('/get_recharge_log', async (req, res) => {
  try {
    const auth = getValidAuth(req, res);
    if (!auth) return;

    const { start_date, end_date, type } = req.query;
    const limit = parseLimit(req.query.limit);
    const params = [auth.authorization];
    let sql = `SELECT timestamp, type, amount, before_balance, after_balance, remark
      FROM recharge_log WHERE authorization = ?`;

    if (start_date) {
      sql += ' AND timestamp >= ?';
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      sql += ' AND timestamp <= ?';
      params.push(`${end_date} 23:59:59`);
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const records = db.prepare(sql).all(...params).map(row => ({
      timestamp: row.timestamp,
      type: row.type,
      amount: roundBalance(row.amount || 0),
      before_balance: roundBalance(row.before_balance || 0),
      after_balance: roundBalance(row.after_balance || 0),
      remark: row.remark || ''
    }));

    return res.json({
      message: '成功',
      data: {
        authorization: auth.authorization,
        name: auth.authInfo.name || '',
        count: records.length,
        limit,
        records
      }
    });
  } catch (e) {
    return res.status(500).json({ message: '失败', error: e.message });
  }
});

// 注册表里的新接口路由（放在所有静态路由之后注册；注册表为空则无影响）
registerRegistryEndpoints();

module.exports = router;
