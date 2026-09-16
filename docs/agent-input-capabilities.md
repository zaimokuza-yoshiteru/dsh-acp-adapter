# 运行中输入能力核查（2026-09-16）

不能用某个统一 ACP 扩展是否存在，判断整个 Agent 是否支持插话。应分别记录 Agent 原生能力、当前连接可调用的方法、消息接收确认及实际生效时机。排队、当前轮次注入、停止并续发、独立旁问是不同操作。

## 本插件的交付策略

DSH 的 Enter 在执行中仍表示排队；点击队列中的“插话”操作才触发当前执行的输入交接。插件不认领或删除 inbox，也不自行构造 user/message。下一条消息先经过原生 pre-step、请求配置和持久化，再发送给 Agent。

默认策略是 ACP cancel → 等原 prompt 确认结束及旧审批清理 → 同一 Agent 会话继续 prompt。当前 Kimi、Devin 和没有原子空闲保护的 Codex ACP 使用此策略，不新增任何 Agent SDK 依赖。代价是当前生成会中断，Agent 已完成的外部动作不会回滚；若取消超时或远端结果不明，显示恢复状态，不自动重发。

声明 `_meta.steering = { supported: true, idleBehavior: "promptRequired" }` 的连接使用原生注入，当前官方 Claude ACP 满足。插件只让出 DSH 输出段，保留 ACP prompt；下一 native step 准入后调用 `_session/steering`。收到 injected 才继续承接同一 prompt；收到 promptRequired 才排空旧执行并发送普通 prompt。权限或用户问题待答时、模型配置变化时使用默认策略。交接期间被停止、准入拒绝或卸载时回收挂起执行。输出段可能分成多个 DSH assistant 消息，这是保留原生插件准入与真实顺序的展示代价。

能力判断依据初始化声明，不按 Agent 名字硬编码。Codex 本身支持原生 steer，但当前 ACP 的 startedNewTurn 竞态不能安全共享原 prompt 的完成响应；Devin 的并发队列也缺少已验证的逐消息完成归属。因此本版明确使用默认策略，避免丢输入或重复执行。后续 Agent 暴露等价的原子接口时可复用注入路径。

## Codex

实机 `codex-acp` 为 1.6.2；reference 为 1.7.0、提交 `2b48e9822330fc09f3a94a81563e5c4bb779601a`。

CLI 的 Enter 是当前 turn steering，Tab 是下一 turn 排队，官方明确区分。[官方输入说明](https://developers.openai.com/codex/prompting#steering-and-queuing)

原生 App Server 提供 `turn/steer`，需要 `expectedTurnId`，没有活动 turn 时会失败，不创建新 turn；`turn/interrupt` 是独立取消接口。[官方 App Server 文档](https://developers.openai.com/codex/app-server#steer-an-active-turn)

ACP `_session/steering` 转发到上述接口。但已装 1.6.2 和 reference 均会在活动 turn 已结束时退回新开 turn，返回 `startedNewTurn`；没有 Claude 的 `idleBehavior: promptRequired` 保证。不能只发送后等待原 `session/prompt`，否则新开的 detached turn 可能失去宿主生命周期持有者。也不能假定普通并发 `session/prompt` 等价 steering：它会建立另一份 active prompt 状态。[固定版本 ACP 实现](https://github.com/agentclientprotocol/codex-acp/blob/2b48e9822330fc09f3a94a81563e5c4bb779601a/src/CodexAcpServer.ts#L1243)、[App Server 转发](https://github.com/agentclientprotocol/codex-acp/blob/2b48e9822330fc09f3a94a81563e5c4bb779601a/src/CodexAcpClient.ts#L1122)

真实验证：GPT-5.5 测试会话在首个 prompt 尚未结束时收到 `injected`，之后输出追加指令要求的标记，全程没有发送 `session/cancel`。当前一段文本仍输出完才响应追加指令，不能承诺立即截断输出。初次默认模型测试因 bundled CLI 版本限制失败，没有计为通过；没有修改全局模型配置。

## Claude Code

官方 CLI 普通输入队列可在工具边界加入同一 turn；SDK streaming input 用长期 `AsyncIterable` 接收输入。`/btw` 则是独立旁问，不修改主任务，不能当插话。[CLI 输入队列与旁问](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)、[SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

ACP 有两套入口：

- `promptQueueing: true`：并发 `session/prompt` 创建各自的 ACP Turn/Promise，写入同一个 SDK query 输入流。不是另建 Agent，也不等于加入原 ACP Turn；实际底层可能合并排队命令，不能承诺每条必然等上一完整推理结束。
- `_session/steering`：注入当前 ACP Turn，由 Agent 自己用 SDK priority 处理。默认 `now` 可能打断模型生成；不需要宿主 `session/cancel`。使用 `_meta.steering.idleBehavior: "promptRequired"` 可以避免空闲时偷偷新开 turn；收到 `promptRequired` 后消息尚未消费，应正常提交下一 prompt。

[固定版本 prompt 队列](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2025)、[steering 实现](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2133)

版本差异：实机 ACP 0.70.0 依赖 SDK 0.3.232，注入固定 `now`；reference 同样标 0.70.0，却依赖 SDK 0.3.238，已加入等待权限/elicitation 时改用 `later` 的保护。只看 ACP 版本号会误判。接入旧构建时需暂缓等待用户回应期间的 steering，避免 Agent 抢占导致输入卡消失；这属于交付生命周期保护，不接管其权限决策。

最初只确认能力声明和 `injected` 接收，生成报旧 OAuth 过期。后续排查确认隔离测试遗漏父环境中的 `ANTHROPIC_AUTH_TOKEN`，DSH 子进程的凭据过滤导致实际配置缺少认证；并非用户的 DeepSeek 配置失效。显式传入本机 DeepSeek 路由后，两轮回复、刷新及开始生成后的原生插话均通过，`haiku` 别名实际对应 `deepseek-v4-flash`，不需要 OAuth 登录。正常插话回退会排空旧执行并保留尾部输出，再在同一会话发送新输入。[SDK interrupt 示例](https://code.claude.com/docs/en/agent-sdk/python#example-using-interrupts)

## Kimi Code

已装 CLI 0.39.1 是新的 TypeScript Kimi Code，对应官方提交 `5efca0c3116743855c28426000073bfe34a4862f`。旧 Python kimi-cli 的 Wire 文档不能直接套用；当前 CLI 帮助没有 `--wire`。

这里的 SDK 是官方 monorepo 的 TypeScript/Node Agent SDK `@moonshot-ai/kimi-code-sdk`（`packages/node-sdk`），该提交中的版本为 0.19.2，package.json 标记 `private: true`。它提供 KimiHarness、Session 等 Agent 会话接口；不是仅调用 Moonshot 模型 HTTP API 的客户端。已确认源码能力，尚未验证作为独立 npm 依赖的发布和安装路线，因此不能把“SDK 包装进程”理解为已经可以直接安装的稳定集成方案。

- 原生 TUI `Ctrl-S` 和 Node SDK `Session.steer()` 支持运行中输入；在下一可处理输入的位置生效，SDK 空闲时会新开 turn。
- 原生 Server REST/WS 有完整队列：先 `POST /api/v1/sessions/{id}/prompts`，再对 prompt ID 调用 `:steer`。`prompt.steered` 事件记录与活动 prompt 的归属，底层有 `activeTurnOnly` admission 和竞态失败恢复队列。
- 当前 ACP `session/prompt` 调用 SDK 的 `prompt`，没有暴露 steering；普通并发 prompt 不能冒充原生插话。官方 steering PR #2514 已关闭，未作为支持依据。

[官方快捷键](https://moonshotai.github.io/kimi-code/en/reference/keyboard.html#during-streaming)、[SDK steer](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/node-sdk/src/session.ts#L193)、[Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html#prompts)、[原生队列 admission](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/agent/prompt/promptService.ts#L353)、[ACP prompt](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-adapter/src/session.ts#L797)、[未合并 PR #2514](https://github.com/MoonshotAI/kimi-code/pull/2514)

若进一步接入 Kimi 不取消执行的原生注入，需要新增 SDK 包装进程或 Server transport，并由它拥有执行与插话的同一个 runtime。不能另起 `kimi web` 后拿同名 session ID 控制原 ACP 进程。代价包括额外的事件、权限、附件、恢复及实验协议版本适配。实机 ACP 扩展探针返回 Method not found；本次没有进行 Kimi SDK/Server 的真实生成测试。

## Devin

实机 `devin --version` 为 3000.10.27 (`bcbe88c7`)，ACP agentInfo 的 `0.0.0-dev` 不是实际 CLI 版本。

官方确认普通消息可在工作中排队，空输入 Enter 会中断当前 turn 并立即发送；中断会暂停子代理并保留状态。`/btw` 是与主任务并行的旁问；`/status`、`/context` 等即时命令也可以在工作中处理，并列入 ACP 命令支持。[官方更新记录](https://docs.devin.ai/cli/changelog/stable)、[官方命令文档](https://docs.devin.ai/cli/reference/commands)

实机 initialize 没有声明 steering 或 `cognition.ai/queuedMessages`。二进制中的 queue/unqueue 字符串不足以证明存在公开 RPC；对 `_session/steering`、`cognition.ai/queuedMessages`、`cognition.ai/session/queue` 的探针均返回 Method not found。标准 `session/prompt` 对不存在 session 返回明确的 session_not_found，说明分发正常。

真实验证发现了不依赖 `_session/steering` 的路径：在隔离会话首个 prompt 输出期间，发送第二个标准 `session/prompt`。两次测试都没有报并发错误；两个 RPC 却返回同一个 `cognition.ai/userMessageId`、usage 和 end_turn。第一次立即关闭连接没有收到追加结果；第二次保留响应后的接收窗口，最终收到原 80 行文本后的追加标记。模型为该会话目录中的 `gemini-3-8-flash-medium`，未更改全局配置，全程没有 `session/cancel` 或文件工具。

因此，普通并发 ACP prompt 的 Agent 排队能力已观察到，不能把 Devin 标成不支持。它不是已经验证的立即中断路径，而且 RPC 完成信息不足以证明每条追加任务已结算；接入前还需明确队列通知与消息完成归属，不能仅放开并发就上线。

无生成对照探针还向 initialize 的 clientCapabilities._meta 加入 queuedMessages/messageGrouping 字段，响应没有变化。二进制类型序列将 queuedMessages 放在 AgentCapabilitiesMeta；没有依据把它当客户端开关。二进制有 clientMessageId、instantRequestId、streamingMessageId、isOptimistic 等身份字段，但没有找到公开的消费确认契约；回显，尤其乐观回显，不能当成模型已消费的证明。

云端 REST API 另有发送会话消息的入口，但不等价本地 CLI，也不能接管当前本地 ACP 执行。[官方云端消息 API](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages)

## DSH 当前接入边界

当前 runtime 显式禁止并发 prompt；底层连接还用一个 session Set 跟踪权限生命周期。仅删除互斥会让任意一个 prompt 结束时把另一条的权限状态提前清掉。

本版让 DSH 原生 loop 认领 inbox，执行 pre-step 并持久化 `user/message`，之后才交付给 Agent。适配器通过公开 inbox 通知和 turn 生命周期协调交接，不直接 claim、删除输入或构造消息事件。正常交接保留已缓冲的旧回复尾部；工具通知在发送 steering 的边界切换归属，旧工具后续内容保留原归属，图片块完整交接。

显式 Stop、输入准入被拒绝、切到其他 provider 或卸载会终止挂起执行，沿用停止语义：取消后迟到、尚未进入原生输出流的内容不补造为 assistant 历史。若要求这类尾部也立即归入已经结束的原生 step，需要 DSH 增加结束前收尾接口。

因此统一的是对外结果：已加入当前执行、已交给 Agent 队列、未消费、交付不确定、已拒绝；各 Agent 的传输和调度方式保持独立。只有确认未消费时才能回退普通 prompt，网络超时不能自动重发。权限、模型循环、压缩和上下文继续由各 Agent 自己管理。

## 本版最终验证

候选 `0.1.6-alpha.1.4` 的 749 项常规测试、134 项完整 Web 回归和 22 项真实 Electron 产品回归通过；Web／Electron 产品矩阵使用四种协议夹具。另行使用真实 Codex GPT-5.5、Kimi Coding、Devin Gemini 3.8 Flash Medium，分别通过两轮宿主指令与刷新测试，以及首段已经生成后的插话测试：一个 DSH turn、两个 step、两条持久化输入和追加回复均被确认。Claude ACP 经用户本机 DeepSeek 路由补测，两轮回复与真实运行中插话也均通过。原 `ACP_AUTH_REQUIRED` 由隔离测试遗漏认证变量造成，已经更正，未修改用户全局配置。发布范围与证据见 [部署准备](release-readiness.md)。
