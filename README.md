# FileSync — filesync-kubo

> 当前版本：**v0.1.7**

基于私有 Kubo/IPFS 网络的轻量端对端文件同步服务。文件内容经 AES-256-GCM 加密后通过 IPFS 内容寻址分发，双节点通过 PubSub 自动发现、建立互信后全自动同步。

---

## 快速部署（推荐：Docker）

最快的方式是用 Docker Compose 同时启动 Kubo 和 FileSync。

**⚠️ 重要：Kubo 版本必须使用 v0.32.0。v0.32 以上版本存在 bitswap 协议问题，导致内容无法在节点间传输。**

```yaml
# docker-compose.yml（两节点部署示例）
services:
  kubo:
    image: ipfs/kubo:v0.32.0
    volumes:
      - kubo_data:/data/ipfs
      - ./kubo-init:/container-init.d:ro
    ports:
      - "4001:4001"

  filesync:
    image: ghcr.io/smellgamed3/filesync-kubo:latest
    depends_on: [kubo]
    environment:
      - IPFS_API=http://kubo:5001/api/v0
      - FILESYNC_HOME=/app/.filesync
    volumes:
      - filesync_data:/app/.filesync
      - ./sync-dir:/sync
    ports:
      - "8384:8384"
```

`kubo-init/001-config.sh` 内容：

```sh
#!/bin/sh
ipfs config --bool Pubsub.Enabled true
ipfs config Addresses.API "/ip4/0.0.0.0/tcp/5001"
# 私有网络：移除公网 bootstrap，仅与对等节点互联
ipfs bootstrap rm --all
```

详细多节点部署步骤见 → [docs/deployment.md](docs/deployment.md)

---

## 三种安装方式

### 方式一：Docker（推荐生产）

```bash
docker pull ghcr.io/smellgamed3/filesync-kubo:latest
docker run -d -p 8384:8384 \
  -e IPFS_API=http://host.docker.internal:5001/api/v0 \
  -e FILESYNC_HOME=/app/.filesync \
  -v filesync_data:/app/.filesync \
  ghcr.io/smellgamed3/filesync-kubo:latest
```

### 方式二：npm 全局安装

```bash
npm install -g filesync-kubo
filesync-kubo
```

### 方式三：GitHub Packages

```bash
npm config set @smellgamed3:registry https://npm.pkg.github.com
npm install -g @smellgamed3/filesync-kubo
filesync-kubo
```

启动后访问：**http://127.0.0.1:8384/ui**

---

## 主要特性

- **端对端加密**：AES-256-GCM，密钥仅存本地，内容对 IPFS 网络不透明
- **内容寻址**：基于 CID 的去重与版本追踪，历史版本可配置保留数量
- **自动发现**：通过 IPFS PubSub 自动发现节点，人工审批信任关系
- **状态回补**：新节点加入时自动同步已有文件
- **冲突解决**：基于时间戳和版本号的确定性冲突策略
- **离线模式**：无 Kubo 时以内存模式运行，适合开发调试

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `IPFS_API` | `http://127.0.0.1:5001/api/v0` | Kubo HTTP API 地址 |
| `FILESYNC_HOME` | `~/.filesync` | 配置与数据库目录 |
| `FILESYNC_HOST` | `127.0.0.1` | Web 服务监听地址（容器内需设为 `0.0.0.0`） |
| `FILESYNC_ANNOUNCE_INTERVAL` | `30000` | 节点广播间隔（毫秒） |

---

## 开发者

```bash
git clone https://github.com/smellgamed3/sync-node
cd sync-node
npm install
npm run build
npm test                        # 单元测试 + 集成测试（7 项）
npm run pre-release             # 本地全量 E2E（构建 + Docker E2E + npm E2E）
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [docs/deployment.md](docs/deployment.md) | 生产部署、配置参考、多节点配置 |
| [docs/release-publish.md](docs/release-publish.md) | 发布流程、CI/CD、分发渠道 |
| [docs/architecture.md](docs/architecture.md) | 系统架构设计 |
| [docs/sync-flow.md](docs/sync-flow.md) | 同步流程详解 |
| [docs/dev-debug-testing-notes.md](docs/dev-debug-testing-notes.md) | 开发调试经验总结 |
