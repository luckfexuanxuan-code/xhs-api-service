#!/bin/bash
# 获取脚本所在目录（不依赖硬编码路径）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export SERVICE_PORT=${SERVICE_PORT:-9090}
pkill -f 'node app.js' || true
sleep 1
nohup setsid node app.js >> server.log 2>&1 < /dev/null &
disown || true
sleep 3
ss -ltnp | grep ":${SERVICE_PORT}" || echo "NO_${SERVICE_PORT}"
tail -n 10 server.log
