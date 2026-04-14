# 部署与使用指南

本文档面向实际部署、日常使用和联调验收，内容与当前工作区内已经实现并验证过的项目一致。

---

## 1. 文档说明

### 适用范围

本指南适用于以下场景：

- 本地单机体验与开发调试
- 接入真实 Kubo 的私有 IPFS 网络
- Windows 与 Linux 服务器部署
- Docker 方式运行服务
- 多节点联调、测试与验收

### 当前版本能力

当前版本已经完成并验证：

- 服务启动与配置文件自动生成
- SQLite 文件索引与历史版本索引
- AES-256-GCM 内容加密解密
- 文件新增、修改、删除同步核心逻辑
- 节点发现、双向信任、状态回补、冲突处理
- Web 状态页与只读 API
- 单元测试与多节点集成测试

> 说明：当前 Web 页面以状态查看为主，目录配置和部署参数主要通过配置文件管理。

---

## 2. 运行架构

每个节点包含两部分：

1. **Kubo / IPFS Daemon**
   - 提供内容寻址、块存储、PubSub 与 P2P 连接。
2. **FileSync 服务**
   - 提供目录监听、文件加密、版本管理、同步引擎、Web 控制台。

默认情况下，服务会优先连接本地 Kubo API：

- 默认地址：`http://127.0.0.1:5001/api/v0`

如果没有可用的 Kubo 服务，程序仍可启动，但会进入**离线内存模式**，适合本地开发与界面调试，不适合真实多节点同步。

---

## 3. 环境要求

### 必需环境

- Node.js 20 及以上
- npm 10 及以上
- Windows PowerShell 或 Linux Shell

### 推荐环境

- Kubo 0.33.x 或兼容版本
- 两台或以上可互联的主机，用于真实多节点验证

### 已验证的项目命令

```bash
npm install -g filesync-kubo
filesync-kubo
npm run build
npm test
npm run test:integration
npm run publish:pack
```

---

## 4. 项目目录说明

```text
sync-node/
├── docs/                   # 文档
├── src/                    # 源码
├── tests/                  # 自动化测试
├── scripts/                # 启动与安装脚本
├── package.json            # 项目脚本
├── docker-compose.yml      # Docker 运行配置
└── Dockerfile              # 容器镜像构建文件
```

运行后还会生成本地配置目录：

- 默认配置目录：`~/.filesync`
- Windows 下一般为：`C:\Users\<用户名>\.filesync`
- 其中包含：
  - `config.json`：主配置文件
  - `filesync.db`：SQLite 索引数据库

---

## 5. 快速开始

### 5.1 按已发布地址直接安装

默认推荐方式是不拉源码，直接从已发布包安装。

#### 从 npm 网站安装

```bash
npm install -g filesync-kubo
```

安装完成后可直接启动：

```bash
filesync-kubo
```

#### 从 GitHub Packages 安装

如果发布方已将包同步到 GitHub Packages，可直接安装：

```bash
npm config set @<owner>:registry https://npm.pkg.github.com
npm install -g @<owner>/filesync-kubo
filesync-kubo
```

#### 从已发布 tarball 地址安装

如果你的发布系统提供的是 `.tgz` 文件地址，也可以直接安装：

```bash
npm install -g <已发布的tgz地址>
```

例如：

```bash
npm install -g https://your-registry.example.com/filesync-kubo-0.1.0.tgz
```

安装完成后同样可直接运行：

```bash
filesync-kubo
```

### 5.2 首次启动结果

程序首次启动后会自动生成本地配置目录与配置文件。

启动成功后访问：

- `http://127.0.0.1:8384/ui`

状态页会展示：

- 节点名称
- 运行状态
- 已发现节点
- 同步目录配置
- 已索引文件列表

### 5.3 如需源码方式运行

仅在开发调试时使用源码方式：

#### Windows PowerShell

```powershell
cd D:\code\sync-node
npm install
npm run build
npm start
```

#### Linux / macOS

```bash
cd /path/to/sync-node
npm install
npm run build
npm start
```

---

## 6. 配置文件说明

程序首次启动时会自动生成配置文件。

### 6.1 配置文件位置

默认路径：

```text
~/.filesync/config.json
```

也可以通过环境变量指定：

```bash
FILESYNC_HOME=/custom/path/.filesync
```

### 6.2 示例配置

```json
{
  "name": "node-a",
  "webPort": 8384,
  "webAuth": {
    "username": "admin",
    "passwordHash": ""
  },
  "encryptionKey": "请在首次节点配置后保持互信节点一致",
  "syncFolders": [
    {
      "id": "notes-folder",
      "localPath": "D:/sync/notes",
      "syncId": "team-notes",
      "include": ["**/*"],
      "exclude": ["**/.git/**", "**/node_modules/**"],
      "historyCount": 5,
      "encrypt": true
    }
  ]
}
```

### 6.3 字段说明

| 字段 | 说明 |
| --- | --- |
| `name` | 节点显示名称 |
| `webPort` | Web 页面与 API 端口 |
| `webAuth.username` | Basic Auth 用户名 |
| `webAuth.passwordHash` | 密码的 SHA-256 十六进制摘要；留空则不鉴权 |
| `encryptionKey` | 文件加密密钥，互信节点必须保持一致 |
| `syncFolders` | 本机要同步的目录列表 |
| `syncFolders[].localPath` | 本机绝对路径 |
| `syncFolders[].syncId` | 跨节点共享的同步标识，必须一致 |
| `include/exclude` | 文件过滤规则 |
| `historyCount` | 历史版本保留数量 |
| `encrypt` | 是否启用应用层加密 |

### 6.4 生成 Web 密码哈希

如果希望启用登录认证，可以先生成密码摘要：

```bash
node --input-type=module -e "import { createHash } from 'node:crypto'; console.log(createHash('sha256').update('你的密码').digest('hex'))"
```

将输出结果写入 `passwordHash` 字段即可。

---

## 7. 连接真实 Kubo 私有网络

如果要进行真实多节点同步，建议按以下顺序部署。

### 7.1 在每台机器安装 Kubo

确认以下命令可用：

```bash
ipfs version
```

### 7.2 初始化仓库

```bash
ipfs init --profile server
```

### 7.3 生成或复制私有网络密钥

在一台机器生成 `swarm.key`，然后复制到其他所有节点的 IPFS 数据目录。

关键要求：

- **所有节点必须使用同一个 `swarm.key`**
- 权限应仅允许当前用户读取

### 7.4 安全配置建议

```bash
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
ipfs config --bool Pubsub.Enabled true
ipfs bootstrap rm --all
```

然后按需添加私有网络中的种子节点：

```bash
ipfs bootstrap add /ip4/<seed-ip>/tcp/4001/p2p/<peer-id>
```

### 7.5 启动 Kubo

```bash
ipfs daemon --enable-pubsub-experiment
```

如果 API 端口不是默认值，需要在启动 FileSync 前设置：

```bash
IPFS_API=http://127.0.0.1:5001/api/v0
```

---

## 8. 多节点部署步骤

下面以 Node A 和 Node B 为例说明。

### 8.1 各节点统一准备

每个节点都需要：

- 安装项目依赖
- 启动自己的 Kubo daemon
- 使用同一个 `swarm.key`
- 配置相同的 `syncId`
- 配置相同的 `encryptionKey`

### 8.2 节点 A 配置示例

```json
{
  "name": "node-a",
  "webPort": 8384,
  "webAuth": { "username": "admin", "passwordHash": "" },
  "encryptionKey": "同一组互信节点必须一致",
  "syncFolders": [
    {
      "id": "folder-a",
      "localPath": "/data/shared",
      "syncId": "shared-docs",
      "historyCount": 5,
      "encrypt": true
    }
  ]
}
```

### 8.3 节点 B 配置示例

```json
{
  "name": "node-b",
  "webPort": 8384,
  "webAuth": { "username": "admin", "passwordHash": "" },
  "encryptionKey": "同一组互信节点必须一致",
  "syncFolders": [
    {
      "id": "folder-b",
      "localPath": "/data/shared",
      "syncId": "shared-docs",
      "historyCount": 5,
      "encrypt": true
    }
  ]
}
```

### 8.4 启动顺序建议

1. 先启动所有节点的 Kubo
2. 确认节点已加入同一私有网络
3. 再启动每个节点的 FileSync 服务
4. 打开各自的 Web 状态页确认服务正常

---

## 9. Docker 部署

当前项目支持两种容器使用方式：

1. 本地源码构建镜像
2. 直接拉取 GHCR 已发布镜像

### 9.1 本地构建并运行

```bash
docker compose up --build -d
```

### 9.2 从 GHCR 直接运行

```bash
docker pull ghcr.io/<owner>/filesync-kubo:latest
docker run -d -p 8384:8384 -e FILESYNC_HOME=/app/.filesync ghcr.io/<owner>/filesync-kubo:latest
```

### 9.3 访问地址

```text
http://127.0.0.1:8384/ui
```

### 9.4 注意事项

- 当前 Compose 默认把 `IPFS_API` 指向宿主机地址
- 如使用真实多节点，需确保容器可以访问宿主机或独立 IPFS 容器
- 配置目录卷建议持久化保存
- 若使用 GHCR 镜像，请将 `<owner>` 替换为实际 GitHub 用户或组织名

---

## 10. 打包与发布

### 10.1 发布目标

当前项目已提供自动打包发布脚本，执行流程为：

1. 运行 `npm pack` 生成 `.tgz` 包文件
2. 自动复制到：`~/svc/share/files/npm/<@scope>/<package>/`

### 10.2 推荐命令

```bash
npm run publish:pack
```

### 10.3 用户安装方式

发布完成后，用户侧推荐直接按已发布地址安装。

#### 方式一：从 npm 网站安装

```bash
npm install -g filesync-kubo
filesync-kubo
```

#### 方式二：从已发布 tgz 地址安装

```bash
npm install -g <已发布的tgz地址>
filesync-kubo
```

#### 方式三：临时运行

```bash
npx filesync-kubo
```

### 10.4 发布者操作

若你是发布方，可采用以下流程：

```bash
npm login
npm run publish:npm:dry-run
npm run publish:npm
```

如果后续将包名改为带 scope 的公共包，例如 `@org/filesync-kubo`，建议使用：

```bash
npm publish --access public
```

### 10.4 路径规则

- 若 `package.json` 中是 scoped 包名，例如 `@org/demo`，目标路径为：
  `~/svc/share/files/npm/@org/demo/`
- 若当前是非 scoped 包，则默认路径为：
  `~/svc/share/files/npm/filesync-kubo/`
- 若希望强制发布到某个 scope，可设置环境变量：

```bash
NPM_SCOPE=@org npm run publish:pack
```

### 10.5 Windows PowerShell

```powershell
./scripts/publish-pack.ps1
```

也可以指定 scope：

```powershell
./scripts/publish-pack.ps1 -Scope @org
```

### 10.6 Linux Shell

```bash
./scripts/publish-pack.sh
```

### 10.7 自定义发布根目录

默认发布根目录为：

```text
~/svc/share/files/npm
```

如需改为其他目录，可以设置环境变量：

```bash
NPM_SHARE_ROOT=/data/npm-share npm run publish:pack
```

## 11. 日常使用说明

### 10.1 查看运行状态

打开浏览器访问：

- `/ui`：简洁控制台页面
- `/api/status`：服务状态
- `/api/nodes`：已发现节点列表
- `/api/folders`：同步目录配置
- `/api/files`：当前文件索引
- `/api/config`：当前服务配置摘要

### 10.2 添加同步目录

当前版本推荐直接编辑配置文件中的 `syncFolders` 数组，然后重启服务。

配置时请注意：

- `localPath` 必须是本机存在的绝对路径
- 不同节点使用相同 `syncId` 才会被视为同一份同步数据
- 若启用了 `encrypt`，则相关节点的 `encryptionKey` 必须一致

### 10.3 触发同步

目录被加入配置并启动服务后：

- 新增文件会自动入库并同步
- 修改文件会更新版本并通知互信节点
- 删除文件会向互信节点广播删除事件

### 10.4 过滤规则

可以通过 `include` 和 `exclude` 控制同步范围：

```json
{
  "include": ["docs/**", "notes/**"],
  "exclude": ["**/.git/**", "**/*.tmp"]
}
```

---

## 11. 安全建议

### 11.1 网络层

- 使用私有 `swarm.key` 隔离网络
- 不要向公网暴露 Kubo API
- 尽量仅绑定回环地址 `127.0.0.1`

### 11.2 应用层

- 生产环境必须配置 `webAuth.passwordHash`
- 互信节点之间要安全保存同一份 `encryptionKey`
- 避免将配置目录提交到代码仓库

### 11.3 数据层

- 定期备份 `config.json` 与 `filesync.db`
- 必要时执行 IPFS GC 清理未引用块
- 历史版本数量不宜设置过大

---

## 12. 验证与验收

### 12.1 本地验收命令

```bash
npm run build
npm test
npm run test:integration
```

### 12.2 已覆盖的验证项

- 配置文件生成与读取
- 加密与解密正确性
- 冲突解决策略
- 文件新增、修改、删除流程
- 节点发现与信任门禁
- 状态回补
- Web API 鉴权与查询
- 多节点集成同步

---

## 13. 常见问题排查

### 问题 1：页面能打开，但显示 `kuboAvailable: false`

原因：FileSync 未连上 Kubo API。

排查步骤：

1. 检查 `ipfs daemon` 是否已启动
2. 检查 API 是否监听在 `127.0.0.1:5001`
3. 检查环境变量 `IPFS_API` 是否配置正确

### 问题 2：多节点之间看不到文件同步

优先检查：

- 是否使用同一个 `swarm.key`
- 是否处于同一私有网络
- 是否配置了相同的 `syncId`
- 是否使用相同的 `encryptionKey`
- 是否已建立互信关系
- 文件路径是否被 `include/exclude` 规则过滤掉

### 问题 3：文件内容无法正确解密

通常原因是：

- 各节点 `encryptionKey` 不一致
- 文件被非预期节点修改后重新加密

### 问题 4：服务启动后没有任何同步目录

原因通常是 `syncFolders` 为空，或 `localPath` 指向的目录不存在。

---

## 14. 运维建议

- 使用系统服务或计划任务实现开机自启
- 将 Kubo 与 FileSync 进程日志分开保存
- 对业务同步目录和配置目录分别做备份
- 建议先在测试环境完成双节点验收，再推广到更多节点

---

## 15. 推荐阅读

- [系统架构](./architecture.md)
- [同步流程](./sync-flow.md)
- [模块设计](./modules.md)
- [开发测试验收](./acceptance.md)
- [GitHub 发布与分发](./release-publish.md)
