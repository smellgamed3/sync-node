# GitHub 发布与分发指南

本文档说明如何将本项目推送到 GitHub，并通过 GitHub Actions 自动完成：

- 持续集成测试
- 容器镜像发布到 GHCR
- npm 包发布到 GitHub Packages
- npm tarball 附件发布到 GitHub Release

## 1. 仓库准备

建议在 GitHub 上创建仓库后，将本地项目推送到默认分支。

建议仓库名：

- sync-node
- filesync-kubo

## 2. 已加入的自动化工作流

项目已包含两个工作流：

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

### CI 工作流

触发时机：

- push 到主分支
- pull request

执行内容：

- 安装依赖
- 构建
- 运行测试

### Release 工作流

触发时机：

- 推送版本标签，例如 `v0.1.0`
- 手动触发

执行内容：

- 构建与测试
- 生成 npm tarball
- 上传到 GitHub Release
- 构建并推送 GHCR 镜像
- 发布 npmjs 包
- 发布 GitHub Packages 包

## 3. 需要的 GitHub Secrets

如果要完整启用发布功能，建议在仓库 Secrets 中配置：

### 必需

- `NPM_TOKEN`：用于发布到 npmjs.org

### 默认可用

- `GITHUB_TOKEN`：GitHub Actions 自动提供，用于：
  - 推送 GHCR 镜像
  - 发布 GitHub Packages
  - 创建 GitHub Release

## 4. GHCR 镜像地址

镜像发布后，可按以下格式拉取：

```text
ghcr.io/<owner>/filesync-kubo:latest
```

例如：

```bash
docker pull ghcr.io/<owner>/filesync-kubo:latest
docker run -d -p 8384:8384 ghcr.io/<owner>/filesync-kubo:latest
```

## 5. 从 GitHub Packages 安装 npm 包

GitHub Packages 通常使用带 scope 的包名。工作流会自动将包名转换为：

```text
@<owner>/filesync-kubo
```

用户安装前，可先设置 registry：

```bash
npm config set @<owner>:registry https://npm.pkg.github.com
npm install -g @<owner>/filesync-kubo
```

安装后启动：

```bash
filesync-kubo
```

## 6. 推荐发布步骤

### 第一步：本地检查

```bash
npm run build
npm test
npm run publish:npm:dry-run
```

### 第二步：提交并推送到 GitHub

```bash
git add .
git commit -m "chore: prepare github release pipeline"
git push origin main
```

### 第三步：创建标签触发正式发布

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 7. 发布结果

发布完成后，一般可得到三类分发地址：

1. **GitHub 仓库源码地址**
2. **GHCR 容器镜像地址**
3. **GitHub Packages npm 包地址**

## 8. 故障排查

### GHCR 推送失败

检查：

- 仓库 Actions 权限是否允许写 Packages
- 镜像名是否符合 `ghcr.io/<owner>/<image>` 规则

### npmjs 发布失败

检查：

- `NPM_TOKEN` 是否有效
- 包版本是否已存在

### GitHub Packages 发布失败

检查：

- scope 是否与 owner 一致
- `GITHUB_TOKEN` 是否具有 packages:write 权限
