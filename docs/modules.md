# 模块设计

## 共享模块

- types：类型定义
- constants：系统常量与 topic 名称
- conflict：纯函数冲突解决策略

## 核心模块

- config：配置文件加载、生成与保存
- db：SQLite 索引层
- crypto：AES-256-GCM 加密解密
- ipfs-client：对接 Kubo HTTP API
- pubsub：消息订阅与发送
- trust：双向信任判断
- sync-engine：同步协调逻辑
- watcher：文件系统监听
- api：Fastify HTTP API 与静态页面
- main：应用入口

## 设计目标

- 业务逻辑与传输层解耦
- 允许测试中替换为内存版 IPFS
- API 与核心同步服务隔离，便于后续扩展前端
