# Relay 节点设计方案

> **状态**: 设计草案
> **日期**: 2026-04-15
> **版本**: filesync-kubo v0.1.x

## 1. 问题陈述

当前 filesync-kubo 是纯 P2P 架构，所有节点完全对等。存在三个关键痛点：

1. **PubSub 临时性** — Kubo pubsub 是火即忘（fire-and-forget），节点离线时所有消息丢失
2. **无重连补发** — `state-sync` 仅在信任建立（`onMutualTrust`）时触发，节点断线重连后不会自动补发遗漏的变更
3. **内容可用性** — 若唯一的 IPFS pinner（原始上传节点）离线，其他节点无法通过 `ipfs cat` 获取加密块

**目标**: 引入一种 "relay 节点" 角色，作为始终在线的基础设施，解决上述三个问题，且**不接触明文数据**。

## 2. 方案选型

| 方案 | 改动量 | 离线补发 | 内容可用 | NAT穿透 | 安全面 |
|------|--------|---------|---------|---------|--------|
| A. 纯 Kubo RelayService | 零代码 | ❌ | ❌ | ✅ | 最小 |
| **B. Relay 节点模式** | ~100行 | ✅ | ✅ | ✅¹ | 中等 |
| C. 独立消息代理 | ~300行 | ✅ | ❌ | ❌ | 较小 |

> ¹ 方案B 中的 Kubo 实例天然参与 libp2p 网络，可同时配置 RelayService 获得 NAT 穿透能力。

**选定方案B**: 代码改动最小、覆盖问题最全、与现有架构自然融合。

## 3. 架构概览

```
普通节点 A                     Relay 节点 R                    普通节点 B
┌─────────────┐               ┌──────────────┐               ┌─────────────┐
│ Watcher     │               │ (无 Watcher) │               │ Watcher     │
│ SyncEngine  │               │ SyncEngine   │               │ SyncEngine  │
│             │               │ (relay 模式) │               │             │
│ TrustMgr    │               │ TrustMgr     │               │ TrustMgr    │
│ PubSubMgr   │◄──pubsub───► │ PubSubMgr    │◄──pubsub───► │ PubSubMgr   │
│ DB          │               │ DB (元数据)  │               │ DB          │
│ Kubo        │◄──bitswap──► │ Kubo (pin)   │◄──bitswap──► │ Kubo        │
└─────────────┘               └──────────────┘               └─────────────┘
     有 encryptionKey              无 encryptionKey               有 encryptionKey
     有 syncFolders                无 syncFolders                 有 syncFolders
```

### 数据流

**正常同步（A→B 都在线）**:
```
A 变更文件 → encrypt → ipfs.add → broadcastToTrusted
  ├→ B 收到 file-changed → ipfs.cat → decrypt → 写入本地 ✅
  └→ R 收到 file-changed → DB存元数据 + ipfs.pin ✅（不解密）
```

**离线补发（B 曾离线）**:
```
B 上线 → 发送 announce
  → R 检测到 B 的 announce
  → R 是 B 的 mutual-trust
  → R 发送 state-sync（所有文件版本）给 B
  → B 逐个 ipfs.cat + decrypt + 写入 ✅
     （R 已 pin 了 CID，即使 A 离线也可获取）
```

## 4. 详细设计

### 4.1 配置变更

**AppConfig** 新增字段：

```typescript
interface AppConfig {
  // ... 现有字段
  relay?: boolean;              // 启用 relay 模式
  relayRetentionDays?: number;  // 元数据保留天数，默认 30
}
```

**环境变量**：
- `FILESYNC_RELAY=true` — 等效 config 中 `relay: true`

**relay 模式配置约束**：
- `syncFolders` 应为空数组（无本地同步目录）
- `encryptionKey` 不需要（也不应设置，防止误用）
- 节点名称建议设为 `relay-xxx` 便于识别

### 4.2 SyncEngine 变更

新增两个 relay 专用方法，不修改现有方法逻辑：

```typescript
// 新增方法
async onRelayStore(remote: FileVersion): Promise<void> {
  const existing = this.options.db.getFile(remote.syncId, remote.path);
  if (existing?.cid === remote.cid) return; // 已有，跳过

  if (existing) {
    this.options.db.addHistory(remote.syncId, existing);
  }
  this.options.db.upsertFile(remote.syncId, remote);
  await this.options.ipfs.pin(remote.cid);
}

async onRelayDelete(payload: { syncId: string; path: string }): Promise<void> {
  const existing = this.options.db.getFile(payload.syncId, payload.path);
  if (!existing) return;

  this.options.db.addHistory(payload.syncId, existing);
  this.options.db.deleteFile(payload.syncId, payload.path);
  // 注意：不 unpin CID，保留历史内容可用性
}
```

### 4.3 main.ts 变更

relay 模式下的行为差异：

```typescript
// 1. 跳过 Watcher
if (!config.relay) {
  const watcher = new Watcher(engine);
  watcher.start(config.syncFolders);
}

// 2. onAnnounce 增加重连补发
onAnnounce: async (from, msg) => {
  // 开发模式自动信任（现有逻辑）
  if (process.env.FILESYNC_DEV_AUTO_TRUST === 'true') {
    await trust.setTrust(from, 'trusted');
  }
  // relay 模式：信任节点上线时补发 state-sync
  if (config.relay && trust.isMutualTrust(from)) {
    await engine.triggerStateSync(from);
  }
},

// 3. onDirectMessage 中 file-changed/file-deleted 的处理
case 'file-changed': {
  if (!trust.isMutualTrust(from)) return;
  const remote = msg.payload as FileVersion;
  if (config.relay) {
    await engine.onRelayStore(remote);
  } else {
    const folder = config.syncFolders.find(f => f.syncId === remote.syncId);
    if (folder) await engine.onRemoteChange(folder, remote);
  }
  break;
}

case 'file-deleted': {
  if (!trust.isMutualTrust(from)) return;
  const payload = msg.payload as { syncId: string; path: string };
  if (config.relay) {
    await engine.onRelayDelete(payload);
  } else {
    const folder = config.syncFolders.find(f => f.syncId === payload.syncId);
    if (folder) await engine.onRemoteDelete(folder, payload);
  }
  break;
}

// 4. state-sync 处理
case 'state-sync': {
  const payload = msg.payload as { targetPeerId?: string; files?: FileVersion[] };
  if (payload.targetPeerId && payload.targetPeerId !== peerId) return;
  for (const remote of payload.files ?? []) {
    if (config.relay) {
      await engine.onRelayStore(remote);
    } else {
      const folder = config.syncFolders.find(f => f.syncId === remote.syncId);
      if (folder) await engine.onRemoteChange(folder, remote);
    }
  }
  break;
}
```

### 4.4 信任模型

**不引入新的信任级别**。复用现有的 `trusted`/`untrusted` 二元模型：

```
节点 A ──mutual trust──► Relay R ◄──mutual trust── 节点 B

A 信任 R: R 可以接收 A 的 file-changed 消息
R 信任 A: R 的 state-sync 消息能被 A 接受
（反向同理）
```

**信任建立流程**：
1. 普通节点 A 在 Web UI 中将 Relay R 设为 `trusted`
2. Relay R 将 A 设为 `trusted`（可通过 API 或 DEV_AUTO_TRUST）
3. 双向信任建立，触发 `onMutualTrust` → A 发送 state-sync 给 R
4. R 存储所有文件元数据 + pin CIDs

### 4.5 元数据保留与清理

relay 节点需要定期清理过期数据：

```typescript
// 定期任务（每小时运行）
async cleanupExpired(): Promise<void> {
  const cutoff = Date.now() - this.retentionDays * 86400_000;
  const expired = this.db.getHistoryBefore(cutoff);
  for (const entry of expired) {
    if (!this.db.isCidReferenced(entry.cid)) {
      await this.ipfs.unpin(entry.cid);
    }
    this.db.deleteHistory(entry.id);
  }
}
```

- 默认保留 30 天的历史版本
- 当前版本（files 表）永久保留
- 不再被引用的 CID 执行 unpin

## 5. 安全与隐私模型

### 5.1 relay 节点能看到什么

| 数据 | 可见性 | 风险 |
|------|--------|------|
| 文件内容 | ❌ 不可见（AES-256-GCM 加密） | 无 |
| 文件名/路径 | ⚠️ **可见**（FileVersion.path 明文） | 中等 |
| 文件大小 | ⚠️ **可见**（FileVersion.size） | 低 |
| 同步目录 ID | ⚠️ 可见（syncId） | 低 |
| 通信关系 | ⚠️ 可见（peer ID、时间戳） | 低 |
| 加密密钥 | ❌ 不可见（relay 无 encryptionKey） | 无 |

### 5.2 威胁模型

**场景：relay 节点被攻破**
- 攻击者获得：文件路径、大小、同步时间模式
- 攻击者不能获得：文件内容
- 影响：元数据泄露，但无数据泄露
- 缓解：relay 应部署在受信基础设施上

**场景：relay 运营者恶意**
- 同上。relay 运营者可做流量分析，但无法解密内容
- 这是有意的设计取舍：relay 需要元数据才能路由和存储

### 5.3 未来增强方向（不在本次范围）

- **路径加密**: 用 syncId 派生的密钥加密 FileVersion.path，relay 只看到不透明标识符
- **混淆文件大小**: 填充到固定块大小
- **零知识中继**: 完全加密 payload，relay 仅做不透明的存储转发

## 6. 部署方式

### 6.1 Docker Compose（推荐）

```yaml
services:
  kubo-relay:
    image: ipfs/kubo:v0.32.0
    environment:
      - IPFS_PROFILE=server
    volumes:
      - kubo_relay_data:/data/ipfs
    ports:
      - "4001:4001"      # swarm（必须开放）
      # 注意：5001 不对外暴露
    healthcheck:
      test: ["CMD", "ipfs", "id"]
      interval: 10s
      retries: 3

  filesync-relay:
    image: ghcr.io/smellgamed3/filesync-kubo:latest
    depends_on:
      kubo-relay:
        condition: service_healthy
    environment:
      - IPFS_API=http://kubo-relay:5001/api/v0
      - FILESYNC_HOST=0.0.0.0
      - FILESYNC_RELAY=true
    ports:
      - "8384:8384"      # Web UI（管理信任关系）
    volumes:
      - relay_data:/root/.filesync

volumes:
  kubo_relay_data:
  relay_data:
```

### 6.2 配置示例

```json
{
  "name": "relay-central",
  "relay": true,
  "relayRetentionDays": 30,
  "webPort": 8384,
  "webAuth": { "username": "admin", "passwordHash": "..." },
  "syncFolders": []
}
```

## 7. 测试策略

### 7.1 单元测试

- `SyncEngine.onRelayStore()`: 验证元数据存储 + pin 调用
- `SyncEngine.onRelayDelete()`: 验证元数据删除
- relay 模式下不调用 `ipfs.cat` / `decrypt` / `writeFile`

### 7.2 E2E 集成测试

**场景1：离线补发**
```
1. 启动 A + R，建立 mutual trust
2. A 创建文件 test.txt → R 存储元数据 + pin
3. 启动 B，与 R 建立 mutual trust
4. B 与 A 建立 mutual trust
5. A 下线
6. B 上线 → R 发送 state-sync → B 获取 test.txt ✅
   （通过 R 的 Kubo pin，B 可从 R 的 bitswap 获取加密块）
```

**场景2：relay 不解密**
```
1. 验证 R 的 config 无 encryptionKey
2. 验证 R 的 DB 有 FileVersion 记录（含 CID）
3. 验证 R 的 IPFS 有 pinned CID
4. 验证 R 的本地文件系统无任何同步文件
```

**场景3：信任隔离**
```
1. R 与 A 互信，R 与 B 互信，A 与 B 不互信
2. A 变更文件 → R 存储
3. B 上线 → R 发 state-sync 给 B
4. B 收到 state-sync（来自 R），可获取内容 ✅
   注意：这意味着 R 实际上在 A-B 之间桥接了数据！
   这是预期行为还是安全隐患？→ 见第 8 节讨论
```

## 8. 开放问题与决策

### 8.1 信任传递性问题

**场景**: A↔R 互信，B↔R 互信，但 A↔B 不互信

当前设计下，R 收到 A 的 file-changed → R 存储 → B 上线 → R 发 state-sync 给 B → B 获得 A 的文件。

这**绕过了 A-B 之间的信任检查**。

**决策选项**:

1. **接受（推荐）** — relay 的用途就是桥接，所有接入 relay 的节点隐式组成一个同步组。管理员通过控制 relay 的信任列表来控制谁能参与。
2. **限制** — relay 的 state-sync 携带原始 `updatedBy`，接收端检查是否信任原始作者。
3. **syncId 隔离** — relay 按 syncId 区分，只转发匹配的文件版本。

推荐选项 1，理由：relay 本身就是一个受控的基础设施角色，由管理员管理信任白名单。

### 8.2 announce 频率与补发风暴

节点每次 announce 都触发 relay 的 state-sync，当文件量大时可能造成消息风暴。

**缓解方案**: 记录上次对每个 peer 的 state-sync 时间，设置最小间隔（如 60 秒）。

```typescript
private lastSyncTime = new Map<string, number>();

shouldSync(peerId: string): boolean {
  const last = this.lastSyncTime.get(peerId) ?? 0;
  if (Date.now() - last < 60_000) return false;
  this.lastSyncTime.set(peerId, Date.now());
  return true;
}
```

### 8.3 增量同步优化（未来）

当前 state-sync 发送全量文件列表。未来可优化为：
- 基于时间戳的增量同步（只发送上次同步后的变更）
- 基于版本向量的差异同步

不在本次实现范围，但设计应不阻碍未来引入。

## 9. 实现范围

### 包含（v1）

- [ ] `AppConfig.relay` 配置项 + `FILESYNC_RELAY` 环境变量
- [ ] `SyncEngine.onRelayStore()` / `onRelayDelete()` 方法
- [ ] `main.ts` relay 模式分支（跳过 Watcher、announce 触发 state-sync）
- [ ] state-sync 防抖（最小间隔 60 秒）
- [ ] 单元测试
- [ ] E2E 测试（离线补发场景）
- [ ] 部署文档

### 不包含（未来）

- 路径加密（零知识 relay）
- 增量 state-sync
- relay 集群 / 高可用
- 按 syncId 隔离的信任策略
- Web UI 中的 relay 状态面板

## 10. 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/shared/types.ts` | `AppConfig` 新增 `relay?`, `relayRetentionDays?` |
| `src/core/config.ts` | 读取 `FILESYNC_RELAY` 环境变量 |
| `src/core/sync-engine.ts` | 新增 `onRelayStore()`, `onRelayDelete()` |
| `src/core/main.ts` | relay 模式分支：跳过 Watcher、announce→state-sync、消息处理分流 |
| `tests/unit/sync-engine.test.ts` | relay 方法的单元测试 |
| `tests/e2e/relay-offline.sh` | 离线补发 E2E 测试脚本 |
| `docs/deployment.md` | relay 部署章节 |
| `README.md` | relay 简介 |
