# DSH 0.2.2-rc.4 兼容评估

2026-11-18。已发布的适配器 `0.2.2-rc.3.1` 精确要求 DSH RC.3。当前源码以 `0.2.2-rc.4.1` 作为候选版本，宿主、DSH peer 和开发依赖同步锁定 RC.4。用户安装说明继续指向已发布的版本。

RC.3 到 RC.4 有 8 个提交。三个生产源文件的变化集中在 DeepSeek 拒答和桌面 LiveShare 子进程。会话准入、工具执行、模型选择、压缩和 ACP 协议接口沿用 RC.3 的契约。[上游发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.4) · [完整差异](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.3...dsh-v0.2.2-rc.4)

- **模型拒答**。DSH 原生 DeepSeek 流在内容审核拒答时先上报用量，再以 `CONTENT_REFUSED` 结束。外部 ACP Agent 返回 `stopReason: refusal` 时，原因由 Agent 决定。插件沿用 `ACP_REFUSAL`，并按 ACP 协议向用户说明，后续请求会跳过被拒的这一轮。DSH 仍保存本地会话记录。[上游迁移指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.4/docs/upgrade-guide/v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md)
- **桌面子进程**。RC.4 使 LiveShare 的 tunnel worker 继承 Electron 的 Node 模式。插件自身在桌面通过 `process.execPath` 启动 stdio MCP 桥时已设置 `ELECTRON_RUN_AS_NODE=1`。回归测试直接验证插件下发给 Agent 的启动配置。
- **现有会话切模**。RC.4 的宿主压缩仍需要目标模型容量。专用 ACP 预设会先向原 Agent 会话确认所选模型，再提交新请求；按具体模型创建的其他会话沿用来源模式另开。标准、创造、PTC、极简中的 CodeBuddy 和 OpenCode 新主会话另可从第一轮选择「由 Agent 管理模型」，之后在原会话切换。其他问题的优先级和验收条件见[开放 issue 评估](dsh-0.2.2-rc.4-issues.md)。

本地使用 Node 24.19.0、插件 pnpm 10.7.0 和宿主 pnpm 11.28.5。官方标签 `3f321d3` 的八项构建检查通过，构建出的 CLI 报告 RC.4。插件通过冻结安装、传递依赖校验、类型检查及打包检查。候选 tarball 装入独立的 RC.4 Web profile 后，原有插件组合仍在，客户端返回 HTTP 200，移除候选插件后配置清理通过。该安装检查使用公开 npm 宿主和独立配置。
