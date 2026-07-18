/**
 * XHS API 代理服务 - Node.js Express 后端
 * 版本: v1.2 (Node.js + React 重构版)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const { loadData, initDataDir, flushBufferedWrites, dataStore } = require('./utils/dataManager');
const { syncFirewallFromBlacklist } = require('./utils/firewall');
const userApi = require('./routes/userApi');
const adminApi = require('./routes/adminApi');
const publicApi = require('./routes/publicApi');

const app = express();

function parseTrustProxy(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

// 中间件
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 仅在可信反向代理后部署时启用，例如 TRUST_PROXY=loopback 或 TRUST_PROXY=1。
app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY));

// API文档（根路径）
app.use('/doc', express.static(path.join(__dirname, 'static')));
app.use('/docs', express.static(path.join(__dirname, 'static')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});
app.get('/login', (req, res) => {
  res.redirect(302, '/dashboard/login');
});

// 管理后台 HTML 禁止缓存（JS/CSS 有内容哈希，浏览器长缓存无影响）
app.use('/dashboard', (req, res, next) => {
  if (!req.path.match(/\.(js|css|png|jpg|svg|ico|woff2?)$/)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use('/dashboard', express.static(path.join(__dirname, '../client/build')));

// API 路由
app.use('/api', userApi);
app.use('/admin', adminApi);
app.use('/user', publicApi);

// React SPA 路由处理（/dashboard 下的子路径）
app.get('/dashboard/*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

// 错误处理中间件
app.use((err, req, res, next) => {
  // express.json() 解析失败：客户端发了非法 JSON body，返回 400 而非 500
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ code: 400, message: '失败', error: '请求体不是合法的JSON' });
  }
  console.error('服务器错误:', err);
  res.status(500).json({
    code: 500,
    message: '失败',
    error: '服务器内部错误'
  });
});

// 启动服务器
async function main() {
  try {
    // 初始化数据目录
    initDataDir();

    // 加载数据
    await loadData();
    console.log('数据初始化成功');

    // 防火墙自愈：重建 ipset/iptables 规则，并把 DB 里仍封禁的 IP 重新灌入内核集合
    // （重启/防火墙reload后规则会丢，以 DB 为准重建，确保被封 IP 始终在内核层被丢包）
    await syncFirewallFromBlacklist(dataStore.ipBlacklist);

    // 启动服务器
    app.listen(config.SERVICE_PORT, '0.0.0.0', () => {
      console.log('启动服务器...');
      console.log('='.repeat(50));
      console.log('小红书API代理服务');
      console.log('版本: v1.2 (Node.js + React 重构版)');
      console.log('='.repeat(50));
      console.log(`服务端口: ${config.SERVICE_PORT}`);
      console.log(`攻击检测: ✅ 已启用 (${config.ATTACK_THRESHOLD}次/${config.ATTACK_WINDOW}秒)`);
      console.log(`调用日志: ✅ 已启用`);
      console.log('数据存储: SQLite (data/xhs.db)');
      console.log('='.repeat(50));
      console.log(`服务已启动: http://localhost:${config.SERVICE_PORT}`);
    });

  } catch (e) {
    console.error('数据初始化失败:', e.message);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  flushBufferedWrites();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n正在关闭服务...');
  flushBufferedWrites();
  process.exit(0);
});

main();
