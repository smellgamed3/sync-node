# FileSync 最终方案：基于 Kubo 私有 IPFS 网络

---

## 一、架构总览

核心思路：**用 Kubo（IPFS）做底层存储和传输层，上层用 Node.js 实现同步逻辑、信任模型和 Web UI。**

```
┌─────────────────────────────────────────────────────────────┐
│                     每个节点的组成                             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              FileSync (Node.js)                      │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────┐ ┌───────────┐  │    │
│  │  │ Watcher  │ │  Sync    │ │ Web  │ │  Trust    │  │    │
│  │  │(chokidar)│ │  Engine  │ │ UI   │ │  Manager  │  │    │
│  │  └────┬─────┘ └────┬─────┘ └──┬───┘ └─────┬─────┘  │    │
│  │       │            │          │            │         │    │
│  │       └──────┬─────┴──────────┴────────────┘         │    │
│  │              │  HTTP API (127.0.0.1:5001)            │    │
│  └──────────────┼──────────────────────────────────────┘    │
│                 ▼                                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Kubo (IPFS Daemon)                      │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │    │
│  │  │ Blockstore│ │ libp2p  │ │  PubSub  │            │    │
│  │  │ (存储)    │ │ (P2P)   │ │ (消息)    │            │    │
│  │  └──────────┘ └────┬─────┘ └──────────┘            │    │
│  │                    │ Swarm :4001 (私有网络)          │    │
│  └────────────────────┼────────────────────────────────┘    │
│                       │ swarm.key 加密隔离                   │
└───────────────────────┼─────────────────────────────────────┘
                        │
        ────────────────┼──────────────── 私有 IPFS 网络
                        │
┌───────────────────────┼─────────────────────────────────────┐
│  Node B               │                            Node C   │
│  (同样的结构)           │                                     │
└────────────────────────────────────────────────────────────┘
```

### 为什么这样分层

| 层                 | 由谁负责                       | 做什么                                         |
| ------------------ | ------------------------------ | ---------------------------------------------- |
| **Kubo**     | 存储、传输、节点互联、内容寻址 | 文件存取、跨节点 P2P 传输、PubSub 广播         |
| **FileSync** | 业务逻辑                       | 文件监听、版本管理、冲突解决、信任模型、Web UI |

这样做的好处：**不再需要自己实现 WebSocket 通信、节点发现、数据传输、NAT 穿透——全部由 Kubo/libp2p 完成。**

---

## 二、与上一版方案的对比

| 模块          | 上一版（自建）          | 本版（Kubo）                            | 变化          |
| ------------- | ----------------------- | --------------------------------------- | ------------- |
| 节点发现      | 自建 IP 列表交换        | Kubo bootstrap + libp2p                 | ✅ 完全不用写 |
| 数据传输      | 自建 WebSocket + base64 | IPFS add/get + bitswap                  | ✅ 完全不用写 |
| 消息广播      | 自建广播逻辑            | IPFS PubSub                             | ✅ 完全不用写 |
| NAT 穿透/中转 | 需要自建中转            | libp2p relay/hole-punch                 | ✅ 完全不用写 |
| 内容去重      | 自建 hash 存储          | IPFS 内容寻址天然去重                   | ✅ 完全不用写 |
| 历史版本存储  | 自建文件+数据库         | IPFS pin + 本地数据库索引               | ⬇️ 大幅简化 |
| 信任模型      | 自建                    | **仍需自建**                      | ➡️ 不变     |
| 文件监听      | chokidar                | chokidar                                | ➡️ 不变     |
| 冲突解决      | 自建                    | **仍需自建**                      | ➡️ 不变     |
| Web UI        | 自建                    | **仍需自建**                      | ➡️ 不变     |
| 应用层加密    | 无                      | **新增**（Kubo 存储明文，需加密） | ⬆️ 新增     |

**结论：自建代码量减少约 60%，核心只需实现信任 + 同步逻辑 + Web UI。**

---

## 三、信任模型（在 IPFS 层之上实现）

Kubo 私有网络保证了网络级隔离（只有持有 swarm.key 的节点能加入），但我们仍需应用级信任控制——**谁能看到我的文件、谁的文件我愿意接收**。

### 信任通信方式

利用 **IPFS PubSub** 实现应用层消息：

```
PubSub Topics:
  filesync/announce    ← 所有节点都订阅，用于发现和名称广播
  filesync/trust/{A}   ← 只有节点 A 订阅，其他节点向此 topic 发送信任变更
  filesync/sync/{A}    ← 只有节点 A 订阅，互信节点向此推送文件变更通知
```

### 信息分级（同上一版）

```
                连入私有 IPFS 网络的节点
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    新发现节点        已知/不信任        互信节点
        │               │               │
  announce 中         只看到节点         看到节点名称+
  看到节点名称        名称列表          PeerID（可直连）
                                      + 文件同步通知
```

---

## 四、完整类型定义

```typescript
// ============================================================
// src/shared/types.ts
// ============================================================

// --- 节点 ---
export interface NodeInfo {
  nodeId: string;      // IPFS PeerID（Kubo 自动生成，作为唯一标识）
  name: string;        // 人类可读名
}

export type TrustState = 'trusted' | 'untrusted';

// --- PubSub 消息 ---
export type MsgType =
  | 'announce'         // 节点在线广播（所有节点可见）
  | 'trust-change'     // 信任状态变更通知
  | 'file-changed'     // 文件变更通知（含 CID）
  | 'file-deleted'     // 文件删除通知
  | 'state-sync'       // 全量状态交换（新互信建立时）
  | 'state-sync-req';  // 请求全量状态

export interface PubSubMessage {
  type: MsgType;
  from: string;        // PeerID
  ts: number;
  payload: unknown;
}

// --- 文件版本 ---
export interface FileVersion {
  syncId: string;      // 同步目录标识
  path: string;        // 相对路径
  cid: string;         // IPFS CID（内容地址）
  size: number;
  modTime: number;     // 原始文件修改时间 (ms)
  version: number;     // 逻辑版本号
  updatedBy: string;   // PeerID
  updatedAt: number;   // 版本创建时间 (ms)
}

// --- announce 消息载荷 ---
// 不信任的节点只能看到这些
export interface AnnouncePayload {
  name: string;
  // 互信节点额外附带的信息（通过加密或定向 topic 发送）
  syncFolderIds?: string[];
}

// --- 同步目录配置 ---
export interface SyncFolder {
  id: string;
  localPath: string;     // 本机绝对路径
  syncId: string;        // 同步标识
  include?: string[];    // glob
  exclude?: string[];
  historyCount: number;  // 默认 5
  encrypt: boolean;      // 是否应用层加密，默认 true
}

// --- 配置文件 ---
export interface AppConfig {
  name: string;
  webPort: number;       // Web UI 端口，默认 8384
  webAuth: { username: string; passwordHash: string };
  encryptionKey?: string; // 应用层加密密钥（base64），首次启动自动生成
  syncFolders: SyncFolder[];
}
```

---

## 五、核心流程

### 5.1 节点启动

```
启动 FileSync
    │
    ├─ 1. 加载配置 (~/.filesync/config.json)
    │
    ├─ 2. 检查 Kubo daemon 是否运行
    │     └─ 未运行 → 自动启动 (ipfs daemon --enable-pubsub-experiment)
    │
    ├─ 3. 获取本机 PeerID (ipfs id)
    │
    ├─ 4. 初始化 SQLite 数据库
    │
    ├─ 5. 订阅 PubSub topics
    │     ├─ filesync/announce          (全局)
    │     └─ filesync/sync/{myPeerID}   (定向给自己的)
    │
    ├─ 6. 广播 announce 消息
    │
    ├─ 7. 启动文件监听 (chokidar)
    │
    ├─ 8. 启动 Web UI (Fastify)
    │
    └─ 9. 对所有在线互信节点发起 state-sync
```

### 5.2 文件变更同步

```
本地文件变更 (chokidar 检测)
    │
    ▼
防抖 500ms
    │
    ▼
[应用层加密] (如果 folder.encrypt=true)
    │  AES-256-GCM 加密文件内容
    │
    ▼
ipfs add --pin <file>  →  得到 CID
    │
    ▼
更新本地数据库 (files 表)
    │  version++, cid, modTime, updatedBy=self
    │
    ▼
旧版本 CID 移入历史表, 超出 historyCount 的 ipfs pin rm
    │
    ▼
向所有互信节点的 topic 发送 file-changed:
    {syncId, path, cid, size, modTime, version, updatedBy, updatedAt}
```

### 5.3 收到远端文件变更

```
PubSub 收到 file-changed
    │
    ▼
检查 from 是否互信 → 否则丢弃
    │
    ▼
检查 syncId 是否本地已配置 → 否则忽略
    │
    ▼
查本地同文件当前版本
    │
    ├─ 无此文件 → 直接拉取
    ├─ CID 相同 → 忽略
    └─ CID 不同 → resolveConflict()
        ├─ remote 胜 → 拉取远端
        └─ local 胜  → 忽略
    │
    ▼ (拉取)
ipfs get <CID> → 临时文件
    │
    ▼
[应用层解密] (如果加密)
    │
    ▼
写入本地同步目录 (暂停 watcher 对该文件监听)
    │
    ▼
ipfs pin add <CID>  (本地 pin，确保不被 GC)
    │
    ▼
更新数据库
```

### 5.4 信任变更

```
用户在 Web UI 设置信任 Node B
    │
    ▼
本地数据库更新 trust = 'trusted'
    │
    ▼
通过 PubSub 发送到 filesync/sync/{B_PeerID}:
    { type: 'trust-change', payload: { trusted: true } }
    │
    ▼
Node B 收到，更新 trusts_me = true
    │
    ▼
B 检查：我也信任 A 吗？
    ├─ 是 → 互信建立 → 双方各发 state-sync-req
    └─ 否 → 仅记录，等用户操作
```

---

## 六、模块实现

### 6.1 项目结构

```
filesync/
├── src/
│   ├── shared/
│   │   ├── types.ts           # 类型定义
│   │   ├── conflict.ts        # 冲突解决（纯函数）
│   │   └── constants.ts       # 常量
│   │
│   ├── core/
│   │   ├── main.ts            # 入口
│   │   ├── config.ts          # 配置加载/保存
│   │   ├── db.ts              # SQLite
│   │   ├── ipfs-client.ts     # Kubo HTTP API 封装
│   │   ├── crypto.ts          # 应用层 AES 加密/解密
│   │   ├── watcher.ts         # chokidar 文件监听
│   │   ├── sync-engine.ts     # 同步协调
│   │   ├── trust.ts           # 信任管理
│   │   ├── pubsub.ts          # PubSub 收发封装
│   │   ├── history.ts         # 历史版本管理（pin/unpin）
│   │   ├── api.ts             # Web API
│   │   └── platform.ts        # 平台服务注册
│   │
│   └── web/                   # Vue 3 前端
│       └── src/
│           ├── views/
│           │   ├── Dashboard.vue
│           │   ├── Nodes.vue
│           │   ├── Folders.vue
│           │   └── Files.vue
│           └── ...
│
├── scripts/
│   ├── setup.sh               # 一键初始化（生成/复制 swarm.key + 配置 Kubo）
│   └── setup.ps1              # Windows 版
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

### 6.2 ipfs-client.ts — Kubo API 封装

```typescript
// 所有 IPFS 操作通过 Kubo HTTP API（127.0.0.1:5001）
// 不需要 js-ipfs，零额外依赖，直接 fetch

const API = 'http://127.0.0.1:5001/api/v0';

export const ipfs = {

  // 添加文件，返回 CID
  async add(content: Buffer): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([content]));
    const res = await fetch(`${API}/add?pin=true&quieter=true`, {
      method: 'POST', body: form,
    });
    const data = await res.json();
    return data.Hash; // CID
  },

  // 获取文件内容
  async cat(cid: string): Promise<Buffer> {
    const res = await fetch(`${API}/cat?arg=${cid}`, { method: 'POST' });
    return Buffer.from(await res.arrayBuffer());
  },

  // Pin 管理
  async pin(cid: string): Promise<void> {
    await fetch(`${API}/pin/add?arg=${cid}`, { method: 'POST' });
  },

  async unpin(cid: string): Promise<void> {
    await fetch(`${API}/pin/rm?arg=${cid}`, { method: 'POST' }).catch(() => {});
  },

  // 获取本机 PeerID
  async id(): Promise<{ ID: string; Addresses: string[] }> {
    const res = await fetch(`${API}/id`, { method: 'POST' });
    return res.json();
  },

  // 查看连接的 peers
  async swarmPeers(): Promise<string[]> {
    const res = await fetch(`${API}/swarm/peers`, { method: 'POST' });
    const data = await res.json();
    return (data.Peers || []).map((p: any) => p.Peer);
  },

  // PubSub 发布
  async pubsubPublish(topic: string, data: string): Promise<void> {
    // Kubo 要求 data 为 base64url 编码（实际 multipart 或 query）
    const encoded = Buffer.from(data).toString('base64url');
    await fetch(
      `${API}/pubsub/pub?arg=${encodeURIComponent(topic)}&arg=${encoded}`,
      { method: 'POST' }
    );
  },

  // PubSub 订阅（返回 NDJSON 流）
  async pubsubSubscribe(
    topic: string,
    onMessage: (from: string, data: string) => void
  ): Promise<AbortController> {
    const controller = new AbortController();
    const res = await fetch(
      `${API}/pubsub/sub?arg=${encodeURIComponent(topic)}`,
      { method: 'POST', signal: controller.signal }
    );

    // Kubo 返回 NDJSON 流
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const from = msg.from;
            const data = Buffer.from(msg.data, 'base64').toString('utf-8');
            onMessage(from, data);
          } catch {}
        }
      }
    })();

    return controller;
  },

  // GC（清理未 pin 的块）
  async gc(): Promise<void> {
    await fetch(`${API}/repo/gc`, { method: 'POST' });
  },
};
```

### 6.3 crypto.ts — 应用层加密

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from './config';

// AES-256-GCM，每次加密使用随机 IV
// 密钥在首次启动时自动生成，存在 config.json 中

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export function getKey(): Buffer {
  return Buffer.from(config.encryptionKey!, 'base64');
}

export function encrypt(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式: [IV 12B][AuthTag 16B][Ciphertext ...]
  return Buffer.concat([iv, tag, encrypted]);
}

export function decrypt(data: Buffer): Buffer {
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

### 6.4 pubsub.ts — PubSub 消息层

```typescript
import { ipfs } from './ipfs-client';
import { db } from './db';
import type { PubSubMessage, AnnouncePayload } from '../shared/types';

const TOPIC_ANNOUNCE = 'filesync/announce';
const topicSync = (peerId: string) => `filesync/sync/${peerId}`;

class PubSubManager {
  private myPeerId: string = '';
  private controllers: AbortController[] = [];

  async start(peerId: string) {
    this.myPeerId = peerId;

    // 订阅全局 announce
    this.controllers.push(
      await ipfs.pubsubSubscribe(TOPIC_ANNOUNCE, (from, data) => {
        this.onAnnounce(from, JSON.parse(data));
      })
    );

    // 订阅定向给自己的 sync topic
    this.controllers.push(
      await ipfs.pubsubSubscribe(topicSync(peerId), (from, data) => {
        this.onDirectMessage(from, JSON.parse(data));
      })
    );

    // 定时广播 announce (每 30s)
    this.announce();
    setInterval(() => this.announce(), 30_000);
  }

  private async announce() {
    const msg: PubSubMessage = {
      type: 'announce',
      from: this.myPeerId,
      ts: Date.now(),
      payload: { name: config.name } as AnnouncePayload,
    };
    await ipfs.pubsubPublish(TOPIC_ANNOUNCE, JSON.stringify(msg));
  }

  private onAnnounce(from: string, msg: PubSubMessage) {
    if (from === this.myPeerId) return;
    const { name } = msg.payload as AnnouncePayload;
    // 记录/更新节点（仅名称，不含地址——地址由 IPFS swarm 层管理）
    db.upsertNode(from, name);
  }

  private onDirectMessage(from: string, msg: PubSubMessage) {
    switch (msg.type) {
      case 'trust-change':
        trustManager.onRemoteTrustChange(from, msg.payload);
        break;
      case 'file-changed':
      case 'file-deleted':
      case 'state-sync':
      case 'state-sync-req':
        // 只处理互信节点的消息
        if (trustManager.isMutualTrust(from)) {
          syncEngine.handleMessage(from, msg);
        }
        break;
    }
  }

  // 发送定向消息给指定节点
  async sendTo(peerId: string, msg: PubSubMessage) {
    await ipfs.pubsubPublish(topicSync(peerId), JSON.stringify(msg));
  }

  // 广播给所有互信节点
  async broadcastToTrusted(msg: PubSubMessage) {
    const trusted = db.getMutualTrustedNodes();
    for (const node of trusted) {
      await this.sendTo(node.node_id, msg);
    }
  }

  stop() {
    this.controllers.forEach(c => c.abort());
  }
}
```

### 6.5 trust.ts — 信任管理

```typescript
import { db } from './db';
import { pubsub } from './pubsub';
import { syncEngine } from './sync-engine';
import type { TrustState } from '../shared/types';

class TrustManager {

  setTrust(targetPeerId: string, state: TrustState) {
    const prev = db.getNode(targetPeerId);
    db.setTrust(targetPeerId, state);

    // 通知对方
    pubsub.sendTo(targetPeerId, {
      type: 'trust-change',
      from: pubsub.myPeerId,
      ts: Date.now(),
      payload: { trusted: state === 'trusted' },
    });

    // 如果从不信任变为互信，触发同步
    if (state === 'trusted' && prev?.trusts_me) {
      syncEngine.triggerStateSync(targetPeerId);
    }
  }

  onRemoteTrustChange(from: string, payload: { trusted: boolean }) {
    db.setTrustsMe(from, payload.trusted);

    // 检查是否形成互信
    if (payload.trusted && db.getTrust(from) === 'trusted') {
      syncEngine.triggerStateSync(from);
    }
  }

  isMutualTrust(peerId: string): boolean {
    const node = db.getNode(peerId);
    return !!node && node.trust === 'trusted' && !!node.trusts_me;
  }
}
```

### 6.6 sync-engine.ts — 同步引擎

```typescript
import { readFile, writeFile, mkdir, utimes } from 'fs/promises';
import { resolve, dirname } from 'path';
import { db } from './db';
import { config } from './config';
import { ipfs } from './ipfs-client';
import { encrypt, decrypt } from './crypto';
import { pubsub } from './pubsub';
import { resolveConflict } from '../shared/conflict';
import type { FileVersion, PubSubMessage, SyncFolder } from '../shared/types';
import minimatch from 'minimatch';

class SyncEngine {
  private writeLock = new Set<string>();

  // ─── 本地变更 → 推送 ───
  async onLocalChange(folder: SyncFolder, relativePath: string, fullPath: string) {
    let content = await readFile(fullPath);
    const stat = await fsStat(fullPath);

    // 应用层加密
    if (folder.encrypt) {
      content = encrypt(content);
    }

    // 添加到 IPFS
    const cid = await ipfs.add(content);

    // 检查是否真的变了
    const current = db.getFile(folder.syncId, relativePath);
    if (current?.cid === cid) return;

    // 保存旧版本
    if (current) {
      db.addHistory(folder.syncId, current);
      this.cleanupHistory(folder.syncId, relativePath, folder.historyCount);
    }

    // 更新数据库
    const version: FileVersion = {
      syncId: folder.syncId,
      path: relativePath,
      cid,
      size: stat.size,
      modTime: stat.mtimeMs,
      version: (current?.version ?? 0) + 1,
      updatedBy: pubsub.myPeerId,
      updatedAt: Date.now(),
    };
    db.upsertFile(folder.syncId, version);

    // 广播给互信节点
    pubsub.broadcastToTrusted({
      type: 'file-changed',
      from: pubsub.myPeerId,
      ts: Date.now(),
      payload: version,
    });
  }

  // ─── 收到远端变更 ───
  async handleMessage(from: string, msg: PubSubMessage) {
    switch (msg.type) {
      case 'file-changed':
        await this.onRemoteChange(msg.payload as FileVersion);
        break;
      case 'file-deleted':
        await this.onRemoteDelete(msg.payload as { syncId: string; path: string });
        break;
      case 'state-sync':
        await this.onStateSync(from, msg.payload as { files: FileVersion[] });
        break;
      case 'state-sync-req':
        await this.triggerStateSync(from);
        break;
    }
  }

  private async onRemoteChange(remote: FileVersion) {
    const folder = config.syncFolders.find(f => f.syncId === remote.syncId);
    if (!folder || !this.matchesFilter(remote.path, folder)) return;

    const local = db.getFile(remote.syncId, remote.path);
    if (local?.cid === remote.cid) return; // 已一致

    if (local) {
      const winner = resolveConflict(local, remote);
      if (winner === 'local') return; // 本地胜，忽略
      db.addHistory(folder.syncId, local);
    }

    // 从 IPFS 拉取（IPFS 自动从持有该 CID 的节点获取）
    let content = await ipfs.cat(remote.cid);
    await ipfs.pin(remote.cid);

    // 解密
    if (folder.encrypt) {
      content = decrypt(content);
    }

    // 写入文件
    const fullPath = resolve(folder.localPath, remote.path);
    await mkdir(dirname(fullPath), { recursive: true });

    this.writeLock.add(fullPath);
    await writeFile(fullPath, content);
    await utimes(fullPath, new Date(remote.modTime), new Date(remote.modTime));
    setTimeout(() => this.writeLock.delete(fullPath), 1000);

    db.upsertFile(remote.syncId, remote);
    this.cleanupHistory(remote.syncId, remote.path, folder.historyCount);
  }

  // ─── 全量状态同步 ───
  async triggerStateSync(targetPeerId: string) {
    const files = db.getAllFiles();
    pubsub.sendTo(targetPeerId, {
      type: 'state-sync',
      from: pubsub.myPeerId,
      ts: Date.now(),
      payload: { files },
    });
  }

  private async onStateSync(from: string, payload: { files: FileVersion[] }) {
    for (const remote of payload.files) {
      await this.onRemoteChange(remote);
    }
    // 同时推送对方没有的文件（请求对方做 state-sync）
    pubsub.sendTo(from, {
      type: 'state-sync-req',
      from: pubsub.myPeerId,
      ts: Date.now(),
      payload: null,
    });
  }

  // ─── 历史清理 ───
  private cleanupHistory(syncId: string, path: string, keepCount: number) {
    const expired = db.getExpiredHistory(syncId, path, keepCount);
    for (const entry of expired) {
      if (!db.isCidReferenced(entry.cid)) {
        ipfs.unpin(entry.cid); // 取消 pin，下次 GC 会清除
      }
      db.deleteHistory(entry.id);
    }
  }

  isWriteLocked(path: string) { return this.writeLock.has(path); }

  private matchesFilter(filePath: string, folder: SyncFolder): boolean {
    if (folder.include?.length) {
      return folder.include.some(p => minimatch(filePath, p));
    }
    if (folder.exclude?.length) {
      return !folder.exclude.some(p => minimatch(filePath, p));
    }
    return true;
  }
}
```

### 6.7 watcher.ts — 不变，同上一版

```typescript
import chokidar from 'chokidar';
import { relative } from 'path';
import { config } from './config';
import { syncEngine } from './sync-engine';

class Watcher {
  private watchers = new Map<string, chokidar.FSWatcher>();

  start() {
    for (const folder of config.syncFolders) {
      const watcher = chokidar.watch(folder.localPath, {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignored: ['**/.filesync/**', '**/node_modules/**'],
      });

      const handle = (fullPath: string) => {
        if (syncEngine.isWriteLocked(fullPath)) return;
        const rel = relative(folder.localPath, fullPath);
        syncEngine.onLocalChange(folder, rel, fullPath);
      };

      watcher.on('add', handle).on('change', handle);
      watcher.on('unlink', (fullPath) => {
        if (syncEngine.isWriteLocked(fullPath)) return;
        const rel = relative(folder.localPath, fullPath);
        syncEngine.onLocalDelete(folder, rel);
      });

      this.watchers.set(folder.id, watcher);
    }
  }
}
```

---

## 七、数据库

```sql
-- SQLite：只做索引，数据本身存在 IPFS 中

CREATE TABLE nodes (
    node_id     TEXT PRIMARY KEY,       -- IPFS PeerID
    name        TEXT NOT NULL,
    trust       TEXT DEFAULT 'untrusted',
    trusts_me   INTEGER DEFAULT 0,
    last_seen   INTEGER DEFAULT 0
);

CREATE TABLE files (
    sync_id     TEXT NOT NULL,
    path        TEXT NOT NULL,
    cid         TEXT NOT NULL,           -- IPFS CID
    size        INTEGER NOT NULL,
    mod_time    INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_by  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (sync_id, path)
);

CREATE TABLE file_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_id     TEXT NOT NULL,
    path        TEXT NOT NULL,
    cid         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mod_time    INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    updated_by  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    saved_at    INTEGER NOT NULL
);

CREATE INDEX idx_hist ON file_history(sync_id, path, saved_at DESC);
```

---

## 八、部署

### 一键初始化脚本

```bash
#!/bin/bash
# scripts/setup.sh — 在每个节点执行

set -e

echo "=== FileSync Setup ==="

# 1. 检查 Kubo
if ! command -v ipfs &> /dev/null; then
    echo "Installing Kubo..."
    wget -qO- https://dist.ipfs.tech/kubo/v0.33.0/kubo_v0.33.0_linux-amd64.tar.gz | tar xz
    sudo mv kubo/ipfs /usr/local/bin/
    rm -rf kubo
fi

# 2. 初始化 IPFS（如果没有）
if [ ! -d ~/.ipfs ]; then
    ipfs init --profile server
fi

# 3. 安全配置
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
ipfs config --bool Pubsub.Enabled true

# 4. swarm.key
if [ "$1" = "--gen-key" ]; then
    echo "Generating swarm.key..."
    go install github.com/Kubuxu/go-ipfs-swarm-key-gen/ipfs-swarm-key-gen@latest
    ipfs-swarm-key-gen > ~/.ipfs/swarm.key
    chmod 600 ~/.ipfs/swarm.key
    echo "Copy ~/.ipfs/swarm.key to all other nodes!"
elif [ -n "$SWARM_KEY_FILE" ]; then
    cp "$SWARM_KEY_FILE" ~/.ipfs/swarm.key
    chmod 600 ~/.ipfs/swarm.key
fi

# 5. 移除公网 bootstrap
ipfs bootstrap rm --all

# 6. 添加种子节点（用户提供）
if [ -n "$BOOTSTRAP_PEER" ]; then
    ipfs bootstrap add "$BOOTSTRAP_PEER"
fi

# 7. 初始化 FileSync
mkdir -p ~/.filesync
if [ ! -f ~/.filesync/config.json ]; then
    cat > ~/.filesync/config.json << EOF
{
  "name": "$(hostname)",
  "webPort": 8384,
  "webAuth": { "username": "admin", "passwordHash": "" },
  "syncFolders": []
}
EOF
fi

# 8. 安装 FileSync
cd "$(dirname "$0")/.."
npm ci --omit=dev
npm run build

echo ""
echo "=== Setup Complete ==="
echo "My PeerID: $(ipfs id -f='<id>')"
echo ""
echo "Start with: npm start"
echo "Or use Docker: docker compose up -d"
```

### Docker Compose

```yaml
# docker-compose.yml
services:
  ipfs:
    image: ipfs/kubo:v0.33.0
    restart: unless-stopped
    volumes:
      - ipfs_data:/data/ipfs
      - ./swarm.key:/data/ipfs/swarm.key:ro  # 私有网络密钥
    environment:
      - IPFS_PROFILE=server
      - LIBP2P_FORCE_PNET=1
    ports:
      - "4001:4001"               # Swarm（仅对可信网络开放）
    # API 和 Gateway 不暴露，只给 filesync 容器访问
    networks:
      - internal

  filesync:
    build: .
    restart: unless-stopped
    depends_on:
      - ipfs
    environment:
      - IPFS_API=http://ipfs:5001
      - NODE_NAME=my-server
    ports:
      - "8384:8384"               # Web UI
    volumes:
      - filesync_data:/app/.filesync
      - /path/to/sync/notes:/sync/notes
      - /path/to/sync/config:/sync/config
    networks:
      - internal

networks:
  internal:
    driver: bridge

volumes:
  ipfs_data:
  filesync_data:
```

### Windows 启动脚本

```powershell
# install.ps1
param(
    [string]$BootstrapPeer = ""
)

Write-Host "=== FileSync Windows Setup ==="

# 检查 Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Please install from https://nodejs.org/"
    exit 1
}

# 检查/安装 Kubo
if (-not (Get-Command ipfs -ErrorAction SilentlyContinue)) {
    Write-Host "Downloading Kubo..."
    Invoke-WebRequest -Uri "https://dist.ipfs.tech/kubo/v0.33.0/kubo_v0.33.0_windows-amd64.zip" -OutFile kubo.zip
    Expand-Archive kubo.zip -DestinationPath .
    Move-Item kubo\ipfs.exe "$env:LOCALAPPDATA\Programs\ipfs.exe"
    $env:PATH += ";$env:LOCALAPPDATA\Programs"
}

# 初始化 IPFS
if (-not (Test-Path "$env:USERPROFILE\.ipfs")) { ipfs init --profile server }

# 安全配置
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config --bool Pubsub.Enabled true
ipfs bootstrap rm --all
if ($BootstrapPeer) { ipfs bootstrap add $BootstrapPeer }

# 安装 FileSync
npm ci --omit=dev; npm run build

# 注册计划任务：开机启动 IPFS + FileSync
$startScript = @"
Start-Process -WindowStyle Hidden -FilePath "ipfs" -ArgumentList "daemon --enable-pubsub-experiment"
Start-Sleep 3
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "$PWD\dist\core\main.js"
"@
$startScript | Out-File "$env:APPDATA\filesync-start.ps1"

$action = New-ScheduledTaskAction -Execute "powershell" `
  -Argument "-WindowStyle Hidden -File `"$env:APPDATA\filesync-start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "FileSync" -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host "`n=== Done ==="
Write-Host "PeerID: $(ipfs id -f='<id>')"
Write-Host "Web UI: http://localhost:8384"
```

---

## 九、依赖清单（最终版）

```json
{
  "dependencies": {
    "better-sqlite3": "^11.x",
    "chokidar": "^3.x",
    "fastify": "^5.x",
    "@fastify/static": "^8.x",
    "minimatch": "^10.x",
    "pino": "^9.x"
  }
}
```

**6 个运行时依赖。** 不需要 `ws`（用 IPFS PubSub 替代），不需要 HTTP 客户端库（用内置 `fetch`）。

---

## 十、安全清单

| 层       | 措施                                            | 谁负责    |
| -------- | ----------------------------------------------- | --------- |
| 网络隔离 | swarm.key 私有网络，只有持有密钥的节点能加入    | Kubo      |
| 传输加密 | libp2p Noise/TLS + PNET 双重加密                | Kubo      |
| 存储加密 | AES-256-GCM 应用层加密后再 `ipfs add`         | FileSync  |
| API 防护 | Kubo API 仅绑定 127.0.0.1                       | Kubo 配置 |
| Web UI   | Basic Auth (用户名/密码)                        | FileSync  |
| 信任控制 | 双向手动确认，默认不信任                        | FileSync  |
| 路径安全 | 过滤 `..`，强制 relativePath 在 syncFolder 内 | FileSync  |

---

## 十一、开发路线

| 阶段         | 内容                                                      | 周期             |
| ------------ | --------------------------------------------------------- | ---------------- |
| **P0** | ipfs-client + crypto + config + db + watcher + 两节点同步 | **1 周**   |
| **P1** | PubSub 消息层 + 信任模型 + 冲突解决 + 历史版本            | **1 周**   |
| **P2** | Web UI (4 页面) + API + SSE                               | **1 周**   |
| **P3** | setup 脚本 + Docker Compose + Win 安装 + 测试             | **0.5 周** |

**总计约 3.5 周。** 相比自建全部网络栈的方案，减少了约一半工时。核心自建代码集中在：**信任管理、同步协调、冲突解决、Web UI** ——这些是真正的业务逻辑，网络和存储完全交给 Kubo。
