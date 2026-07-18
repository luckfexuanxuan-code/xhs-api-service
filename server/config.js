/**
 * 配置文件 - 敏感信息从 config.local.js 读取
 */

let local = {};
try {
  local = require('./config.local');
} catch (e) {
  console.warn('⚠️  未找到 config.local.js，敏感配置为空，请从 config.local.example.js 复制并填写');
}

// 多上游支持：优先读 local.UPSTREAMS，兼容旧 BASE_URL / API_AUTHORIZATION 字段
const UPSTREAMS = local.UPSTREAMS || {
  xingyin: {
    baseURL: local.BASE_URL || 'http://api.xdatamarket.vip:5643',
    authorization: local.API_AUTHORIZATION || ''
  }
};

module.exports = {
  // ==================== 多上游配置 ====================
  UPSTREAMS,

  // 向后兼容，指向默认上游 xingyin（部分旧代码仍引用）
  BASE_URL: (UPSTREAMS.xingyin || Object.values(UPSTREAMS)[0]).baseURL,
  API_AUTHORIZATION: (UPSTREAMS.xingyin || Object.values(UPSTREAMS)[0]).authorization,

  // ==================== 管理员配置 ====================
  ADMIN_SECRET_KEY: local.ADMIN_SECRET_KEY || '',
  ADMIN_USERNAME: local.ADMIN_USERNAME || '',
  ADMIN_PASSWORD: local.ADMIN_PASSWORD || '',

  // 在线充值入账：门户↔本后台 的共享密钥（参数签名校验）。未配置则在线充值接口拒绝服务。
  RECHARGE_CALLBACK_SECRET: local.RECHARGE_CALLBACK_SECRET || '',

  // ==================== 第三方工具 ====================
  AMAP_KEY: local.AMAP_KEY || '',

  // ==================== 安全配置 ====================
  // 「余额不足攻击」自动封禁密钥：ATTACK_WINDOW 秒内余额不足达 ATTACK_THRESHOLD 次 → 封禁密钥
  ATTACK_THRESHOLD: parseInt(process.env.ATTACK_THRESHOLD || '5', 10),
  ATTACK_WINDOW: parseInt(process.env.ATTACK_WINDOW || '60', 10),
  // 「客户端错误(非法参数)」自动封禁密钥：KEY_AUTO_BAN_WINDOW 秒内客户端错误达
  // KEY_AUTO_BAN_THRESHOLD 次 → 封禁密钥 + 拉黑来源 IP（下沉防火墙 DROP）。
  // 与 auth.js 的 registerKeyClientError 一致（原为代码内 ||60 / ||1000 兜底，现显式化）。
  KEY_AUTO_BAN_WINDOW: parseInt(process.env.KEY_AUTO_BAN_WINDOW || '60', 10),
  KEY_AUTO_BAN_THRESHOLD: parseInt(process.env.KEY_AUTO_BAN_THRESHOLD || '1000', 10),
  // 永不封禁的 IP 白名单（逗号分隔）：本机平台同机调用本接口，绝不能被封。
  // 默认包含本服务器公网 IP；环回/内网/本机网卡 IP 在防火墙层已自动豁免。
  IP_BLOCK_WHITELIST: (process.env.IP_BLOCK_WHITELIST || '8.140.241.29')
    .split(',').map(s => s.trim()).filter(Boolean),
  // 单密钥每秒最大请求数（QPS 限流）。超过直接 429，不转发上游、不扣费、不写库、不打日志。
  // 防止个别客户端在上游 503「请无限重试」时把小机器打死。设 0 关闭限流。
  KEY_RATE_LIMIT_QPS: parseInt(process.env.KEY_RATE_LIMIT_QPS || '15', 10),
  // 是否打印每请求的高频计费日志（[调用]/[扣费成功]/[退费]/[计费成功]）。
  // 默认关闭：高频重试场景下这些日志本身就是磁盘 I/O 杀手（曾 57MB/小时）。
  // 关闭不影响仪表盘统计（统计走 DB 的 recordCallLog/recordUsageStatistics）。
  BILLING_VERBOSE_LOG: (process.env.BILLING_VERBOSE_LOG || 'false').toLowerCase() === 'true',

  // ==================== 服务配置 ====================
  SERVICE_PORT: parseInt(process.env.SERVICE_PORT || '9090', 10),
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '30', 10) * 1000,
  TRUST_PROXY: process.env.TRUST_PROXY || 'false',
  LOG_FLUSH_INTERVAL_MS: parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '1000', 10),
  LOG_FLUSH_BATCH_SIZE: parseInt(process.env.LOG_FLUSH_BATCH_SIZE || '200', 10),
  USAGE_FLUSH_INTERVAL_MS: parseInt(process.env.USAGE_FLUSH_INTERVAL_MS || '1000', 10),

  // ==================== 数据文件路径 ====================
  DATA_DIR: 'data',
  BALANCE_FILE: 'data/balance.json',
  PRICES_FILE: 'data/prices.json',
  AUTH_FILE: 'data/auth.json',
  USAGE_FILE: 'data/usage.json',
  IP_BLACKLIST_FILE: 'data/ip_blacklist.json',

  // ==================== 调用日志配置 ====================
  CALL_LOGS_DIR: process.env.CALL_LOGS_DIR || 'call_logs',
  CALL_LOG_FILE_MAX_LINES: parseInt(process.env.CALL_LOG_FILE_MAX_LINES || '10000', 10),
  ASYNC_CALL_LOG: (process.env.ASYNC_CALL_LOG || 'true').toLowerCase() === 'true',

  // ==================== 默认价格 ====================
  DEFAULT_PRICES: {
    'get_note_detail': 0.04,
    'get_note_detail_video': 0.04,
    'search_note': 0.06,

    'get_note_comment': 0.04,
    'get_note_sub_comment': 0.04,
    'get_user_info': 0.04,
    'user_note_list': 0.06,
    'tag_notes': 0.06
  },
  // 占位：集中注册表里的新接口价格会在文件末尾合并进 DEFAULT_PRICES

  // ==================== 上游API配置（管理后台测试用）====================
  UPSTREAM_API_CONFIGS: {
    'note': {
      name: '获取笔记详情',
      url: '/xhsapi/note',
      method: 'GET',
      params: ['noteId'],
      upstream: 'xingyin'
    },
    'video_note': {
      name: '获取视频笔记详情',
      url: '/xhsapi/video_note',
      method: 'GET',
      params: ['noteId'],
      upstream: 'xingyin'
    },
    'comment': {
      name: '获取笔记评论',
      url: '/xhsapi/comment',
      method: 'GET',
      params: ['noteId', 'start', 'sortStrategy'],
      upstream: 'xingyin'
    },
    'sub_comments': {
      name: '获取子评论',
      url: '/xhsapi/sub_comments',
      method: 'GET',
      params: ['noteId', 'commentId', 'start'],
      upstream: 'xingyin'
    },
    'app_search': {
      name: '搜索笔记',
      url: '/xhsapi/app_search',
      method: 'GET',
      params: ['keyword', 'page', 'searchId', 'sessionId', 'sortType', 'filterNoteType', 'filterNoteTime', 'filterNoteRange', 'filter_hot'],
      upstream: 'xingyin'
    },
    'app_user_info': {
      name: '获取用户信息',
      url: '/xhsapi/v2/app_user_info',
      method: 'GET',
      params: ['userId'],
      upstream: 'xingyin'
    },
    'app_user_posted': {
      name: '获取用户笔记列表',
      url: '/xhsapi/v2/app_user_posted',
      method: 'GET',
      params: ['userId', 'cursor'],
      upstream: 'xingyin'
    },
    'tag_notes': {
      name: '获取话题标签笔记',
      url: '/xhsapi/tag_notes',
      method: 'GET',
      params: ['pageId', 'first_load_time', 'sort', 'last_note_ct', 'last_note_id', 'cursor_score', 'session_id'],
      upstream: 'xingyin'
    }
  }
};

// 合并「集中注册表」里的新接口价格，使计费/统计/前端自动带上（注册表为空则无影响）
try {
  const { ENDPOINTS } = require('./apiRegistry');
  for (const ep of ENDPOINTS) {
    if (ep && ep.type && typeof ep.price === 'number') {
      module.exports.DEFAULT_PRICES[ep.type] = ep.price;
    }
  }
} catch (e) {
  console.error('合并接口注册表价格失败:', e.message);
}
