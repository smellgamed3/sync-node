# 系统架构

## 分层原则

系统采用两层设计：

- **Kubo / IPFS 层**：负责内容寻址、P2P 连接、PubSub 消息、块存储与 pin 管理。
- **FileSync 应用层**：负责信任模型、文件监听、冲突解决、版本控制、Web UI 和 API。

## 节点组成

每个节点包含以下组件：

- Watcher：监听本地目录变更
- Sync Engine：处理本地变更与远端同步
- Trust Manager：维护双向信任关系
- Web API / UI：提供可视化管理界面
- Kubo Daemon：提供底层存储与传输能力

## 主题约定

- announce：节点发现与名称广播
- sync/{peerId}：定向同步通知
- trust-change：双向信任建立与状态变化

## 安全边界

- 私有网络由 swarm.key 保证接入隔离
- 业务侧默认启用 AES-256-GCM 应用层加密
- Web UI 使用基础认证
- 仅信任节点可接收同步消息
