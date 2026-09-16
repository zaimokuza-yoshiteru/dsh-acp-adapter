# 运行中输入能力与限制

[English](agent-input-capabilities.en.md)

Agent 原生支持插话，不代表当前 ACP 连接提供同样的接口。排队、当前轮次注入、取消后续发和独立旁问有不同的执行语义；适配器依据连接的能力声明选择交付方式。

## 使用方式与执行策略

DSH 中运行时按 Enter 会排队；队列中的“插话”操作请求交接当前执行。DSH 原生 loop 负责认领 inbox、执行 pre-step、解析请求配置并持久化输入，适配器只发送下一原生 step 已准入的消息，不调用私有 inbox 方法或自行构造消息事件。

默认策略是 ACP cancel → 等待旧 prompt 结束及审批收尾 → 在同一 Agent 会话发送新 prompt。Kimi、Devin 和缺少原子空闲保护的 Codex ACP 使用此策略，不增加 Agent SDK 依赖。取消会中断当前生成，已经完成的外部操作不会回滚；取消超时或交付结果不明时进入恢复状态，不自动重发。

声明 `_meta.steering = { supported: true, idleBehavior: "promptRequired" }` 的连接可使用原生注入。适配器保留原 ACP prompt，让出 DSH 输出段；下一原生 step 准入后调用 `_session/steering`。收到 `injected` 后继续承接原 prompt；只有 `promptRequired` 确认消息未消费，才允许排空旧执行后改发普通 prompt。权限或用户问题待答、模型配置变化时使用默认策略。

## 各 Agent 的接入边界

以下记录已核查的接口边界；固定源码链接用于说明决策依据，升级后仍需重新验证能力声明与完成语义。

| Agent | 原生能力 | ACP 边界与适配策略 |
| --- | --- | --- |
| Codex | CLI steering；App Server `turn/steer` 通过 `expectedTurnId` 限定活动 turn，空闲时失败。 | 已核查的 ACP 实现会在空闲竞态中创建新 turn 并返回 `startedNewTurn`，新执行不能安全共享原 prompt 的完成响应。使用取消后续发。 |
| Claude Code | CLI 输入队列、SDK streaming input；ACP `_session/steering` 可向活动执行注入输入。 | 支持上述原子空闲契约时使用注入。普通并发 `session/prompt` 的 `promptQueueing` 会创建各自的 ACP Turn/Promise，不等同于注入原 ACP Turn。SDK priority `now` 可能打断生成；待答问题使用默认策略保护生命周期。 |
| Kimi Code | TypeScript CLI 的 TUI `Ctrl-S`、Node SDK `Session.steer()` 和 Server REST/WS 队列。 | 已核查的 ACP 入口没有暴露等价 steering。使用取消后续发，无需引入 SDK。 |
| Devin | CLI 支持工作中排队、中断后发送和独立旁问。 | 已观察到并发 ACP prompt 排队，但响应共享完成元数据，且可能早于追加输出返回，无法据此确认逐消息完成归属。使用取消后续发。 |

Kimi 的 `@moonshot-ai/kimi-code-sdk` 是 TypeScript/Node Agent SDK，提供会话和执行接口，并非 Moonshot 模型 HTTP 客户端。若将来采用 SDK 或 Server transport，执行与插话必须由同一 runtime 管理，并补齐事件、权限、附件及恢复适配；另起进程使用同名 session ID 不能控制现有 ACP 执行。

## 输出与生命周期

正常交接保留已缓冲的旧回复尾部，图片在完整块边界交接。新工具属于新准入的消息，旧工具的后续内容保留原归属。一个 ACP prompt 可能产生多个 DSH assistant 段，这是保留原生准入 hooks 和消息顺序的展示代价；旧回复的失败或长度上限不会被续发成功掩盖。

显式停止、输入准入拒绝、切换 provider 或卸载会终止挂起执行。取消后迟到且尚未进入原生输出流的内容不会补造为历史；追加到已关闭原生 step 需要上游提供结束前收尾接口。

普通 prompt 保持互斥，避免一个请求结束时提前清理另一请求的审批状态。权限决策、模型循环、压缩与上下文始终由 Agent 管理。验证方法见 [E2E 指南](../test/e2e/README.md)。

## 官方依据

- Codex：[输入操作](https://developers.openai.com/codex/prompting#steering-and-queuing)、[App Server](https://developers.openai.com/codex/app-server#steer-an-active-turn)、[ACP 空闲回退实现](https://github.com/agentclientprotocol/codex-acp/blob/2b48e9822330fc09f3a94a81563e5c4bb779601a/src/CodexAcpServer.ts#L1243)。
- Claude Code：[CLI 输入队列](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)、[SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[ACP prompt 队列](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2025)、[ACP steering](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2133)。
- Kimi Code：[快捷键](https://moonshotai.github.io/kimi-code/en/reference/keyboard.html#during-streaming)、[Node SDK](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/node-sdk/src/session.ts#L193)、[Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html#prompts)、[ACP prompt](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-adapter/src/session.ts#L797)。
- Devin：[CLI 更新记录](https://docs.devin.ai/cli/changelog/stable)、[命令文档](https://docs.devin.ai/cli/reference/commands)。
