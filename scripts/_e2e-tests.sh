#!/usr/bin/env bash
# 共享 E2E 测试用例 — 被 e2e-pre-docker/npm 和 e2e-post-docker/npm 脚本 source 引用
# 用法: source scripts/_e2e-tests.sh
#       start_watchdog <秒>     # 全局超时看门狗（建议在 cleanup trap 里调用 stop_watchdog）
#       run_e2e_tests <PORT_A> <PORT_B> <DATA_A> <DATA_B> <LOG_A> <LOG_B>

# ── 全局超时看门狗 ────────────────────────────────────────────────────────────

# 启动看门狗：超过 N 秒后强杀整个进程组，防止测试卡死
# 用法: start_watchdog 600
_WATCHDOG_PID=""
start_watchdog() {
  local seconds=${1:-600}
  # setsid 在 macOS 不可用，改用后台子 shell + kill 父进程
  ( sleep "$seconds"
    echo ""
    echo "╔══════════════════════════════════════╗"
    echo "║  TIMEOUT: E2E 超时 ${seconds}s，强制终止  ║"
    echo "╚══════════════════════════════════════╝" >&2
    kill -TERM "$PPID" 2>/dev/null
  ) &
  _WATCHDOG_PID=$!
  disown "$_WATCHDOG_PID" 2>/dev/null || true
  echo "  看门狗启动 (PID=$_WATCHDOG_PID, 超时=${seconds}s)"
}

# 取消看门狗（在 cleanup trap 里调用）
stop_watchdog() {
  [ -n "$_WATCHDOG_PID" ] && kill "$_WATCHDOG_PID" 2>/dev/null || true
}

# ── 通用工具 ─────────────────────────────────────────────────────────────────

# 轮询等待 URL 返回 200，超时则 fatal
wait_for_url() {
  local url=$1 label=$2 max=${3:-30}
  for i in $(seq 1 "$max"); do
    curl -fsS "$url" >/dev/null 2>&1 && echo "  ✓ $label ready" && return 0
    echo "  $label $i/$max..."
    sleep 2
  done
  echo "FATAL: $label 未就绪 ($url)" >&2
  return 1
}

# 轮询等待文件内容匹配，超时则 fatal
wait_for_file() {
  local file=$1 pattern=$2 label=$3 max=${4:-20}
  for i in $(seq 1 "$max"); do
    CONTENT=$(cat "$file" 2>/dev/null || true)
    echo "$CONTENT" | grep -q "$pattern" && echo "  PASS: $label" && return 0
    echo "  waiting $i/$max..."
    sleep 3
  done
  echo "FAIL: $label 超时" >&2
  return 1
}

# 轮询等待文件被删除
wait_for_delete() {
  local file=$1 label=$2 max=${3:-20}
  for i in $(seq 1 "$max"); do
    [ ! -f "$file" ] && echo "  PASS: $label" && return 0
    echo "  waiting delete $i/$max..."
    sleep 3
  done
  echo "FAIL: $label 超时（文件仍存在）" >&2
  return 1
}

# ── 主测试入口 ────────────────────────────────────────────────────────────────

# run_e2e_tests PORT_A PORT_B DATA_A DATA_B LOG_A LOG_B
run_e2e_tests() {
  local PORT_A=$1 PORT_B=$2 DATA_A=$3 DATA_B=$4
  local LOG_A=${5:-/dev/null} LOG_B=${6:-/dev/null}

  echo ""
  echo "══════════════════════════════════════════════════"
  echo " E2E 测试开始: node-a:$PORT_A  node-b:$PORT_B"
  echo "══════════════════════════════════════════════════"

  # ── 等待两节点互相发现且互信 ────────────────────────────
  echo ""
  echo "── 等待节点间对等发现与互信 ──"
  local discovered=false
  for i in $(seq 1 60); do
    NODES_A=$(curl -fsS "http://127.0.0.1:${PORT_A}/api/nodes" 2>/dev/null || true)
    NODES_B=$(curl -fsS "http://127.0.0.1:${PORT_B}/api/nodes" 2>/dev/null || true)
    # 需要双向互信：A 信任 B 且 B 信任 A
    A_TRUSTS_B=$(echo "$NODES_A" | python3 -c "
import sys,json
try:
  nodes=json.load(sys.stdin)
  print('yes' if any(n.get('trust')=='trusted' for n in nodes) else 'no')
except: print('no')" 2>/dev/null)
    B_TRUSTS_A=$(echo "$NODES_B" | python3 -c "
import sys,json
try:
  nodes=json.load(sys.stdin)
  print('yes' if any(n.get('trust')=='trusted' for n in nodes) else 'no')
except: print('no')" 2>/dev/null)
    if [ "$A_TRUSTS_B" = "yes" ] && [ "$B_TRUSTS_A" = "yes" ]; then
      echo "  ✓ 双向互信完成 (A=$NODES_A  B=$NODES_B)"
      discovered=true
      break
    fi
    echo "  等待互信 $i/60... A→B=$A_TRUSTS_B B→A=$B_TRUSTS_A"
    sleep 3
  done
  if ! $discovered; then
    echo "WARN: 节点未完成双向互信（继续测试，可能会失败）"
    echo "  node-a log tail:" && tail -20 "$LOG_A" 2>/dev/null || true
    echo "  node-b log tail:" && tail -20 "$LOG_B" 2>/dev/null || true
  fi

  # 等待互信后的 state-sync 完成
  sleep 3

  # ── Test 1: A → B 文件同步 ────────────────────────────
  echo ""
  echo "── Test 1: A → B 文件同步 ──"
  echo "hello from node A at $(date -u)" > "${DATA_A}/test-file.txt"
  wait_for_file "${DATA_B}/test-file.txt" "hello from node A" "A→B sync" 20 \
    || { echo "  node-a log:"; tail -20 "$LOG_A" 2>/dev/null; echo "  node-b log:"; tail -20 "$LOG_B" 2>/dev/null; return 1; }

  # ── Test 2: B → A 反向同步 ────────────────────────────
  echo ""
  echo "── Test 2: B → A 反向同步 ──"
  echo "hello from node B at $(date -u)" > "${DATA_B}/from-b.txt"
  wait_for_file "${DATA_A}/from-b.txt" "hello from node B" "B→A reverse sync" 20 || return 1

  # ── Test 3: 覆盖更新同步 ──────────────────────────────
  echo ""
  echo "── Test 3: 覆盖更新同步 ──"
  echo "updated by node A at $(date -u)" > "${DATA_A}/test-file.txt"
  wait_for_file "${DATA_B}/test-file.txt" "updated by node A" "update sync" 20 || return 1

  # ── Test 4: 删除同步 ──────────────────────────────────
  echo ""
  echo "── Test 4: 删除同步 ──"
  rm -f "${DATA_A}/test-file.txt"
  wait_for_delete "${DATA_B}/test-file.txt" "delete sync" 20 || return 1

  # ── Test 5: 多文件 backfill ───────────────────────────
  echo ""
  echo "── Test 5: 多文件 backfill ──"
  echo "backfill-1" > "${DATA_A}/bf-1.txt"
  echo "backfill-2" > "${DATA_A}/bf-2.txt"
  echo "backfill-3" > "${DATA_A}/bf-3.txt"
  local synced=false
  for i in $(seq 1 20); do
    B1=$(cat "${DATA_B}/bf-1.txt" 2>/dev/null || true)
    B2=$(cat "${DATA_B}/bf-2.txt" 2>/dev/null || true)
    B3=$(cat "${DATA_B}/bf-3.txt" 2>/dev/null || true)
    if [ "$B1" = "backfill-1" ] && [ "$B2" = "backfill-2" ] && [ "$B3" = "backfill-3" ]; then
      echo "  PASS: 3 个 backfill 文件全部同步"
      synced=true; break
    fi
    echo "  waiting $i/20... B1='$B1' B2='$B2' B3='$B3'"
    sleep 3
  done
  $synced || { echo "FAIL: backfill sync 不完整"; return 1; }

  # ── Test 6: API 验证 ──────────────────────────────────
  echo ""
  echo "── Test 6: API 验证 ──"
  local STATUS_A STATUS_B NODES FILES
  STATUS_A=$(curl -fsS "http://127.0.0.1:${PORT_A}/api/status")
  STATUS_B=$(curl -fsS "http://127.0.0.1:${PORT_B}/api/status")
  echo "$STATUS_A" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok']; print('  PASS: node-a status ok')"
  echo "$STATUS_B" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok']; print('  PASS: node-b status ok')"

  NODES=$(curl -fsS "http://127.0.0.1:${PORT_A}/api/nodes")
  echo "$NODES" | python3 -c "import sys,json; n=json.load(sys.stdin); assert len(n)>0,'no peers'; print('  PASS: node-a 发现',len(n),'个节点')"

  FILES=$(curl -fsS "http://127.0.0.1:${PORT_A}/api/files")
  echo "$FILES" | python3 -c "import sys,json; f=json.load(sys.stdin); assert len(f)>0,'no files'; print('  PASS: node-a 已索引',len(f),'个文件')"
  echo "$FILES" | python3 -c "import sys,json; f=json.load(sys.stdin); assert any(x.get('syncId')=='e2e-sync' for x in f); print('  PASS: syncId 正确')"

  curl -fsS "http://127.0.0.1:${PORT_A}/ui" | grep -q "FileSync" && echo "  PASS: Web UI 响应正常"

  echo ""
  echo "══════════════════════════════════════════════════"
  echo " ✅  全部 6 项 E2E 测试通过"
  echo "══════════════════════════════════════════════════"
}
