# 部署与使用指南

> 当前版本：**v0.1.7**  
> 本文档面向生产部署和日常使用，所有命令均已在真实 Kubo 环境下验证。

---

## 1. 概述

每个 FileSync 节点由两个进程组成：

| 进程 | 职责 |
|------|------|
| **Kubo daemon** | 内容寻址存储、PubSub 消息总线、P2P swarm 连接 |
| **FileSync 服务** | 目录监听、加密、版本管理、同步引擎、Web 控制台 |

FileSync 通过 `IPFS_API` 环境变量与 Kubo 通信，两者可以是同机进程，也可以是同 Docker 网络中的两个容器。

### 离线模式

若 Kubo 不可用，FileSync 自动降级为内存模式启动——Web 控制台可用，但文件不会真正同步。适合 UI 开发和配置调试。

---

## 2. Kubo 版本要求

> **⚠️ 必须使用 Kubo v0.32.0**

经测试，Kubo v0.40.1 存在 bitswap 协议协商缺陷：`swarm/peers` 显示连接正常，但实际无法交换数据块，所有 `ipfs cat` 超时。v0.32.0 正常工作。

---

## 3. 环境要求

### 生产部署（Docker 方式）

- Docker 24+
- Docker Compose v2

### npm 方式

- Node.js 20+
- npm 10+
- Kubo v0.32.0（独立安装）

---

## 4. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `IPFS_API` | `http://127.0.0.1:5001/api/v0` | Kubo HTTP API 地址 |
| `FILESYNC_HOME` | `~/.filesync` | 配置文件与数据库目录 |
| `FILESYNC_HOST` | `127.0.0.1` | Web 服务监听地址（容器内设为 `0.0.0.0`） |
| `FILESYNC_ANNOUNCE_INTERVAL` | `30000` | 节点广播周期（毫秒），影响新节点发现速度 |

---

## 5. Docker 部署（推荐）

### 5.1 单节点快速启动

直接使用 GHCR 预构建镜像，搭配本机已运行的 Kubo：

```bash
docker run -d --name filesync \
  -p 8384:8384 \
  -e IPFS_API=http://host.docker.internal:5001/api/v0 \
  -e FILESYNC_HOME=/app/.filesync \
  -v filesync_data:/app/.filesync \
  -v /path/to/sync:/sync \
  ghcr.io/smellgamed3/filesync-kubo:latest
```

访问：http://127.0.0.1:8384/ui

### 5.2 Kubo + FileSync 同 Compose 部署（推荐生产）

创建如下目录结构：

```
mynode/
├── docker-compose.yml
├── kubo-init/
│   └── 001-config.sh
└── sync-data/          ← 实际同步目录
```

**`kubo-init/001-config.sh`**（Kubo 启动前自动执行）：

```sh
#!/bin/sh
ipfs config --bool Pubsub.Enabled true
ipfs config Addresses.API "/ip4/0.0.0.0/tcp/5001"
# 私有网络：清空公网 bootstrap
ipfs bootstrap rm --all
# 添加对等节点（生产环境替换为真实对端地址）
# ipfs bootstrap add /ip4/<peer-ip>/tcp/4001/p2p/<peer-id>
```

```bash
chmod +x kubo-init/001-config.sh
```

**`docker-compose.yml`**：

```yaml
services:
  kubo:
    image: ipfs/kubo:v0.32.0
    restart: unless-stopped
    volumes:
      - kubo_data:/data/ipfs
      - ./kubo-init:/container-init.d:ro
    ports:
      - "4001:4001"          # swarm（多节点互联需对外开放）
    healthcheck:
      test: ["CMD", "ipfs", "id"]
      interval: 10s
      timeout: 5s
      retries: 6

  filesync:
    image: ghcr.io/smellgamed3/filesync-kubo:latest
    restart: unless-stopped
    depends_on:
      kubo:
        condition: service_healthy
    environment:
      - IPFS_API=http://kubo:5001/api/v0
      - FILESYNC_HOME=/app/.filesync
    volumes:
      - filesync_data:/app/.filesync
      - ./sync-data:/sync          # 映射同步目录
    ports:
      - "8384:8384"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8384/api/status"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  kubo_data:
  filesync_data:
```

启动：

```bash
docker compose up -d
docker compose logs -f filesync    # 查看日志
```

### 5.3 多节点部署

每台机器独立运行一套 Kubo + FileSync。关键要求：

1. 所有节点的 **`syncId`** 相同（标识同一份数据）
2. 所有节点的 **`encryptionKey`** 相同（内容加密密钥）
3. Kubo 节点之间能互通 **TCP 4001 端口**
4. `kubo-init/001-config.sh` 中通过 `ipfs bootstrap add` 互相添加对端

节点 A 和 B 的配置文件示例：

**节点 A（`~/.filesync/config.json`）**：
```json
{
  "name": "node-a",
  "webPort": 8384,
  "webAuth": { "username": "admin", "passwordHash": "" },
  "encryptionKey": "共享密钥，所有节点必须完全一致",
  "syncFolders": [
    {
      "id": "docs",
      "syncId": "team-docs",
      "localPath": "/sync",
      "historyCount": 5,
      "encrypt": true
    }
  ]
}
```

**节点 B** 配置相同，仅 `name` 可不同，`syncId` 和 `encryptionKey` 必须一致。

---

## 6. npm 部署

### 6.1 安装

```bash
# 从 npmjs（公共包）
npm install -g filesync-kubo

# 从 GitHub Packages（带 scope）
npm config set @smellgamed3:registry https://npm.pkg.github.com
npm install -g @smellgamed3/filesync-kubo
```

### 6.2 启动

```bash
# 前台运行
filesync-kubo

# 指定配置目录
FILESYNC_HOME=/data/filesync filesync-kubo

# 容器外连接本机 Kubo（非默认端口时）
IPFS_API=http://127.0.0.1:5001/api/v0 filesync-kubo
```

### 6.2.1 后台常驻（systemd，推荐 Linux 生产）

创建 service 文件：

```bash
sudo tee /etc/systemd/system/filesync.service > /dev/null << 'EOF'
[Unit]
Description=FileSync Kubo Node
After=network.target

[Service]
Type=simple
User=YOUR_USER
Environment=FILESYNC_HOME=/home/YOUR_USER/.filesync
ExecStart=/usr/local/bin/filesync-kubo
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 加载并启动
sudo systemctl daemon-reload
sudo systemctl enable filesync
sudo systemctl start filesync

# 查看状态和日志
systemctl status filesync
journalctl -u filesync -f
```

> **提示**：同理，将 `ipfs daemon` 也配置为 systemd 服务，并在 `After=` 中加上 `ipfs.service` 以保证启动顺序。

### 6.2.2 后台常驻（PM2，跨平台，macOS/Linux/Windows 均支持）

```bash
# 安装 PM2
npm install -g pm2

# 启动
FILESYNC_HOME=~/.filesync pm2 start filesync-kubo --name filesync

# 开机自启
pm2 startup        # 按提示执行输出的命令
pm2 save

# 常用操作
pm2 status         # 查看进程状态
pm2 logs filesync  # 实时日志
pm2 restart filesync
pm2 stop filesync
```

### 6.2.3 后台常驻（nohup，临时测试用）

```bash
nohup FILESYNC_HOME=~/.filesync filesync-kubo >> ~/.filesync/filesync.log 2>&1 &
echo $! > ~/.filesync/filesync.pid   # 保存 PID 便于停止

# 停止
kill $(cat ~/.filesync/filesync.pid)
```

### 6.3 配置 Kubo（非 Docker 场景）

```bash
ipfs init --profile server
ipfs config --bool Pubsub.Enabled true
ipfs config Addresses.API "/ip4/127.0.0.1/tcp/5001"
ipfs bootstrap rm --all
# 添加对端节点
# ipfs bootstrap add /ip4/<peer-ip>/tcp/4001/p2p/<peer-id>
ipfs daemon
```

---

## 7. 配置文件说明

**路径**：`$FILESYNC_HOME/config.json`（默认 `~/.filesync/config.json`）

首次启动自动生成。

```json
{
  "name": "node-a",
  "webPort": 8384,
  "webAuth": {
    "username": "admin",
    "passwordHash": ""
  },
  "encryptionKey": "32字节以上随机字符串，互信节点必须一致",
  "syncFolders": [
    {
      "id": "my-docs",
      "syncId": "team-docs",
      "localPath": "/sync",
      "historyCount": 5,
      "encrypt": true,
      "include": [],
      "exclude": ["**/.git/**", "**/node_modules/**"]
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `name` | 节点显示名（在对端 Web 控制台可见） |
| `webPort` | Web 服务端口，默认 8384 |
| `webAuth.username` | Basic Auth 用户名，留空不鉴权 |
| `webAuth.passwordHash` | 密码的 SHA-256 十六进制，见下方生成命令 |
| `encryptionKey` | 内容加密密钥，**所有互信节点必须一致** |
| `syncFolders[].syncId` | 跨节点同步标识，**所有互信节点必须一致** |
| `syncFolders[].localPath` | 本机同步目录绝对路径 |
| `syncFolders[].historyCount` | 保留历史版本数量 |
| `syncFolders[].encrypt` | 是否启用应用层加密 |
| `include` / `exclude` | glob 过滤规则，优先 include |

### 生成密码哈希

```bash
node --input-type=module -e \
  "import{createHash}from'node:crypto';console.log(createHash('sha256').update('你的密码').digest('hex'))"
```

---

## 8. Web 控制台与 API

启动后访问 **http://127.0.0.1:8384/ui**

| 端点 | 说明 |
|------|------|
| `GET /api/status` | 服务状态（peerId、kuboAvailable） |
| `GET /api/nodes` | 已发现节点及信任状态 |
| `GET /api/folders` | 同步目录配置 |
| `GET /api/files` | 当前文件索引（CID、版本、大小） |
| `GET /api/config` | 配置摘要（不含密钥） |
| `POST /api/nodes/:id/trust` | 设置节点信任关系 |

---

## 9. 信任关系管理

新节点发现后**默认不信任**，需手动确认（或在测试环境开启 `FILESYNC_DEV_AUTO_TRUST=true`）。

通过 API 手动信任：

```bash
curl -X POST http://127.0.0.1:8384/api/nodes/<peer-id>/trust \
  -H "Content-Type: application/json" \
  -d '{"trust": "trusted"}'
```

互信完成（双方都信任对方）后自动触发状态回补，同步对端已有文件。

---

## 10. 生产运维建议

### 持久化

- `kubo_data` volume：Kubo IPFS 仓库（包含 swarm 密钥和块存储）
- `filesync_data` volume：配置文件和 SQLite 索引数据库
- 同步目录建议 bind mount 到宿主机可访问路径

### 日志

```bash
docker compose logs filesync    # 实时日志
docker compose logs kubo        # Kubo 日志
```

### 备份

定期备份：
- `~/.filesync/config.json`（含密钥）
- `~/.filesync/filesync.db`（文件索引）

### IPFS GC

定期清理未引用的 IPFS 数据块：

```bash
curl -X POST http://127.0.0.1:5001/api/v0/repo/gc
```

---

## 11. 常见问题

### kuboAvailable: false

Kubo API 不可达。检查：
1. `ipfs daemon` 或 kubo 容器是否已启动
2. `IPFS_API` 地址和端口是否正确
3. 容器部署时确认 `IPFS_API=http://kubo:5001/api/v0`（用容器服务名而非 localhost）

### 节点发现了但不同步文件

按序检查：
1. 双方是否已建立**互信**（`/api/nodes` 中 `trust=trusted` 且 `trusts_me=1`）
2. `syncId` 是否一致
3. `encryptionKey` 是否一致
4. Kubo 节点间 swarm 是否已连通（各自 `ipfs swarm peers` 能看到对端）

### ipfs cat 超时

Kubo 版本问题，确认使用 v0.32.0。验证：
```bash
docker exec <kubo容器> ipfs version
curl -X POST http://127.0.0.1:5001/api/v0/bitswap/stat
# Peers 字段应在 swarm 连通后非空
```

### 文件解密失败

各节点 `encryptionKey` 不一致。需保证所有节点配置完全相同的密钥字符串。

---

## 12. 推荐阅读

- [系统架构](./architecture.md)
- [同步流程](./sync-flow.md)
- [GitHub 发布与分发](./release-publish.md)
- [开发调试经验](./dev-debug-testing-notes.md)

