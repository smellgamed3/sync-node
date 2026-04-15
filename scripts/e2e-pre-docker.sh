#!/usr/bin/env bash
# E2E 阶段1-Docker — 使用本地构建镜像 filesync-kubo:local
# 需提前执行: docker build -t filesync-kubo:local .
# 用法: bash scripts/e2e-pre-docker.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_e2e-kubo.sh"
source "${SCRIPT_DIR}/_e2e-tests.sh"

# ── 常量 ─────────────────────────────────────────────────────────────────────
FILESYNC_IMAGE="filesync-kubo:local"
NETWORK="e2e-pre-docker-net"
KUBO_A="e2e-pre-kubo-a"
KUBO_B="e2e-pre-kubo-b"
APP_A="e2e-pre-app-a"
APP_B="e2e-pre-app-b"
BASE_DIR="/tmp/e2e-pre-docker"
DATA_A="${BASE_DIR}/data-a"
DATA_B="${BASE_DIR}/data-b"
HOME_A="${BASE_DIR}/home-a"
HOME_B="${BASE_DIR}/home-b"
PORT_A=18384
PORT_B=28384

# kubo 的宿主端口（用于健康检查）
KUBO_PORT_A=15001
KUBO_PORT_B=15002

# ── 清理 ─────────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "── 清理 E2E pre-docker 资源 ──"
  stop_watchdog
  docker rm -f "$APP_A"  2>/dev/null || true
  docker rm -f "$APP_B"  2>/dev/null || true
  docker rm -f "$KUBO_A" 2>/dev/null || true
  docker rm -f "$KUBO_B" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
  echo "  已清理"
}
trap cleanup EXIT

# ── 初始化目录 ────────────────────────────────────────────────────────────────
echo "── 初始化目录 ──"
rm -rf "$BASE_DIR"
mkdir -p "$DATA_A" "$DATA_B" "$HOME_A" "$HOME_B"

# ── 生成 filesync 配置 ────────────────────────────────────────────────────────
_write_config() {
  local dir=$1 node_name=$2 port=$3 kubo_api=$4
  cat > "${dir}/config.json" <<EOF
{
  "webAuth": {"username": "", "passwordHash": ""},
  "name": "${node_name}",
  "webPort": ${port},
  "encryptionKey": "e2esharedencryptionkeyfortesting01",
  "syncFolders": [
    {"id": "sf", "syncId": "e2e-sync", "localPath": "/e2e-data", "historyCount": 5, "encrypt": true}
  ]
}
EOF
}

# ── 启动 Kubo ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════ E2E pre-docker 开始 ══════════════"
start_watchdog 600
setup_kubo_pair "$NETWORK" "$KUBO_A" "$KUBO_B" "$KUBO_PORT_A" "$KUBO_PORT_B"

# ── 写入 filesync 配置 ────────────────────────────────────────────────────────
# 容器内 webPort 固定 8384，宿主通过 PORT_A/B 映射访问
_write_config "$HOME_A" "node-a" "8384" "http://${KUBO_A}:5001/api/v0"
_write_config "$HOME_B" "node-b" "8384" "http://${KUBO_B}:5001/api/v0"

# ── 启动 filesync 容器 ────────────────────────────────────────────────────────
echo ""
echo "── 启动 filesync 容器 ──"

LOG_A="${BASE_DIR}/app-a.log"
LOG_B="${BASE_DIR}/app-b.log"

docker run -d --name "$APP_A" \
  --network "$NETWORK" \
  -e FILESYNC_HOME=/e2e-home \
  -e FILESYNC_HOST=0.0.0.0 \
  -e IPFS_API="http://${KUBO_A}:5001/api/v0" \
  -e FILESYNC_DEV_AUTO_TRUST=true \
  -e FILESYNC_ANNOUNCE_INTERVAL=5000 \
  -v "${HOME_A}:/e2e-home" \
  -v "${DATA_A}:/e2e-data" \
  -p "${PORT_A}:8384" \
  "$FILESYNC_IMAGE"

docker run -d --name "$APP_B" \
  --network "$NETWORK" \
  -e FILESYNC_HOME=/e2e-home \
  -e FILESYNC_HOST=0.0.0.0 \
  -e IPFS_API="http://${KUBO_B}:5001/api/v0" \
  -e FILESYNC_DEV_AUTO_TRUST=true \
  -e FILESYNC_ANNOUNCE_INTERVAL=5000 \
  -v "${HOME_B}:/e2e-home" \
  -v "${DATA_B}:/e2e-data" \
  -p "${PORT_B}:8384" \
  "$FILESYNC_IMAGE"

# 把容器日志流到本地文件（非阻塞）
docker logs -f "$APP_A" > "$LOG_A" 2>&1 &
docker logs -f "$APP_B" > "$LOG_B" 2>&1 &

# ── 等待 filesync API 就绪 ────────────────────────────────────────────────────
echo "── 等待 filesync 就绪 ──"
wait_for_url "http://127.0.0.1:${PORT_A}/api/status" "node-a" 30
wait_for_url "http://127.0.0.1:${PORT_B}/api/status" "node-b" 30

# ── 运行测试 ──────────────────────────────────────────────────────────────────
run_e2e_tests "$PORT_A" "$PORT_B" "$DATA_A" "$DATA_B" "$LOG_A" "$LOG_B"
