#!/usr/bin/env bash
# E2E 阶段1-npm — 本地 npm pack 后安装验证
# 用法: bash scripts/e2e-pre-npm.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/_e2e-kubo.sh"
source "${SCRIPT_DIR}/_e2e-tests.sh"

# ── 常量 ─────────────────────────────────────────────────────────────────────
NETWORK="e2e-pre-npm-net"
KUBO_A="e2e-pre-npm-kubo-a"
KUBO_B="e2e-pre-npm-kubo-b"
KUBO_PORT_A=15101
KUBO_PORT_B=15102
BASE_DIR="/tmp/e2e-pre-npm"
PKG_DIR="/tmp/e2e-pre-npm-pkg"
DATA_A="${BASE_DIR}/data-a"
DATA_B="${BASE_DIR}/data-b"
HOME_A="${BASE_DIR}/home-a"
HOME_B="${BASE_DIR}/home-b"
PORT_A=18386
PORT_B=28386
PID_A=""
PID_B=""

# ── 清理 ─────────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "── 清理 E2E pre-npm 资源 ──"
  stop_watchdog
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null || true
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null || true
  docker rm -f "$KUBO_A" 2>/dev/null || true
  docker rm -f "$KUBO_B" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
  echo "  已清理"
}
trap cleanup EXIT

# ── 初始化目录 ────────────────────────────────────────────────────────────────
echo "── 初始化目录 ──"
rm -rf "$BASE_DIR" "$PKG_DIR"
mkdir -p "$DATA_A" "$DATA_B" "$HOME_A" "$HOME_B" "$PKG_DIR"

# ── 打包并安装 ────────────────────────────────────────────────────────────────
echo ""
echo "══════════════ E2E pre-npm 开始 ══════════════"
start_watchdog 600
echo "── npm pack → 安装到隔离目录 ──"
cd "$REPO_ROOT"
TARBALL=$(npm pack --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['filename'])")
echo "  打包: $TARBALL"

cd "$PKG_DIR"
npm init -y >/dev/null
npm install "${REPO_ROOT}/${TARBALL}" >/dev/null
FILESYNC_BIN="${PKG_DIR}/node_modules/.bin/filesync-kubo"
[ -f "$FILESYNC_BIN" ] || FILESYNC_BIN="${PKG_DIR}/node_modules/filesync-kubo/dist/core/main.js"
echo "  ✓ 安装完成: $FILESYNC_BIN"

# 清理 tarball
rm -f "${REPO_ROOT}/${TARBALL}"

# ── 生成配置 ─────────────────────────────────────────────────────────────────
_write_config() {
  local dir=$1 node_name=$2 port=$3 data_path=$4
  cat > "${dir}/config.json" <<EOF
{
  "webAuth": {"username": "", "passwordHash": ""},
  "name": "${node_name}",
  "webPort": ${port},
  "encryptionKey": "e2esharedencryptionkeyfortesting01",
  "syncFolders": [
    {"id": "sf", "syncId": "e2e-sync", "localPath": "${data_path}", "historyCount": 5, "encrypt": true}
  ]
}
EOF
}

_write_config "$HOME_A" "node-a" "$PORT_A" "$DATA_A"
_write_config "$HOME_B" "node-b" "$PORT_B" "$DATA_B"

# ── 启动 Kubo ─────────────────────────────────────────────────────────────────
setup_kubo_pair "$NETWORK" "$KUBO_A" "$KUBO_B" "$KUBO_PORT_A" "$KUBO_PORT_B"

# ── 启动 filesync 进程 ────────────────────────────────────────────────────────
echo ""
echo "── 启动 filesync 进程 ──"
LOG_A="${BASE_DIR}/app-a.log"
LOG_B="${BASE_DIR}/app-b.log"

FILESYNC_HOME="$HOME_A" \
FILESYNC_HOST=127.0.0.1 \
IPFS_API="http://127.0.0.1:${KUBO_PORT_A}/api/v0" \
FILESYNC_DEV_AUTO_TRUST=true \
FILESYNC_ANNOUNCE_INTERVAL=5000 \
  node "${PKG_DIR}/node_modules/filesync-kubo/dist/core/main.js" > "$LOG_A" 2>&1 &
PID_A=$!

FILESYNC_HOME="$HOME_B" \
FILESYNC_HOST=127.0.0.1 \
IPFS_API="http://127.0.0.1:${KUBO_PORT_B}/api/v0" \
FILESYNC_DEV_AUTO_TRUST=true \
FILESYNC_ANNOUNCE_INTERVAL=5000 \
  node "${PKG_DIR}/node_modules/filesync-kubo/dist/core/main.js" > "$LOG_B" 2>&1 &
PID_B=$!

echo "  node-a PID=$PID_A  node-b PID=$PID_B"

# ── 等待就绪 ─────────────────────────────────────────────────────────────────
echo "── 等待 filesync 就绪 ──"
wait_for_url "http://127.0.0.1:${PORT_A}/api/status" "node-a" 30
wait_for_url "http://127.0.0.1:${PORT_B}/api/status" "node-b" 30

run_e2e_tests "$PORT_A" "$PORT_B" "$DATA_A" "$DATA_B" "$LOG_A" "$LOG_B"
