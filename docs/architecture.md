# 架构说明

[中文](architecture.md) | [English](en/architecture.md)

插件把 ACP 智能体接入 DSH 会话页面，同时保持 DSH 与智能体各自的职责边界：

```text
DSH host / Cordis
      │ typed Remote + host structure gate
      ├── host/             组合、profile、进程生命周期
      ├── protocol/v1/      ACP RPC 门卫、事件翻译、展示信封
      ├── domain/session/   binding、resume、reconciliation、options
      ├── domain/policy/    sandbox、审批、脱敏与能力矩阵
      ├── persistence/      sidecar SQLite 审计与恢复辅助状态
      └── client/data + ui  picker、模型事务、面板与工具卡
```

依赖方向从 host/protocol 经过 domain/persistence 到 typed remote/client glue；上游
`ModelPicker` 复制壳仅存在于 `client/host-compat/model-picker/`，不承载 ACP 业务逻辑。
兼容岛结构漂移时 fail closed，保护 DSH native 路由。

## 生命周期

创建时先启动和初始化 Agent，再持久化 binding，最后才允许首个 prompt。恢复时先在
staging 中 `session/load`，逐项核对 DSH 历史与 ACP 终态；无法证明同一会话就阻止续问。
模型切换使用 begin → Agent apply → DSH select → commit 的事务边界，CAS 冲突只回报
并发状态，不覆盖后来选择。

DSH session log 是用户可见历史真源。DSH rc.2 没有可忽略自定义事件写入口，因此 ACP
审批、binding、对账和降级审计写入 sidecar；sidecar 不是第二份对话历史。
