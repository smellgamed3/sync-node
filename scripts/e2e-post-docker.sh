#!/usr/bin/env bash
# E2E 阶段3-Docker — 拉取 GHCR 远端镜像并验证
# 需要: GITHUB_TOKEN 环境变量（read:packages 权限）
# 用法: bash scripts/e2e-post-docker.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_e2e-kubo.sh"
source "${SCRIPT_DIR}/_e2e-tests.sh"

# ── 常量 ─────────────────────────────────────────────────────────────────────
GHCR_IMAGE="ghcr.io/smellgamed3/filesync-kubo:latest"
NETWORK="e2e-post-docker-net"
KUBO_A="e2e-post-kubo-a"
KUBO_B="e2e-post-kubo-b"
APP_A="e2e-post-app-a"
APP_B="e2e-post-app-b"
BASE_DIR="/tmp/e2e-post-docker"
DATA_A="${BASE_DIR}/data-a"
DATA_B="${BASE_DIR}/data-b"
HOME_A="${BASE_DIR}/home-a"
HOME_B="${BASE_DIR}/home-b"
PORT_A=18385
PORT_B=28385
KUBO_PORT_A=15003
KUBO_PORT_B=15004

# ── 验证 Token ────────────────────────────────────────────────────────────────
if [ -z "${GITHUB_TOKEN:-}" ]; then
  # 尝试从 gh CLI 获取
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
  if [ -z "$GITHUB_TOKEN" ]; then
    echo "ERROR: 需要 GITHUB_TOKEN 环境变量（read:packages）或已登录 gh CLI" >&2
    exit 1
  fi
  export GITHUB_TOKEN
fi

# ── 清理 ─────────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "── 清理 E2E post-docker 资源 ──"
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

_write_config() {
  local dir=$1 node_name=$2 port=$3
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

# ── 拉取远端镜像 ──────────────────────────────────────────────────────────────
echo ""
echo "══════════════ E2E post-docker 开始 ══════════════"
start_watchdog 600
echo "── 从 GHCR 拉取镜像 ──"
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$(gh api user --jq .login 2>/dev/null || echo 'user')" --password-stdin 2>/dev/null || \
  docker login ghcr.io -u smellgamed3 --password-stdin <<< "$GITHUB_TOKEN"
docker pull "$GHCR_IMAGE"
echo "  ✓ 镜像拉取完成: $GHCR_IMAGE"

# ── 启动 Kubo ─────────────────────────────────────────────────────────────────
setup_kubo_pair "$NETWORK" "$KUBO_A" "$KUBO_B" "$KUBO_PORT_A" "$KUBO_PORT_B"

_write_config "$HOME_A" "node-a" "8384"
_write_config "$HOME_B" "node-b" "8384"

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
  "$GHCR_IMAGE"

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
  "$GHCR_IMAGE"

docker logs -f "$APP_A" > "$LOG_A" 2>&1 &
docker logs -f "$APP_B" > "$LOG_B" 2>&1 &

echo "── 等待 filesync 就绪 ──"
wait_for_url "http://127.0.0.1:${PORT_A}/api/status" "node-a" 30
wait_for_url "http://127.0.0.1:${PORT_B}/api/status" "node-b" 30

run_e2e_tests "$PORT_A" "$PORT_B" "$DATA_A" "$DATA_B" "$LOG_A" "$LOG_B"
