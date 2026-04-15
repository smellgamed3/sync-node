# 本地全流程开发工作流设计

**日期**：2026-04-15  
**状态**：已批准

---

## 背景与问题

当前 E2E 测试运行在 GitHub Actions 上，通过 `workflow_run` 由 Release 自动触发，存在以下问题：

- GitHub Actions 环境中 IPFS pubsub peer discovery 不稳定，导致两节点无法发现彼此（`peers: []`）
- E2E 依赖真实网络环境，GH Actions 的容器网络隔离导致 pubsub 消息路由失败
- 失败率高，每次 release 后都需要人工干预

---

## 目标流程

```
【阶段 1：本地构建 + 全量测试（推送前）】
  npm run build                    ← TypeScript 编译
  npm test                         ← 单元 + 集成测试（内存模拟 IPFS）
  docker build -t filesync-kubo:local .
  npm run test:e2e:pre:docker      ← 本地镜像双节点 E2E（容器化）
  npm run test:e2e:pre:npm         ← 本地 npm pack 安装后双进程 E2E
  npm run pre-release              ← 以上全部组合，一键执行

【阶段 2：推送 + 远端构建（CI 轻量）】
  git push / git tag
    → CI (ci.yml): build + test + docker smoke  ← 轻量，~2 分钟
    → Release (release.yml): 发布 GHCR + GitHub Packages + npmjs

【阶段 3：拉取远端产物 + 本地部署 E2E】
  npm run test:e2e:post:docker     ← 从 GHCR 拉镜像，双节点容器 E2E
  npm run test:e2e:post:npm        ← 从 GitHub Packages 安装包，双进程 E2E
  npm run post-release             ← 以上两者组合
```

**关键原则**：阶段 1 全量通过才允许推送；阶段 3 验证的是真实发布产物，独立于 CI。

---

## 变更清单

### 1. GitHub Actions 变更

**`e2e-published.yml`**：
- 移除 `workflow_run` 触发器（不再由 Release 自动触发）
- 保留 `workflow_dispatch`（需要时可手动在 GitHub 上触发）
- 作用：作为备用方案，主要测试迁移到本地

**`ci.yml`**：保持不变（build + test + docker smoke）

**`release.yml`**：保持不变（发布产物）

### 2. 新增脚本（共 4 个）

#### `scripts/e2e-pre-docker.sh` — 阶段 1：本地镜像双节点 E2E

使用本地构建的 `filesync-kubo:local` 镜像（不联网），验证当前代码的容器化行为：

```
Docker 网络拓扑：
  e2e-pre-net
    kubo-a (ipfs/kubo)  ←swarm→  kubo-b (ipfs/kubo)
    filesync-a (filesync-kubo:local)  ←pubsub→  filesync-b (filesync-kubo:local)
        IPFS_API=http://kubo-a:5001/api/v0        IPFS_API=http://kubo-b:5001/api/v0
        挂载: /tmp/e2e-pre/data-a                 挂载: /tmp/e2e-pre/data-b
```

#### `scripts/e2e-pre-npm.sh` — 阶段 1：本地 npm pack 双进程 E2E

`npm pack` 打包后安装到临时隔离目录（`/tmp/e2e-pre-npm-pkg`），不污染全局 node_modules：

```
本地进程拓扑：
  kubo-a (Docker, port 5101)  ←swarm→  kubo-b (Docker, port 5102)
  filesync-kubo (进程 A, port 18384)     filesync-kubo (进程 B, port 28384)
      IPFS_API=http://127.0.0.1:5101         IPFS_API=http://127.0.0.1:5102
      通过 /tmp/e2e-pre-npm-pkg/node_modules/.bin/filesync-kubo 启动
```

#### `scripts/e2e-post-docker.sh` — 阶段 3：远端 GHCR 镜像双节点 E2E

从 `ghcr.io/smellgamed3/filesync-kubo:latest` 拉取，网络拓扑与 pre-docker 相同，但镜像来源不同。

#### `scripts/e2e-post-npm.sh` — 阶段 3：远端 GitHub Packages npm 包双进程 E2E

从 `npm.pkg.github.com` 安装 `@smellgamed3/filesync-kubo` 到临时隔离目录（`/tmp/e2e-post-npm-pkg`），进程拓扑与 pre-npm 相同。需要环境变量 `GITHUB_TOKEN`（具备 `read:packages` 权限）。

所有 4 个脚本共享相同的**测试用例集**（6 个测试，与现有 `e2e-published.yml` 一致）：
1. A→B 文件同步
2. B→A 反向同步
3. 覆盖更新同步
4. 删除同步
5. 多文件补全（backfill）
6. API 验证

### 3. package.json 新增 scripts

```json
{
  "test:e2e:pre:docker":  "bash scripts/e2e-pre-docker.sh",
  "test:e2e:pre:npm":     "bash scripts/e2e-pre-npm.sh",
  "test:e2e:post:docker": "bash scripts/e2e-post-docker.sh",
  "test:e2e:post:npm":    "bash scripts/e2e-post-npm.sh",
  "pre-release":  "npm run build && npm test && docker build -t filesync-kubo:local . && npm run test:e2e:pre:docker && npm run test:e2e:pre:npm",
  "post-release": "npm run test:e2e:post:docker && npm run test:e2e:post:npm"
}
```

**注意**：`e2e-pre-docker.sh` 假设 `filesync-kubo:local` 已存在（由 `pre-release` 的 `docker build` 步骤构建）。单独运行 `test:e2e:pre:docker` 时需先手动执行 `docker build`。

---

## E2E 脚本设计原则

1. **幂等性**：脚本开头无条件清理同名容器/网络/目录，确保可重复运行
2. **等待策略**：条件轮询（非固定 sleep），最大重试次数有上限
3. **失败快退**：任意步骤失败立即打印容器日志并清理退出（exit 1）
4. **清理保证**：使用 trap 确保即便中途失败也能清理 Docker 资源
5. **环境前置检查**：检查 Docker 是否运行、检查 gh 认证状态（npm 脚本需要 GITHUB_TOKEN）

---

## 本地开发推荐命令序列

```bash
# 日常开发（快速反馈）
npm run build && npm test

# 阶段 1：发布前完整本地验证
npm run pre-release
# 等同于：
#   npm run build
#   npm test
#   docker build -t filesync-kubo:local .（脚本内部执行）
#   npm run test:e2e:pre:docker
#   npm run test:e2e:pre:npm

# 阶段 2：全量通过后推送
git add . && git commit -m "..."
npm version patch          # 或 minor / major
git push origin main --tags

# 等待 GitHub Release workflow 完成（约 3~5 分钟）...

# 阶段 3：验证远端发布产物
npm run post-release
# 等同于：
#   npm run test:e2e:post:docker   （从 GHCR 拉镜像）
#   npm run test:e2e:post:npm      （从 GitHub Packages 安装）
```

---

## 不在本次范围内

- 本地 E2E 不集成到 pre-push hook（避免推送耗时过长）
- 不修改 `release.yml` 的发布逻辑
- 不改变版本管理策略
