# FileSync

基于私有 Kubo 网络的轻量文件同步服务。

## 已完成内容

- Node.js + TypeScript 后端
- SQLite 文件索引
- AES-256-GCM 内容加密
- 文件冲突解决策略
- Fastify Web API 与简洁控制台
- Kubo HTTP API 封装与内存版测试替身
- 单元测试与构建验证

## 快速开始

推荐直接从已发布包安装：

1. 全局安装：npm install -g filesync-kubo
2. 启动服务：filesync-kubo
3. 打开：http://127.0.0.1:8384/ui

如果你是开发者，再使用源码方式：npm install、npm run build、npm start

## 打包发布

执行以下命令会先生成 npm tarball，再复制到用户目录下的共享发布路径：

npm run publish:pack

默认目标目录为：

~/svc/share/files/npm/<package>/

如需按作用域发布，可设置环境变量 NPM_SCOPE，例如：

NPM_SCOPE=@my-scope npm run publish:pack

此时目标目录会变为：

~/svc/share/files/npm/@my-scope/<package>/

## 发布到 npm 网站

如果要让其他用户直接通过 npm 安装，可按以下步骤发布：

1. 登录 npm 账号：npm login
2. 先执行发布前验证：npm run publish:npm:dry-run
3. 正式发布：npm run publish:npm
4. 用户安装：npm install -g filesync-kubo
5. 安装后直接启动：filesync-kubo

如果后续改成 scoped 包名，例如 @org/filesync-kubo，正式发布时建议使用：

npm publish --access public

## 文档

- 入口导航见 [docs/README.md](docs/README.md)
- 详细部署使用说明见 [docs/deployment.md](docs/deployment.md)
- GitHub、GHCR 与包分发说明见 [docs/release-publish.md](docs/release-publish.md)
