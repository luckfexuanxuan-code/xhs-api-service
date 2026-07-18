# Galaxy API Service

一个简单的 Node.js API 代理与计费服务，包含 React 管理后台、SQLite 数据存储和在线 API 文档。

## 功能

- API Key 鉴权与余额计费
- 多上游接口转发与失败回退
- 调用日志、用量统计和接口定价
- React 管理后台
- 在线 API 文档与测试

## 技术栈

- Node.js + Express
- SQLite（better-sqlite3）
- React + Vite

## 快速开始

要求：Node.js 18+

```bash
# 1. 配置
cp server/config.local.example.js server/config.local.js
# 编辑 server/config.local.js，填写上游和管理员配置

# 2. 构建前端
cd client
npm ci
npm run build

# 3. 启动服务
cd ../server
npm ci
npm test
npm start
```

默认端口为 `9090`：

- API 文档：`http://localhost:9090/doc/`
- 管理后台：`http://localhost:9090/dashboard/`
- 价格接口：`http://localhost:9090/api/prices`

## 配置

敏感配置放在：

```text
server/config.local.js
```

该文件、数据库、日志和构建产物均已加入 `.gitignore`，请勿提交真实密钥。

常用环境变量：

```bash
SERVICE_PORT=9090
TRUST_PROXY=false
CORS_ORIGIN=*
KEY_RATE_LIMIT_QPS=15
```

## 项目结构

```text
client/          React 管理后台
server/          Express 服务
server/routes/   API 路由
server/static/   客户端 API 文档
server/tests/    自动化测试
```

## 测试

```bash
cd server
npm test
```
