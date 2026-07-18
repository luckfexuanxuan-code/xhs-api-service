/**
 * 本地配置文件模板
 * 复制为 config.local.js 并填写真实值
 * config.local.js 不要提交到 git
 */
module.exports = {
  // ==================== 上游配置 ====================
  // 每个上游一个 key，在路由里用 upstream: 'xingyin' 指定
  UPSTREAMS: {
    xingyin: {
      baseURL: 'http://api.xdatamarket.vip:5643',
      authorization: '你的星音API密钥'
    },
    // V5 上游（POST JSON + X-API-KEY 认证）
    // v5: {
    //   baseURL: 'http://x.x.x.x:8089',
    //   authorization: 'X-API-KEY 密钥',
    //   timeoutMs: 60000,
    //   loginUsername: '余额查询账号',
    //   loginPassword: '余额查询密码'
    // },
    // 新增上游示例：
    // other: {
    //   baseURL: 'http://other-api.com',
    //   authorization: '密钥'
    // }
  },

  // ==================== 管理员账号 ====================
  ADMIN_SECRET_KEY: '管理员认证密钥',
  ADMIN_USERNAME: '管理员用户名',
  ADMIN_PASSWORD: '管理员密码',
};
