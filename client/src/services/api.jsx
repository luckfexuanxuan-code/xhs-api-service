import axios from 'axios'

const api = axios.create({
  baseURL: '',
  timeout: 30000
})

// 请求拦截器 - 添加管理员密钥
api.interceptors.request.use(config => {
  const adminKey = localStorage.getItem('adminKey')
  if (adminKey) {
    config.headers['X-Admin-Key'] = adminKey
  }
  return config
})

// 响应拦截器 - 处理错误
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      // 认证失败，清除登录状态
      localStorage.removeItem('adminKey')
      localStorage.removeItem('username')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// 管理员接口
export const adminApi = {
  // 登录
  login: (username, password) =>
    api.post('/admin/login', { username, password }),

  // 验证登录
  verifyLogin: () =>
    api.get('/admin/verify_login'),

  // ========== 用户账户管理（新） ==========
  createUserAccount: (data) =>
    api.post('/admin/create_user_account', data),

  listUserAccounts: () =>
    api.get('/admin/list_user_accounts'),

  getUserAccount: (userId) =>
    api.get('/admin/get_user_account', { params: { user_id: userId } }),

  renameUserAccount: (userId, username) =>
    api.post('/admin/rename_user_account', { user_id: userId, username }),

  deleteUserAccount: (userId) =>
    api.post('/admin/delete_user_account', { user_id: userId }),

  rechargeUser: (userId, amount) =>
    api.post('/admin/recharge_user', { user_id: userId, amount }),

  setUserBalance: (userId, amount) =>
    api.post('/admin/set_user_balance', { user_id: userId, amount }),

  getUserPrices: (params) =>
    api.get('/admin/get_user_prices', { params }),

  setUserPrice: (params) =>
    api.post('/admin/set_user_price', params),

  bindAuthToUser: (authorization, userId) =>
    api.post('/admin/bind_auth_to_user', { authorization, user_id: userId }),

  createAuthForUser: (userId, name) =>
    api.post('/admin/create_auth_for_user', { user_id: userId, name }),

  getUserRechargeLog: (params) =>
    api.get('/admin/get_user_recharge_log', { params }),

  listUnboundAuths: () =>
    api.get('/admin/list_unbound_auths'),

  // ========== 散号管理（原有，兼容保留） ==========
  listAuth: () =>
    api.get('/admin/list_auth'),

  createAuth: (data) =>
    api.post('/admin/create_auth', data),

  deleteUser: (authorization) =>
    api.post('/admin/delete_user', { authorization }),

  renameUser: (authorization, name, description) =>
    api.post('/admin/rename_user', { authorization, name, description }),

  toggleAuth: (authorization, enabled) =>
    api.post('/admin/toggle_auth', { authorization, enabled }),

  setAuthQuota: (authorization, quota) =>
    api.post('/admin/set_auth_quota', { authorization, quota }),

  setBalance: (authorization, amount) =>
    api.post('/admin/set_balance', { authorization, amount }),

  recharge: (authorization, amount) =>
    api.post('/admin/recharge', { authorization, amount }),

  getRechargeLog: (params) =>
    api.get('/admin/get_recharge_log', { params }),

  setCustomPrice: (authorization, endpoint, price) =>
    api.post('/admin/set_custom_price', { authorization, endpoint, price }),

  // 屏蔽管理
  blockUser: (authorization, reason) =>
    api.post('/admin/block_user', { authorization, reason }),

  unblockUser: (authorization) =>
    api.post('/admin/unblock_user', { authorization }),

  listBlockedUsers: () =>
    api.get('/admin/list_blocked_users'),

  clearAttackRecords: (authorization) =>
    api.post('/admin/clear_attack_records', { authorization }),

  getAttackConfig: () =>
    api.get('/admin/get_attack_config'),

  getRateLimit: () =>
    api.get('/admin/get_rate_limit'),
  setRateLimit: (qps) =>
    api.post('/admin/set_rate_limit', { qps }),

  // 接口最小调用间隔限流（三级：global / user / auth）
  getThrottles: (scope, scope_id) =>
    api.get('/admin/get_throttles', { params: { scope, scope_id } }),
  setThrottle: (scope, scope_id, endpoint, interval_seconds) =>
    api.post('/admin/set_throttle', { scope, scope_id, endpoint, interval_seconds }),

  // 接口默认价格（创建密钥/用户的初始价）。读取走公开接口 /api/prices（与文档页同源），写入走管理接口。
  getDefaultPrices: () =>
    api.get('/api/prices'),
  setDefaultPrice: (endpoint, price) =>
    api.post('/admin/set_default_price', { endpoint, price }),
  // 上游接口成本表（按上游原始接口粒度；unit_cost 传空 = 恢复默认）
  getUpstreamApiCosts: () =>
    api.get('/admin/get_upstream_api_costs'),
  setUpstreamApiCost: (upstream, apiPath, unit_cost) =>
    api.post('/admin/set_upstream_api_cost', { upstream, api: apiPath, unit_cost }),

  // 接口状态（健康 / 风控，客户文档页据此展示徽章 + 排序）
  getEndpointStatus: () =>
    api.get('/admin/get_endpoint_status'),
  setEndpointStatus: (endpoint, status) =>
    api.post('/admin/set_endpoint_status', { endpoint, status }),

  // IP黑名单
  blockIp: (ip, reason) =>
    api.post('/admin/block_ip', { ip, reason }),

  unblockIp: (ip) =>
    api.post('/admin/unblock_ip', { ip }),

  listBlockedIps: () =>
    api.get('/admin/list_blocked_ips'),

  // 统计
  getUserUsageStatistics: () =>
    api.get('/admin/get_user_usage_statistics'),

  getUsageStatistics: (authorization) =>
    api.get('/admin/get_usage_statistics', { params: { authorization } }),

  getEndpointStatistics: (params) =>
    api.get('/admin/get_endpoint_statistics', { params }),

  // 用户地区分布：每个用户(authorization)取一个代表IP解析省份，仪表盘地图用
  getUserRegionDistribution: (params) =>
    api.get('/admin/get_user_region_distribution', { params }),

  clearUsageStatistics: (authorization, confirm) =>
    api.post('/admin/clear_usage_statistics', { authorization, confirm }),

  // 日志
  getCallLogs: (params) =>
    api.get('/admin/get_call_logs', { params }),

  exportCallLogs: (params) =>
    api.get('/admin/export_call_logs', { params }),

  // 完整文件下载（download=csv|json），以 blob 接收，不进 React state
  exportCallLogsFile: (params) =>
    api.get('/admin/export_call_logs', { params, responseType: 'blob', timeout: 120000 }),

  deleteUserCallLogs: (authorization) =>
    api.delete('/admin/delete_user_call_logs', { params: { authorization } }),

  getCallLogsSummary: (authorization) =>
    api.get('/admin/get_call_logs_summary', { params: { authorization } }),

  getRealtimeLogs: (params) =>
    api.get('/admin/get_realtime_logs', { params }),

  clearLogBuffer: () =>
    api.post('/admin/clear_log_buffer'),

  // 上游API测试
  testUpstreamApi: (api_type, params) =>
    api.post('/admin/test_upstream_api', { api_type, params }),

  getUpstreamApiList: () =>
    api.get('/admin/get_upstream_api_list'),

  // 数据API连通性测试（单接口5秒超时，整体并发约5-6秒）
  testConnectivity: () =>
    api.get('/admin/test_connectivity', { timeout: 60000 }),

  // 下游接口（本平台 /api/*）连通性测试（走完整计费链路，成功会真扣费）
  testConnectivityDownstream: () =>
    api.get('/admin/test_connectivity_downstream', { timeout: 60000 }),
  getDownstreamTestKey: () =>
    api.get('/admin/get_downstream_test_key'),
  setDownstreamTestKey: (key) =>
    api.post('/admin/set_downstream_test_key', { key }),

  getUpstreamBalance: () =>
    api.get('/admin/get_upstream_balance'),

  getUpstreamUsage: () =>
    api.get('/admin/get_upstream_usage'),

  // 图表统计
  getHourlyStatistics: (params) =>
    api.get('/admin/get_hourly_statistics', { params }),

  getHourlyHealth: (params) =>
    api.get('/admin/get_hourly_health', { params }),

  getMinuteStatistics: (params) =>
    api.get('/admin/get_minute_statistics', { params }),

  getDailyUserStatistics: (params) =>
    api.get('/admin/get_daily_user_statistics', { params }),

  getEndpointList: () =>
    api.get('/admin/get_endpoint_list'),

  getDailyStatistics: (params) =>
    api.get('/admin/get_daily_statistics', { params })
}

export default api
