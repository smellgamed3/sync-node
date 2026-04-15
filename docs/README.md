# FileSync 文档导航

本目录将总体方案拆分为可快速查阅的子文档，方便开发、联调、测试与验收。

## 快速入口

### 使用与部署
- [部署与使用指南](./deployment.md) — 生产部署、Docker Compose、多节点配置、环境变量
- [GitHub 发布与分发](./release-publish.md) — 三阶段发布流程、GHCR/npmjs/GitHub Packages

### 系统设计
- [系统架构](./architecture.md)
- [同步流程](./sync-flow.md)
- [模块设计](./modules.md)

### 开发参考
- [开发调试经验](./dev-debug-testing-notes.md) — Kubo 版本坑、PubSub 编码、E2E 测试设计经验
- [开发测试验收](./acceptance.md)
- [原始需求](./req.md)

## 推荐阅读顺序

1. **部署**：看 `deployment.md`，特别注意 Kubo v0.32.0 要求
2. **架构**：看 `architecture.md`，理解 Kubo 与应用层边界
3. **同步流程**：看 `sync-flow.md`，确认节点启动和信任建立
4. **调试**：遇到问题先看 `dev-debug-testing-notes.md`
