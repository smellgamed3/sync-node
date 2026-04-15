# GitHub 发布与分发指南

> 当前版本：**v0.1.7**

本文档说明三阶段发布工作流、GitHub Actions 自动化配置，以及各分发渠道的使用方式。

---

## 1. 三阶段发布工作流

所有发布均遵循以下流程，确保推送到 GitHub 前本地已充分验证：

```
阶段一：本地全量测试
  npm run pre-release
    ├── npm run build
    ├── npm test              # 7 项单元/集成测试
    ├── npm run e2e:docker    # Docker E2E（使用本地构建镜像）
    └── npm run e2e:npm       # npm E2E（使用 npm pack tarball）

阶段二：推送触发远程构建
  git push && git push --tags
    └── GitHub Actions:
          ├── ci.yml          # 构建 + 单元测试
          └── release.yml     # 构建 + 发布到 GHCR / npmjs / GitHub Packages

阶段三：本地验证发布结果
  npm run post-release
    ├── npm run e2e:post-docker   # 从 GHCR 拉取并 E2E 验证
    └── npm run e2e:post-npm      # 从 npmjs 安装并 E2E 验证
```

### 快速发布命令

```bash
# 阶段一：本地全量 E2E
npm run pre-release

# 更新版本号并提交
npm version patch   # 或 minor / major
git push && git push --tags

# 阶段三：验证远端构建结果（发布完成约 5 分钟后执行）
npm run post-release
```

---

## 2. GitHub Actions 工作流

### CI 工作流（`ci.yml`）

**触发时机**：push 到主分支、Pull Request

**执行内容**：
- Node.js 环境安装依赖
- `npm run build`
- `npm test`

### Release 工作流（`release.yml`）

**触发时机**：推送版本标签（`v*.*.*`）

**执行内容**：
1. 构建与单元测试
2. 生成 npm tarball 附件，上传到 GitHub Release
3. 构建并推送 GHCR 容器镜像（`:latest` + 版本标签）
4. 发布到 npmjs（`filesync-kubo`）
5. 发布到 GitHub Packages（`@smellgamed3/filesync-kubo`）

### E2E 远端工作流（`e2e-published.yml`）

**触发时机**：手动触发（`workflow_dispatch`）

**执行内容**：基础 E2E 冒烟测试，验证已发布镜像可用性。使用 `ipfs/kubo:v0.32.0`。

---

## 3. 已发布版本（v0.1.7）

| 渠道 | 地址 | 版本 |
|------|------|------|
| Docker（GHCR） | `ghcr.io/smellgamed3/filesync-kubo` | `latest`, `v0.1.7` |
| npmjs | `filesync-kubo` | `0.1.7` |
| GitHub Packages | `@smellgamed3/filesync-kubo` | `0.1.7` |
| GitHub Release | [Releases 页面](https://github.com/smellgamed3/sync-node/releases) | v0.1.7 |

---

## 4. 各渠道安装方式

### Docker（推荐生产）

```bash
docker pull ghcr.io/smellgamed3/filesync-kubo:latest
docker run -d -p 8384:8384 \
  -e IPFS_API=http://host.docker.internal:5001/api/v0 \
  -e FILESYNC_HOME=/app/.filesync \
  -v filesync_data:/app/.filesync \
  ghcr.io/smellgamed3/filesync-kubo:latest
```

### npmjs

```bash
npm install -g filesync-kubo
filesync-kubo
```

### GitHub Packages

```bash
npm config set @smellgamed3:registry https://npm.pkg.github.com
npm install -g @smellgamed3/filesync-kubo
filesync-kubo
```

---

## 5. 必需的 GitHub Secrets

| Secret | 用途 | 来源 |
|--------|------|------|
| `NPM_TOKEN` | 发布到 npmjs.org | npmjs 账号 → Access Tokens |
| `GITHUB_TOKEN` | GHCR + GitHub Packages + Release | Actions 自动提供 |

配置 `NPM_TOKEN`：
- 登录 npmjs.org → Account → Access Tokens → Generate New Token（Automation 类型）
- 仓库 Settings → Secrets and variables → Actions → New repository secret

---

## 6. 版本号约定

```bash
# 补丁版本（bugfix）
npm version patch   # 0.1.6 → 0.1.7

# 次版本（新功能）
npm version minor   # 0.1.7 → 0.2.0

# 主版本（破坏性变更）
npm version major   # 0.1.7 → 1.0.0
```

`npm version` 命令会自动修改 `package.json`、提交、并打 git 标签。

---

## 7. 故障排查

### GHCR 推送失败

- 检查仓库 Actions 权限：Settings → Actions → General → Workflow permissions → 勾选 "Read and write permissions"
- 检查 "Allow GitHub Actions to create and approve pull requests"

### npmjs 发布失败

- 确认 `NPM_TOKEN` 有效且未过期
- 检查包名 `filesync-kubo` 是否已被他人占用
- 确认版本号未重复（同一版本不能重复发布）

### GitHub Packages 发布失败

- 确认 scope `@smellgamed3` 与 GitHub 用户名一致
- 检查 `GITHUB_TOKEN` 的 `packages:write` 权限

### E2E 后置测试失败（post-release）

- 镜像或 npm 包可能尚未完全发布，等待 2-5 分钟后重试
- 检查 GHCR Packages 页面确认镜像已可见
- 检查 npmjs.com 确认版本已发布

---

## 8. 推荐阅读

- [部署与使用指南](./deployment.md)
- [开发调试经验](./dev-debug-testing-notes.md)
