# 开发调试测试经验文档

> 本文档记录 filesync-kubo 项目开发过程中遇到的关键问题、根因分析和解决方案。
> 适用于后续开发者快速定位同类问题，避免重复踩坑。

---

## 1. Kubo Pubsub HTTP API 必须使用 Multibase 编码

**现象**：调用 `/api/v0/pubsub/sub` 或 `/pub` 返回 HTTP 500，错误信息：
```
"URL arg must be multibase encoded"
```

**影响范围**：所有 kubo 版本（v0.29 ~ v0.40.1 均已验证）。

**根因**：kubo HTTP API 的 pubsub 端点要求 topic 参数使用 [multibase](https://github.com/multiformats/multibase) 编码，不接受原始字符串。此外 `/pubsub/pub` 的 data 参数必须通过 FormData `file` 字段上传，而非 URL `arg` 参数。

**解法**：
```typescript
// topic 编码: base64url 前缀 'u'
const mbTopic = 'u' + Buffer.from(topic).toString('base64url');

// publish: 数据通过 FormData file 上传
const form = new FormData();
form.append('file', new Blob([data]), 'data');
await fetch(`${api}/pubsub/pub?arg=${mbTopic}`, { method: 'POST', body: form });
```

**subscribe 响应的 data 字段也是 multibase 编码**：
```typescript
// kubo 返回 { from, data, seqno, topicIDs }
// data 以 'u' 开头时为 base64url 编码，否则为 plain base64
const raw = msg.data.startsWith('u')
  ? Buffer.from(msg.data.slice(1), 'base64url').toString('utf8')
  : Buffer.from(msg.data, 'base64').toString('utf8');
```

**教训**：项目原有单元测试全部使用 `MemoryIpfsClient`（内存模拟），从未触及真实 kubo API，导致此 bug 隐藏至 E2E 集成测试阶段才暴露。**核心 I/O 层必须有针对真实后端的集成测试。**

---

## 2. Kubo v0.40.1 Bitswap 协议不生效

**现象**：两个 kubo v0.40.1 节点通过 `swarm connect` 连接成功，`swarm/peers` 显示对方在线，但 `ipfs cat <CID>` 始终超时。`bitswap/stat` 显示 `Peers: []`。

**诊断过程**：
```bash
# 关键诊断命令：verbose 查看 stream 协议列表
curl -X POST "http://127.0.0.1:5001/api/v0/swarm/peers?verbose=true"
# 结果只有 kad + meshsub，没有 bitswap 协议
# Streams: ['/ipfs/lan/kad/1.0.0', '/meshsub/1.3.0']
```

**根因**：kubo v0.40.1 的 swarm 连接不协商 bitswap 协议流，导致内容交换完全失败。`routing/findprovs` 能找到 provider，但无法通过 bitswap 获取数据块。

**解法**：固定使用 kubo v0.32.0，该版本 bitswap 工作正常。

**影响文件**：
- `scripts/_e2e-kubo.sh` → `ipfs/kubo:v0.32.0`
- `.github/workflows/e2e-published.yml` → `ipfs/kubo:v0.32.0`

**教训**：IPFS/kubo 版本升级可能引入破坏性变更，尤其是协议层。E2E 脚本应固定 kubo 版本，升级时需单独验证 bitswap 连通性。

---

## 3. Kubo 容器 repo.lock 冲突

**现象**：在 `docker exec kubo ipfs config ...` 时报错：
```
Error: someone else has the lock
```

**根因**：kubo v0.18+ 在 daemon 运行期间持有 `repo.lock`，所有写入配置的 CLI 命令都会失败。

**解法**：使用 kubo 的 `/container-init.d/` 机制——将配置脚本挂载到该目录，kubo 会在 **daemon 启动前** 自动执行：
```bash
# 创建初始化脚本
cat > init/001-config.sh << 'EOF'
#!/bin/sh
ipfs config --bool Pubsub.Enabled true
ipfs config Addresses.API "/ip4/0.0.0.0/tcp/5001"
ipfs bootstrap rm --all
EOF

# 挂载到 container-init.d
docker run -d -v ./init:/container-init.d:ro ipfs/kubo:v0.32.0
```

---

## 4. E2E 网络隔离：bootstrap 清空 + peering

**现象**：两个本地 kubo 节点的 `ipfs cat` 跨节点获取内容超时，但 `swarm/peers` 显示大量 peer。

**根因**：默认 kubo 通过 bootstrap 连接到公网 IPFS 网络。bitswap 的请求被路由到随机公网节点，而不是本地配对节点。

**解法**：三步隔离策略
```bash
# 1. 清空 bootstrap，阻止连接公网
ipfs bootstrap rm --all

# 2. 双向 swarm connect 建立初始连接
docker exec kubo-b ipfs swarm connect "/dns4/kubo-a/tcp/4001/p2p/${PEER_A}"

# 3. 添加 peering 保持持久连接（断开后自动重连）
curl -X POST "http://127.0.0.1:5001/api/v0/swarm/peering/add?arg=/dns4/kubo-b/tcp/4001/p2p/${PEER_B}"
```

**验证隔离效果**：`swarm/peers` 应只显示配对节点（通常 1-2 条连接），不应出现任何公网 peer。

---

## 5. Pubsub 启动竞态：announce 丢失

**现象**：节点 A 先启动并发送 announce，节点 B 后启动。B 永远不会自动信任 A（自动信任仅在收到 announce 时触发），需等待 A 的下一轮周期广播（默认 30 秒）。

**解法**：
- 添加 `FILESYNC_ANNOUNCE_INTERVAL` 环境变量（默认 30000ms）
- E2E 测试中设为 5000ms 加速收敛
- E2E 测试等待**双向互信**（A 信任 B 且 B 信任 A）再开始测试

---

## 6. `void` 吞掉 async 错误

**现象**：B 收到 file-changed 消息（日志可见），但 `onRemoteChange` 的执行结果（成功或失败）完全没有日志输出。

**根因**：`pubsub.ts` 中使用 `void this.options.onDirectMessage?.(from, msg)` 调用 async handler。`void` 关键字丢弃了 Promise，如果 handler 内部抛出异常，该 rejection 成为 unhandled promise rejection，在 Node.js 默认配置下**静默消失**。

**解法**：在业务 handler 内部添加 `.catch()` 保护：
```typescript
// 不要这样：
void this.options.onDirectMessage?.(from, msg);

// 业务层 handler 自行 catch：
case 'file-changed': {
  await engine.onRemoteChange(folder, remote).catch((err) =>
    console.warn(`onRemoteChange error [${remote.path}]:`, err));
}
```

**教训**：对所有 `void asyncFn()` 模式保持警惕。在需要知道执行结果的场景，必须 await 或 .catch()。

---

## 7. Docker Volume + Chokidar 文件监听

**验证结论**：macOS 上 Docker volume mount（bind mount）的文件变更**可以**被容器内的 chokidar 正确检测到。

**配置要点**：
```typescript
chokidar.watch(folder.localPath, {
  persistent: true,
  ignoreInitial: false,  // 启动时扫描已有文件
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
```

`awaitWriteFinish` 是关键配置——防止在文件还在写入时就触发事件。

---

## 8. E2E 测试架构设计要点

### 看门狗超时
所有 E2E 脚本在入口处启动一个后台看门狗进程，超时后 `kill -TERM` 主进程组并清理容器。防止测试因网络/pubsub 问题永久挂起。

```bash
_watchdog() {
  sleep "$E2E_TIMEOUT"
  echo "FATAL: E2E 超时 (${E2E_TIMEOUT}s)"
  kill -TERM -$$  # 杀掉整个进程组
}
_watchdog &
WATCHDOG_PID=$!
trap "kill $WATCHDOG_PID 2>/dev/null" EXIT
```

### 端口隔离
不同 E2E 场景使用不同端口段，避免并行运行时冲突：

| 场景 | kubo 端口 | filesync 端口 |
|------|----------|--------------|
| pre-docker  | 15001/15002 | 18384/28384 |
| post-docker | 15003/15004 | 18385/28385 |
| pre-npm     | 15101/15102 | 18386/28386 |
| post-npm    | 15103/15104 | 18387/28387 |

### 共享测试函数
`_e2e-tests.sh` 定义 6 项标准测试（A→B 同步、B→A 反向、覆盖更新、删除、多文件 backfill、API 验证），被所有 4 个 E2E 入口脚本复用。

---

## 9. 诊断命令速查

```bash
# 检查 kubo pubsub 是否启用
curl -X POST "http://127.0.0.1:5001/api/v0/config?arg=Pubsub.Enabled"

# 检查 swarm 连接及协议流（关键：确认有 bitswap）
curl -X POST "http://127.0.0.1:5001/api/v0/swarm/peers?verbose=true"

# 检查 bitswap 状态（Peers 不为空才正常）
curl -X POST "http://127.0.0.1:5001/api/v0/bitswap/stat"

# 检查内容 provider 路由
curl -X POST "http://127.0.0.1:5001/api/v0/routing/findprovs?arg=<CID>&num-providers=1"

# 手动测试 pubsub publish（multibase topic + FormData）
TOPIC=$(echo -n "test-topic" | base64 | tr '+/' '-_' | tr -d '=')
curl -X POST "http://127.0.0.1:5001/api/v0/pubsub/pub?arg=u${TOPIC}" \
  -F "file=@-;filename=data" <<< "hello"

# 检查节点互信状态
curl http://127.0.0.1:8384/api/nodes
# 期望: trust="trusted" 且 trusts_me=1

# 检查文件索引
curl http://127.0.0.1:8384/api/files
```

---

## 10. 本地全流程开发工作流

```
Phase 1: 本地构建 + 全量测试
  npm run build → npm test → docker build
  → e2e-pre-docker.sh (容器版 6 项 E2E)
  → e2e-pre-npm.sh (npm 包版 6 项 E2E)

Phase 2: 推送 + 远程 CI/发布
  git push --tags → GitHub Actions CI + Release
  → GHCR / npmjs / GitHub Packages 三通道发布

Phase 3: 拉取远端构建 + 本地 E2E 验证
  → e2e-post-docker.sh (用 GHCR 镜像)
  → e2e-post-npm.sh (用 npmjs 包)
```

所有测试在本地先通过，再推送。远端只做轻量 CI，真正的 E2E 验证在本地完成。
