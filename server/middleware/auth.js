/**
 * 中间件模块 - 管理员认证和余额检查
 */

const config = require('../config');
const {
  dataStore,
  saveUser,
  atomicBalanceOperation,
  atomicUserBalanceOperation,
  updateUserLastUsed,
  recordUsageStatistics,
  recordCallLog,
  cleanErrorMessage,
  roundBalance,
  getPricesForAuth,
  getAuthCurrentBalance,
  saveSingleIpBlacklist,
  chargeKeyQuota,
  refundKeyQuota
} = require('../utils/dataManager');
const { firewallBlockIp, isWhitelisted } = require('../utils/firewall');
const { getRateLimitQps, getAuthEndpointInterval, getDefaultPrice, getUpstreamApiCost } = require('../utils/settings');
const { resolveIpLocationAsync } = require('../utils/ipLocation');
// getAuthEndpointInterval(authorization, userId, endpoint) 内部解析三级优先级：密钥 > 用户 > 全局

// ===== 按 (密钥, 接口) 的最小调用间隔限流（内存级，记录每对的上次放行时刻）=====
// 例：某密钥对某接口设 20s，则 20s 内只放行一次，其余直接 429，不转发上游、不扣费、不写库。
// 仅对配置过的 (密钥,接口) 生效；重启后 Map 清空（重启后首次调用放行，可接受）。
const _throttlePassAt = new Map(); // `${authorization}|${endpoint}` -> 上次放行的毫秒时间戳

// ===== 上游账户余额不足检测 =====
// 客户余额在转发前已校验，故上游响应里的“余额不足”一定是供应商账户的问题。
// 不能把它原文透传给客户（会误导/泄露），统一中性话术，并节流告警提醒运维充值。
const UPSTREAM_INSUFFICIENT_RE = /(余额不足|余额不够|账户余额|余额已用尽|欠费|insufficient|not\s*enough\s*balance)/i;
let _upstreamLowBalanceWarnAt = 0; // 告警节流时间戳（秒）

// ===== 单密钥 QPS 限流（内存级，按密钥固定 1 秒窗口计数）=====
// 防止个别客户端在上游 503「请无限重试」时以上百 QPS 把小机器打死。
// 超限请求直接 429 返回，不转发上游、不扣费、不写库、不打高频日志，开销极低。
// 限流阈值取自运行时设置（后台「系统设置」可改，落库），未设置过则用 config 默认值。
const _rlWindow = new Map(); // authorization -> { sec, count }
let _rlWarnSec = 0;

// 高频业务失败只做限频告警，明细仍写 call_logs。避免配额不足/余额不足等正常业务状态刷爆 PM2 日志。
const _warnLimiter = new Map(); // key -> { at, suppressed }
function warnLimited(key, intervalMs, buildMessage) {
  const now = Date.now();
  const entry = _warnLimiter.get(key);
  if (entry && now - entry.at < intervalMs) {
    entry.suppressed++;
    return;
  }
  const suppressed = entry ? entry.suppressed : 0;
  _warnLimiter.set(key, { at: now, suppressed: 0 });
  if (_warnLimiter.size > 2000) _warnLimiter.clear();
  const suffix = suppressed > 0 ? ` | ${Math.round(intervalMs / 1000)}秒内已合并 ${suppressed} 条` : '';
  console.warn(buildMessage() + suffix);
}

function isRateLimited(authorization) {
  const limit = getRateLimitQps();
  if (!limit || limit <= 0) return false; // 0 = 关闭限流
  const sec = Math.floor(Date.now() / 1000);
  let e = _rlWindow.get(authorization);
  if (!e || e.sec !== sec) {
    // 顺手控制 Map 体积：每秒新窗口时若过大就清空（陈旧条目无意义）
    if (_rlWindow.size > 5000) _rlWindow.clear();
    e = { sec, count: 0 };
    _rlWindow.set(authorization, e);
  }
  e.count++;
  return e.count > limit;
}

function adminRequired(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!adminKey) {
    return res.status(401).json({ message: '失败', error: '缺少管理员认证密钥' });
  }
  if (adminKey !== config.ADMIN_SECRET_KEY) {
    console.warn(`管理员认证失败，IP: ${req.ip}`);
    return res.status(403).json({ message: '失败', error: '管理员认证失败' });
  }
  next();
}

function validateRequestParams(endpoint, query) {
  const requiredParams = {
    'get_note_detail': ['note_id'],
    'get_note_detail_video': ['note_id'],
    'get_note_comment': ['note_id'],
    'get_note_sub_comment': ['note_id', 'comment_id'],
    'search_note': ['keyword'],
    'get_user_info': [],
    'user_note_list': [],
    'tag_notes': ['pageId']
  };
  const params = requiredParams[endpoint] || [];
  const missing = params.filter(p => !query[p]);
  if (missing.length > 0) return `缺少必要参数: ${missing.join(', ')}`;

  // 参数格式预校验：在扣费/转发上游之前拦掉明显非法的 id，
  // 避免把垃圾请求打到上游（省上游配额，防持续失败触发上游风控）。
  // 小红书 note_id 固定为 24 位十六进制（已用真实数据核实，无例外）。
  if (query.note_id != null && query.note_id !== '' && !/^[0-9a-fA-F]{24}$/.test(query.note_id)) {
    return 'note_id 格式不正确，应为 24 位十六进制字符';
  }

  return null;
}

function isEmptyBusinessData(responseData) {
  if (responseData === null || responseData === undefined) return true;
  if (typeof responseData === 'object' && !Array.isArray(responseData) && Object.keys(responseData).length === 0) return true;
  if (Array.isArray(responseData) && responseData.length === 0) return true;
  if (typeof responseData === 'string' && responseData.trim() === '') return true;
  return false;
}

function classifyBillingResult(statusCode, message, responseData) {
  if (statusCode >= 400 && statusCode < 500) {
    return { billable: false, refundReason: '参数错误', errorMessage: `参数错误 (HTTP ${statusCode})` };
  }

  if (message === '成功' && responseData !== null && responseData !== undefined) {
    if (isEmptyBusinessData(responseData)) {
      return { billable: false, refundReason: '数据无效', errorMessage: '数据无效' };
    }
    return { billable: true, refundReason: null, errorMessage: null };
  }

  return { billable: false, refundReason: 'API失败', errorMessage: message || 'API调用失败' };
}

function recordBillingOutcome(authorization, endpointName, success, amount, clientIp, userAgent, reqParams, errorMessage = null, cost = 0, upstream = '', upstreamAttempts = '', upstreamApi = '') {
  // 成功计费时把本次真实上游成本传入统计（利润 = 收入 - 真实成本，随实际服务的上游浮动）
  try { recordUsageStatistics(authorization, endpointName, success, success ? amount : 0, success ? cost : 0); } catch (_) {}
  try { recordCallLog(authorization, endpointName, success, success ? amount : 0, clientIp, userAgent, reqParams, errorMessage, cost, upstream, upstreamAttempts, upstreamApi); } catch (_) {}
  // 异步解析来源IP的省份（仪表盘"用户地区分布"图用），已缓存的IP直接跳过，不影响本次请求响应速度
  try { resolveIpLocationAsync(clientIp); } catch (_) {}
}

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || '';
}

// ==================== 客户端错误自动封禁密钥 + 牵连拉黑来源 IP ====================
// 只统计「客户端自身错误」(参数缺失/note_id 格式非法等)，不统计上游/服务器错误，
// 避免上游故障导致正常用户请求批量失败时把他们的密钥一起误封。
const authClientErrorWindow = new Map(); // authorization -> number[]（失败时间戳，秒）
const KEY_BAN_WINDOW = config.KEY_AUTO_BAN_WINDOW || 60;        // 滑动窗口（秒）
const KEY_BAN_THRESHOLD = config.KEY_AUTO_BAN_THRESHOLD || 1000;  // 窗口内客户端错误达到此数即封禁该密钥

// 把来源 IP 加入黑名单：凡是用「已封禁密钥」发请求的 IP 一律拉黑，后续在中间件顶层直接 403
function blockIp(clientIp, reason) {
  if (!clientIp || dataStore.ipBlacklist[clientIp]?.blocked) return;
  // 本机/平台白名单 IP 绝不封禁（同机平台会调用本接口）
  if (isWhitelisted(clientIp)) { console.warn(`[跳过封禁] 白名单IP（本机/平台）: ${clientIp} | ${reason}`); return; }
  dataStore.ipBlacklist[clientIp] = {
    blocked: true,
    blocked_at: nowStrLocal(),
    reason: `自动封禁：${reason}`,
    unblocked_at: ''
  };
  try { saveSingleIpBlacklist(clientIp); } catch (e) { console.error(`保存自动封禁IP失败: ${e.message}`); }
  // 下沉到内核：加入 ipset，后续该 IP 的包在防火墙层直接 DROP，不再到达 Node（异步、失败静默）
  firewallBlockIp(clientIp).catch(() => {});
  console.warn(`[自动封禁IP] ${clientIp} | ${reason}`);
}

// 记录一次客户端错误；同一密钥短时间内超阈值则自动封禁该密钥。返回本次是否触发封禁
function registerKeyClientError(authorization, authInfo, reason) {
  if (!authorization || !authInfo || authInfo.blocked) return false;
  const now = Date.now() / 1000;
  const arr = (authClientErrorWindow.get(authorization) || []).filter(t => now - t <= KEY_BAN_WINDOW);
  arr.push(now);
  authClientErrorWindow.set(authorization, arr);
  if (arr.length >= KEY_BAN_THRESHOLD) {
    authInfo.blocked = true;
    authInfo.blocked_at = nowStrLocal();
    authInfo.block_reason = `${KEY_BAN_WINDOW}秒内客户端错误${arr.length}次，自动封禁密钥（最近: ${reason}）`;
    try { saveUser(authorization); } catch (e) { console.error(`保存自动封禁密钥失败: ${e.message}`); }
    console.warn(`[自动封禁密钥] ${authorization} | ${KEY_BAN_WINDOW}秒内客户端错误${arr.length}次 | 最近原因: ${reason}`);
    authClientErrorWindow.delete(authorization);
    return true;
  }
  return false;
}

function checkBalanceAndCharge(endpointName) {
  return async (req, res, next) => {
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    // 本次请求参数（query + body 合并），用于写入调用日志的 request_params 列
    const reqParams = { ...(req.query || {}), ...(req.body || {}) };

    // IP 黑名单（白名单 IP 始终放行：本机/平台同机调用）
    if (dataStore.ipBlacklist[clientIp]?.blocked && !isWhitelisted(clientIp)) {
      console.warn(`已封禁IP尝试访问: ${clientIp}`);
      return res.status(403).json({ message: '失败', error: 'IP已被封禁，请联系管理员' });
    }

    const authorization = req.headers['authorization'];
    if (!authorization) {
      return res.status(401).json({ message: '失败', error: '缺少Authorization' });
    }

    const authInfo = dataStore.authorizations[authorization];
    // 平台不存在该密钥：直接打回。不记录用量/调用日志，避免随机密钥刷量污染按 auth 聚合的统计表
    if (!authInfo) {
      return res.status(401).json({ message: '失败', error: '密钥不存在' });
    }
    // 密钥存在但被停用
    if (!authInfo.enabled) {
      try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
      try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, '密钥已停用'); } catch (_) {}
      return res.status(401).json({ message: '失败', error: '密钥已停用，请联系管理员' });
    }

    if (authInfo.blocked) {
      const userName = authInfo.name || 'Unknown user';
      console.warn(`[blocked_user_call] user: ${userName} | endpoint: ${endpointName} | ip: ${clientIp}`);
      // 密钥已被封禁：把本次请求的来源 IP 一并拉黑，使其彻底无法访问（下次到顶层即被拦）
      blockIp(clientIp, `使用已封禁密钥 ${authorization.slice(0, 8)}…`);
      try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
      try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, '账户已被屏蔽'); } catch (_) {}
      return res.status(403).json({ message: '失败', error: '账户已被屏蔽，请联系管理员' });
    }

    // 单密钥 QPS 限流：超限直接 429，不转发上游、不扣费、不写库。
    // 每秒最多打印一条限流告警，避免告警自身又变成日志洪水。
    if (isRateLimited(authorization)) {
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== _rlWarnSec) {
        _rlWarnSec = sec;
        console.warn(`[限流] 密钥 ${authorization.slice(0, 8)}… 超过 ${getRateLimitQps()} QPS，已 429`);
      }
      return res.status(429).json({ message: '失败', error: '请求过于频繁，请降低频率后重试' });
    }

    // 接口最小调用间隔限流（三级优先级：密钥 > 用户 > 全局）：interval 秒内只放行一次。
    // 同样不转发上游、不扣费、不写库。窗口按 (密钥,接口) 计，仅对配置过的接口生效。
    const minInterval = getAuthEndpointInterval(authorization, authInfo.user_id || null, endpointName);
    if (minInterval > 0) {
      const nowMs = Date.now();
      const tk = `${authorization}|${endpointName}`;
      const last = _throttlePassAt.get(tk) || 0;
      const elapsed = nowMs - last;
      if (elapsed < minInterval * 1000) {
        const wait = Math.ceil((minInterval * 1000 - elapsed) / 1000);
        res.set('Retry-After', String(wait));
        return res.status(429).json({
          message: '失败',
          error: '风控处理中，请保持无限重试，不超过10分钟'
        });
      }
      _throttlePassAt.set(tk, nowMs);
    }

    // 获取价格（绑定用户用用户级价格，否则用 auth 级价格）
    const userId = authInfo.user_id || null;
    const prices = getPricesForAuth(authorization);
    const price = prices[endpointName] ?? getDefaultPrice(endpointName);

    const userName = authInfo.name || '未知用户';
    const oldBalance = getAuthCurrentBalance(authorization);

    if (config.BILLING_VERBOSE_LOG) console.log(`[调用] 用户: ${userName} | 接口: ${endpointName} | 价格: ${price}元 | 当前余额: ${oldBalance}元`);

    // 参数验证
    const validationError = validateRequestParams(endpointName, { ...(req.query || {}), ...(req.body || {}) });
    if (validationError) {
      try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
      try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, validationError); } catch (_) {}
      // 客户端错误计数：持续发非法参数的「密钥」会被自动封禁；
      // 一旦本次触发封禁，连带把当前来源 IP 拉黑，并按 403 打回
      const keyJustBlocked = registerKeyClientError(authorization, authInfo, validationError);
      if (keyJustBlocked) {
        blockIp(clientIp, `使用已封禁密钥 ${authorization.slice(0, 8)}…`);
        return res.status(403).json({ message: '失败', error: '账户已被屏蔽，请联系管理员' });
      }
      return res.status(400).json({ message: '失败', error: validationError });
    }

    // 配额校验（剩余配额，先于扣费；不限额则直接放行）。不足直接打回，不动余额。
    const quotaResult = chargeKeyQuota(authorization, price);
    if (!quotaResult.success) {
      warnLimited(
        `quota|${authorization}|${endpointName}`,
        60000,
        () => `[配额不足] 用户: ${userName} | 接口: ${endpointName} | 价格: ${price}元 | 剩余配额: ${quotaResult.quota}元`
      );
      // 配额不足是密钥自身状态（客户没充配额），不是一次真实调用尝试：不写调用日志、不计入调用次数统计
      return res.status(402).json({ message: '失败', error: '密钥配额不足，请联系管理员', quota: quotaResult.quota, price });
    }

    // 扣费（根据绑定状态路由）
    const chargeResult = userId
      ? await atomicUserBalanceOperation(userId, 'charge', price)
      : await atomicBalanceOperation(authorization, 'charge', price);

    if (chargeResult.success) {
      if (config.BILLING_VERBOSE_LOG) console.log(`[扣费成功] 用户: ${userName} | 扣费: ${price}元 | 余额: ${oldBalance}元 -> ${chargeResult.balance}元`);
      if (userId) updateUserLastUsed(userId);
    }

    if (!chargeResult.success) {
      // 余额扣费失败：把刚才预扣的配额加回去（与上面 chargeKeyQuota 对称）
      refundKeyQuota(authorization, price);
      if (chargeResult.error === '余额不足') {
        warnLimited(
          `balance|${authorization}|${endpointName}`,
          60000,
          () => `[扣费失败] 用户: ${userName} | 余额不足 | 当前余额: ${chargeResult.balance}元 | 需要: ${price}元`
        );

        const currentTime = Date.now() / 1000;
        if (!authInfo.attack_records) authInfo.attack_records = [];
        authInfo.attack_records.push(currentTime);
        authInfo.attack_records = authInfo.attack_records.filter(t => currentTime - t <= config.ATTACK_WINDOW);

        if (authInfo.attack_records.length >= config.ATTACK_THRESHOLD) {
          authInfo.blocked = true;
          authInfo.blocked_at = nowStrLocal();
          authInfo.block_reason = `余额不足持续攻击，${config.ATTACK_WINDOW}秒内攻击${authInfo.attack_records.length}次`;
          try { saveUser(authorization); } catch (e) { console.error(`保存攻击屏蔽数据失败: ${e.message}`); }
          console.warn(`用户 ${authorization} 因余额不足持续攻击被自动屏蔽`);
          try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
          try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, '余额不足持续攻击，账户已被自动屏蔽'); } catch (_) {}
          return res.status(403).json({ message: '失败', error: '因余额不足持续攻击，账户已被自动屏蔽' });
        }

        try { saveUser(authorization); } catch (e) { console.error(`保存攻击记录失败: ${e.message}`); }
        const warning = `余额不足攻击记录：${authInfo.attack_records.length}/${config.ATTACK_THRESHOLD}`;
        try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
        try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, '余额不足'); } catch (_) {}
        return res.status(402).json({ message: '失败', error: '余额不足', balance: chargeResult.balance, price, warning });
      }

      try { recordUsageStatistics(authorization, endpointName, false, 0); } catch (_) {}
      try { recordCallLog(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, chargeResult.error); } catch (_) {}
      return res.status(402).json({ message: '失败', error: chargeResult.error, balance: chargeResult.balance, price });
    }

    req.billingContext = {
      authorization, userId, price,
      userName, clientIp, userAgent,
      endpointName, currentBalance: chargeResult.balance
    };

    const originalJson = res.json.bind(res);

    res.json = async function(data) {
      try {
        const statusCode = res.statusCode || 200;

        const doRefund = async (reason) => {
          // 退余额的同时把配额加回去（与请求开始时的 chargeKeyQuota 对称）
          refundKeyQuota(authorization, price);
          const refundResult = userId
            ? await atomicUserBalanceOperation(userId, 'refund', price)
            : await atomicBalanceOperation(authorization, 'refund', price);
          if (refundResult.success) {
            if (config.BILLING_VERBOSE_LOG) console.log(`[退费] 用户: ${userName} | 原因: ${reason} | 退费: +${price}元 | 余额: ${refundResult.balance}元`);
          }
          return refundResult;
        };

        const message = cleanErrorMessage(data.message);
        const responseData = data.data;

        // 上游账户余额不足：对客户屏蔽原文（下方统一替换为中性话术）+ 节流告警提醒充值。
        // 客户照常走失败退费路径；call_logs 仍记录真实原因(message)供运维排查。
        const upstreamInsufficient = UPSTREAM_INSUFFICIENT_RE.test(String(data.message || ''));
        if (upstreamInsufficient) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (nowSec - _upstreamLowBalanceWarnAt >= 30) {
            _upstreamLowBalanceWarnAt = nowSec;
            console.error(`[上游余额不足] 接口 ${endpointName} 上游账户余额不足，客户调用已自动退费，请尽快给上游账户充值！上游原文: ${String(data.message).slice(0, 100)}`);
          }
        }

        const billingResult = classifyBillingResult(statusCode, message, responseData);
        // “上游扣了我们 → 就向客户收费”：上游对我方实际扣费(_upstreamCost>0)时，
        // 即使结果为空/未找到也照常计费。_upstreamCost 仅作计费触发信号，
        // 记账成本不用它的数值，统一按下方成本表取。删除后再返回。
        const upstreamCostVal = typeof data._upstreamCost === 'number' ? data._upstreamCost : null;
        const upstreamCharged = upstreamCostVal !== null && upstreamCostVal > 0;
        if (typeof data._upstreamCost !== 'undefined') delete data._upstreamCost;
        // 实际服务的上游与上游接口（适配器/候选链标记，仅内部使用，删除后再返回）。
        // 记账成本一律按 (实际服务上游, 上游接口) 查系统设置的「上游接口成本」表。
        const servedUpstream = typeof data._servedUpstream === 'string' ? data._servedUpstream : '';
        const servedApi = typeof data._servedApi === 'string' ? data._servedApi : '';
        if (typeof data._servedUpstream !== 'undefined') delete data._servedUpstream;
        if (typeof data._servedApi !== 'undefined') delete data._servedApi;
        // 候选链切换明细（被切换掉的候选+失败原因），序列化后落 upstream_attempts 列（限长2000防异常膨胀）
        let chainAttempts = '';
        if (Array.isArray(data._chainAttempts) && data._chainAttempts.length) {
          try { chainAttempts = JSON.stringify(data._chainAttempts).slice(0, 2000); } catch (_) {}
        }
        if (typeof data._chainAttempts !== 'undefined') delete data._chainAttempts;
        if (!billingResult.billable && upstreamCharged && statusCode < 500) {
          billingResult.billable = true;
          billingResult.refundReason = null;
          billingResult.errorMessage = null;
        }
        if (billingResult.billable) {
          const callCost = getUpstreamApiCost(servedUpstream, servedApi);
          if (config.BILLING_VERBOSE_LOG) console.log(`[计费成功] 用户: ${userName} | 接口: ${endpointName} | 计费: ${price}元 | 余额: ${req.billingContext.currentBalance}元`);
          recordBillingOutcome(authorization, endpointName, true, price, clientIp, userAgent, reqParams, null, callCost, servedUpstream, chainAttempts, servedApi);
          data.balance = roundBalance(req.billingContext.currentBalance);
        } else {
          try {
            const refundResult = await doRefund(billingResult.refundReason);
            data.balance = roundBalance(refundResult.balance);
          } catch (refundErr) {
            console.error(`[退费异常] 用户: ${userName} | 金额: ${price} | 错误: ${refundErr.message}`);
          }
          // 失败退费：成本记 0（上游对失败不收费），upstream 仍记录（便于排查是哪家上游失败）
          recordBillingOutcome(authorization, endpointName, false, 0, clientIp, userAgent, reqParams, billingResult.errorMessage, 0, servedUpstream, chainAttempts, servedApi);
        }

        data.message = upstreamInsufficient ? '服务暂时繁忙，请稍后重试' : message;
        return originalJson(data);
      } catch (e) {
        console.error(`处理响应数据失败: ${e.message}`);
        return originalJson(data);
      }
    };

    next();
  };
}

function nowStrLocal() {
  const n = new Date();
  const p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

module.exports = { adminRequired, checkBalanceAndCharge, getClientIp };
