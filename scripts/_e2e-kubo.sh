#!/usr/bin/env bash
# 共享 Kubo 节点启动/配置逻辑（Docker 容器模式）
# 用法: source scripts/_e2e-kubo.sh
#       setup_kubo_pair <NETWORK> <NAME_A> <NAME_B> <HOST_PORT_A> <HOST_PORT_B>
# 结束后设置环境变量: E2E_PEER_A  E2E_PEER_B
#
# 注意: kubo v0.18+ 在 daemon 运行时会持有 repo.lock，`ipfs config` 无法并发执行。
#       解决方案: 通过 /container-init.d/ 挂载脚本，在 daemon 启动前完成配置。

# 创建 kubo 初始化脚本目录（每次调用均重新生成）
_KUBO_INIT_DIR="/tmp/_e2e-kubo-init-$$"

_ensure_kubo_init_dir() {
  mkdir -p "$_KUBO_INIT_DIR"
  cat > "${_KUBO_INIT_DIR}/001-e2e-config.sh" << 'INITSCRIPT'
#!/bin/sh
# 在 kubo daemon 启动前配置
ipfs config --bool Pubsub.Enabled true
ipfs config Addresses.API "/ip4/0.0.0.0/tcp/5001"
# 隔离网络：清空 bootstrap 防止连接公网，确保 bitswap 仅在本地节点间工作
ipfs bootstrap rm --all
echo "[init] Pubsub 已启用，API 已绑定到 0.0.0.0:5001，bootstrap 已清空"
INITSCRIPT
  chmod +x "${_KUBO_INIT_DIR}/001-e2e-config.sh"
}

# setup_kubo_pair NETWORK NAME_A NAME_B HOST_PORT_A HOST_PORT_B
setup_kubo_pair() {
  local NETWORK=$1 NAME_A=$2 NAME_B=$3 PORT_A=$4 PORT_B=$5

  _ensure_kubo_init_dir

  echo "── 创建 Docker 网络 $NETWORK ──"
  docker network create "$NETWORK" 2>/dev/null || true

  echo "── 启动 $NAME_A (host port $PORT_A) ──"
  docker rm -f "$NAME_A" 2>/dev/null || true
  docker run -d --name "$NAME_A" \
    --network "$NETWORK" \
    -p "${PORT_A}:5001" \
    -v "${_KUBO_INIT_DIR}:/container-init.d:ro" \
    ipfs/kubo:v0.32.0

  echo "── 启动 $NAME_B (host port $PORT_B) ──"
  docker rm -f "$NAME_B" 2>/dev/null || true
  docker run -d --name "$NAME_B" \
    --network "$NETWORK" \
    -p "${PORT_B}:5001" \
    -v "${_KUBO_INIT_DIR}:/container-init.d:ro" \
    ipfs/kubo:v0.32.0

  # 等待 API 就绪（init 脚本运行后 daemon 启动）
  _wait_kubo_api "$PORT_A" "$NAME_A"
  _wait_kubo_api "$PORT_B" "$NAME_B"

  # 验证 Pubsub 是否已启用
  _verify_pubsub "$PORT_A" "$NAME_A"
  _verify_pubsub "$PORT_B" "$NAME_B"

  # 获取 Peer ID
  E2E_PEER_A=$(curl -s -X POST "http://127.0.0.1:${PORT_A}/api/v0/id" | python3 -c "import sys,json; print(json.load(sys.stdin)['ID'])")
  E2E_PEER_B=$(curl -s -X POST "http://127.0.0.1:${PORT_B}/api/v0/id" | python3 -c "import sys,json; print(json.load(sys.stdin)['ID'])")
  echo "  Peer A: $E2E_PEER_A"
  echo "  Peer B: $E2E_PEER_B"
  export E2E_PEER_A E2E_PEER_B

  # 连接 swarm 并建立持久 peering（确保 bitswap 直连）
  echo "── 连接 Kubo swarm ──"
  docker exec "$NAME_A" ipfs swarm connect "/dns4/${NAME_B}/tcp/4001/p2p/${E2E_PEER_B}" 2>&1 || true
  docker exec "$NAME_B" ipfs swarm connect "/dns4/${NAME_A}/tcp/4001/p2p/${E2E_PEER_A}" 2>&1 || true

  # 添加 peering 保证持久的 bitswap 连接
  curl -sS -X POST "http://127.0.0.1:${PORT_A}/api/v0/swarm/peering/add?arg=/dns4/${NAME_B}/tcp/4001/p2p/${E2E_PEER_B}" >/dev/null 2>&1 || true
  curl -sS -X POST "http://127.0.0.1:${PORT_B}/api/v0/swarm/peering/add?arg=/dns4/${NAME_A}/tcp/4001/p2p/${E2E_PEER_A}" >/dev/null 2>&1 || true
  sleep 3

  local PEERS_A PEERS_B
  PEERS_A=$(docker exec "$NAME_A" ipfs swarm peers 2>/dev/null | wc -l | tr -d ' ')
  PEERS_B=$(docker exec "$NAME_B" ipfs swarm peers 2>/dev/null | wc -l | tr -d ' ')
  echo "  $NAME_A swarm peers: $PEERS_A"
  echo "  $NAME_B swarm peers: $PEERS_B"

  # 清理临时 init 目录
  rm -rf "$_KUBO_INIT_DIR"
}

_wait_kubo_api() {
  local port=$1 name=$2
  for i in $(seq 1 40); do
    curl -fsS -X POST "http://127.0.0.1:${port}/api/v0/id" >/dev/null 2>&1 && echo "  ✓ $name API ready" && return 0
    echo "  $name api $i/40..."
    sleep 3
  done
  echo "FATAL: $name API 超时 (port $port)" >&2
  docker logs "$name" 2>&1 | tail -20
  return 1
}

_verify_pubsub() {
  local port=$1 name=$2
  # 通过 HTTP API 检查 Pubsub 配置（避免 repo.lock 冲突）
  local val
  val=$(curl -s -X POST "http://127.0.0.1:${port}/api/v0/config?arg=Pubsub.Enabled" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Value','?'))" 2>/dev/null || echo "unknown")
  if [ "$val" = "True" ] || [ "$val" = "true" ]; then
    echo "  ✓ $name pubsub enabled"
  else
    echo "  WARN: $name pubsub 状态=$val（可能未启用）"
  fi
}
