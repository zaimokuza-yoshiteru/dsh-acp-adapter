# DSH 0.2.2-alpha.2 兼容与复用评估

本次评估以适配器 `0.2.1-rc.4.1`（`28ccc6745ec82139c684c3642637e93e00d800f2`）为基线，对照 DSH `dsh-v0.2.1-rc.4` → `dsh-v0.2.2-alpha.2`。目标源码为 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，评估日期为 2026-10-28。适配器分支为 `0.2.2-alpha`；前四节保留迁移前的调查证据；实施情况见末节。候选版本尚未发布。

结论：需要实质兼容工作，不能只调整依赖版本。优先迁移工具执行与按步准入、异步投影、模型读取及普通 fork；同时可以删除部分回复展示补丁和无消费者的权限投影读取。官方 ACP 主类没有覆盖本插件的持续外部会话能力，值得复用的是公共工具执行器、投影句柄和原生 UI。

## 证据与验证范围

- `reference/deepseek-harness` 已更新到目标标签；已有 `.claude/skills` 删除保持原状。
- 在 gitignored `.local/assessment-0.2.2-alpha.2/probe/` 从适配器基线建立隔离副本，生产源码不变，DSH 依赖精确替换为 npm `0.2.2-alpha.2`；Cordis、group、loader、Schemastery 分别对齐 `4.0.6-alpha.1`、`1.0.6-alpha.1`、`1.0.7-alpha.1`、`3.18.6-alpha.1`，其他直接依赖保留基线。
- Node `24.19.0` / pnpm `10.7.0` 下，`pnpm install --ignore-scripts --registry=https://registry.npmjs.org` 成功，99 项精确开发依赖检查及 Typert 生成通过。
- `pnpm typecheck` 在生产源码阶段失败：**36 个诊断、9 个文件**。分别是 `backend-guard` 2、`fork-tools` 5、`installed-profile-registry` 1、`session-facts` 6、`tool-approval-policy` 3、Teams 的 `management` 2 / `member-model-facts` 1 / `member-models` 2、`tools/bridge` 14。
- 单独运行 `tsc --noEmit -p tsconfig.test.json` 得到 98 个诊断，包含上述 36 个生产诊断和 11 个测试文件中的 62 个诊断；不是另外 98 个生产问题。`tsc -p tsconfig.tools.json` 通过。
- 原始日志、隔离 manifest/lockfile 和结构化诊断保存在同一 `.local/assessment-0.2.2-alpha.2/`。评估阶段未运行 alpha.2 Host、浏览器、独立桌面或真实 Agent；迁移后的实际验收见末节。

已参考官方 [代码审查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/.agents/skills/dsh-code-review/SKILL.md)、[简化评估](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/.agents/skills/dsh-find-simplifications/SKILL.md)、[升级指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/.agents/skills/dsh-create-upgrade-guide/SKILL.md)、[会话投影](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/.agents/skills/dsh-session-projection/SKILL.md)与相关 Cordis 生命周期要求。采用其生产者/消费者追踪和生命周期验证方法；上游仓库自己的全量构建、文档组织和 PR 规则不直接搬到适配器仓库。

## 1. 核心兼容工作

| 领域             | 已确认影响                                                                                                                                                                                                                                                                                                                                                          | 迁移与验收要求                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具执行         | [bridge.ts](../../src/host/tools/bridge.ts) 仍调用单次 `tools.execute({ callId, name, arguments, ... })` 并读单次结果。新版接受 `ToolBatchInput`，返回 `results`、`additionalContexts`、`concluded`；`tools.executionMode` 也已移除。                                                                                                                               | 通过所选 native/PTC executor 执行批次，正确提取单次结果并保留上下文反馈、结束语义、取消与已接受调用的收尾。更新测试组合中的旧 `tools.mode` 与 `DSH_TOOLS_MODE`。见官方[执行器迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/docs/upgrade-guide/v0.2.1-rc.2/tool-executor-plugins/guide.zh.md)。                                                                               |
| 条件工具         | 注册表中存在且 schema 相同，不再足以证明当前步骤可执行。没有本步 `ResolvedToolSet` 的调用不能执行条件工具；集合释放或定义替换后，未开始的调用应拒绝。                                                                                                                                                                                                               | 复用 Host 已解析的同一个集合，不重新求值条件，不扩大发给 Agent 的工具集合。验证条件 false/失败、作用域收窄、替换、重试和迟到 MCP 请求。见官方[条件工具迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/docs/upgrade-guide/v0.2.1-rc.2/conditional-tools/guide.zh.md)。                                                                                                          |
| 会话投影         | `register()` 改为异步取得 `ProjectionHandle<S>`，`SessionProjectionStateMap` 移除，注册表级 `stateOf(session,key)` 返回 `unknown` 且弃用。影响本插件的执行事实、fork 事实及服务初始化。                                                                                                                                                                             | 自有投影在异步初始化中等待注册，再发布同步 reader；卸载等待 `handle.dispose()`。官方仍有 callable-thenable 兼容层，不能把类型错误描述为所有路径立即运行崩溃，也不应以兼容层代替迁移。验证注册失败、加载中事件、await 中卸载与 checkpoint 恢复。见[投影迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/docs/upgrade-guide/v0.2.1-rc.2/session-projection-handles/guide.zh.md)。 |
| 模型选择与 Teams | 旧模型投影读取、`ModelSelectionRef` 和选择调用签名不再匹配。步骤在 pre-step 前固定模型，`agent/request` 不再允许改变路由。                                                                                                                                                                                                                                          | 待生效选择用 `agent.model.current()/select()`；已请求模型按请求头或对应官方视图读取。我们现有 `agent/request` listener 只观察/拒绝并原样返回，并未改路由，不能把它单独认定为确定故障。验证成员模型、冷恢复、ACP/native 切换、同一步重试。                                                                                                                                                                    |
| 普通会话 fork    | 官方 [SessionCommands](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/api/session-controller/src/commands.ts#L258) 创建普通 fork 时不再写 `parentSession`。本插件 [backend-guard.ts](../../src/host/composition/backend-guard.ts) 和 [profile-adapter.ts](../../src/host/composition/profile-adapter.ts) 仍靠它查源 ACP binding。 | 这是类型检查之外的行为风险：即使外部 Agent 支持 fork，新分支也可能被拒绝。须在真实 fork 操作期间取得并传递源绑定；最终公开扩展点需在实现前验证。不能猜测来源、伪造受管父子关系或回退空白 Agent 会话。兼顾旧日志与真正 subagent。                                                                                                                                                                             |
| 回复折叠         | 上游 [ChatNodeSeat](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx#L73) 新增 `foldedReplies=all/final`。本插件强制已提交回复 `groupTree:'turn'`，会绕过仅保留最终回答的偏好。                                                                                                     | 删除这项旧展示补丁，保留必要的 ACP 活动交错归一化。验证两种回复偏好、多步骤/通知/刷新及工作步骤展示模式。                                                                                                                                                                                                                                                                                                    |
| 运行时与依赖     | 官方最低 Node 升到 `>=24.9.0`；适配器当前声明仍允许 Node 22。Cordis 等精确版本也变化。                                                                                                                                                                                                                                                                              | 正式适配时同步 `engines.node`、工具链检查、peer/dev 依赖和说明；当前开发 Node 已满足要求。未找到本插件直接消费 Cordis timer wrapper 的代码，不能把 Node 原生 timer 一并列为必改。                                                                                                                                                                                                                            |

PTC 还有一个必须处理的声明差异：新版 `run_code` 是 [PTC executor](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/core/tool-executor-ptc/src/index.ts#L33) 自身的调用入口，不属于 `tools.schemas()/get()` 的注册工具。我们当前 `bridgeDefinitions` 将请求声明与注册表求交，会丢掉有效的 `run_code`。必须按执行器拥有的声明构桥，再由同一选定执行器执行；只换批次参数不能修好 PTC。

### 如何取得同一步的工具集合

已有公开入口：[system-prompt/assemble](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/core/system-prompt/src/index.ts#L31) 的第二参数是 `AssembleContext`，带 `agent/scope/modelSelection/signal/toolSet`；[AgentLoop](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/core/agent-loop/src/agent.ts#L292) 把已解析的同一对象传入。因此不必先要求上游新增 API。

建议按精确 Agent 实例保存借用候选，再与后续 `agent/pre-step` 的 turn/step 关联。无 `toolSet` 的诊断组装不参与；不能只按 Session ID 或 signal 匹配，因为同轮多步共用 signal。同一步 LLM 重试沿用原对象，adapter 不 dispose；释放归 AgentLoop 所有。实现必须验证组装/pre-step 失败、并发辅助组装、实例替换、取消和热卸载；借用不可跨步骤或轮次延用。

## 2. 可减少的维护负担

| 候选                 | 可以去掉什么                                                                                                                                                                                                       | 必须保留什么                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生回复保留与折叠   | [acp-chat-normalization.ts](../../src/client/ui/acp-chat-normalization.ts) 中强制把已提交回复提升到 turn 的旧补丁。                                                                                                | ACP journal 插入、reasoning/tool 交错、稳定节点身份和恢复；不能整块删除 normalizer。                                                                            |
| 无消费者权限字段     | [SessionLike.permissions](../../src/domain/session/session-facts.ts) 及 [acpSessionView](../../src/host/composition/session-facts.ts) 对应 getter 在生产源码中只有声明/定义，无读取者；可以连同 fixture 字段删除。 | 真正的 DSH/ACP 权限判断、待审批关联和审计。无需为无消费者字段复制官方私有权限投影。                                                                             |
| 公共模型/投影 owner  | 用领域服务或自有 ready handle 取代旧的按字符串 key 读取和类型强转。                                                                                                                                                | 已执行与待生效模型的区别；不能把本插件 `acpExecution` 的派发证明、消息 ID、forkReplay 等事实全换成通用 turn 状态。                                              |
| 官方工具准入与执行器 | 将条件准入、注册替换检测、native/PTC 选择和批次执行交给公共 `ResolvedToolSet` / `ToolsService`，减少重复规则。                                                                                                     | 能力地址、当前 ACP prompt 代次、授权身份和接受后排空。不同 MCP 请求间的 exclusive 屏障不能被一次有限批次数组的调度器直接替代。                                  |
| 真实 DSH 工具日志    | 新 `ToolBatchInput.log` 可让官方 executor 为真正由 Host 执行的 MCP 桥工具记录原生 `tool/call/result`，有望复用轨迹和改动摘要。                                                                                     | 先证明准确 turn/step、失败结算、模型历史与恢复语义，并解决 ACP/原生卡片重复；不能替 Agent 自有 shell/文件工具伪造原生事件。此项是后续专项，不纳入最小兼容承诺。 |

Sidecar 的 ACP 绑定、远端结果未知、持久化补存和恢复门禁，完整权限选项，以及协议/子进程所有权仍有独立职责。新版普通 Session API、通用 KV 或一次性子任务没有提供等价语义。也不能因为 UI 改版就整块移除已修复 ds-bot 共存的 slot 处理。

## 3. 实验性及可选功能优先级

所有候选均以主干兼容完成为前提。安装包、代码导入、服务启用和当前会话可用性分别验证；沿用官方 Plugins 开关，不增加第二套 ACP 开关。

| 优先级 | 功能                                          | 适配范围与限制                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一批 | **Developer tools — Statistics**              | 可直接复用官方统计视图，它消费原生 Session 事件和 usage。验证启停、刷新、窄屏；外部 Agent 未上报的内部步骤/缓存/费用须保持未知，不能当 0 或承诺完整计量。                                                                                                     |
| 第一批 | **会话搜索、Ralph、持久终端、语音、思考翻译** | 现有支持优先恢复并运行已有专项；无须自写 UI 或新增配置。Ralph/会话搜索仍随包分发，只是不再默认列在实验功能列表，不等于删除或新增能力。                                                                                                                        |
| 第一批 | **Agent Teams**                               | 随投影、模型读取和工具接口一起迁移，复用官方名册、任务和服务。验证启用→禁用→重挂载、成员冷恢复及待审批清理。                                                                                                                                                  |
| 第二批 | **Forge：手动关联 PR、状态和 diff**           | 可复用官方 `forgeSession.track(session,url)` 与原生视图。自动发现只识别原生 bash/pwsh 日志；ACP Agent 自有 shell 不天然产生这些事件，不能承诺自动捕获。                                                                                                       |
| 第二批 | **OAR / subagent_oar**                        | 可作为独立的一次性委派工具经工具桥调用，复用官方运行器与取消/通知。它不继承父上下文、没有可续聊 start 能力，仍需要对应 CLI/认证和部署配置，不能替代持续 ACP 会话或 Teams。                                                                                    |
| 专项   | **个性化推荐：启用插件卡**                    | `propose_action` 只有 root 成功加载指定原生 skill 后才按步声明；同一 ACP prompt 的内部循环不等于新的 DSH 步骤。需验证新准入与 MCP 清单刷新、权限身份、一轮一张卡、点击才启用和禁用后失效。                                                                    |
| 专项   | **个性化页面创建**                            | 在推荐卡之上还通过 `cordis` preset、独立 cwd 和 `structured_output` 驱动生成子会话；须验证生成、校验、安装、取消、撤销的完整路径。                                                                                                                            |
| 专项   | **Forge 自动 Worktree**                       | 官方 UI/pre-step 可直接调用 `worktrees.create`，不经过本插件只拦 `create_worktree` / `working_directory` 工具的 guard；而 Git 副作用发生在最终 cwd 设置前。首次空白会话可能自然采用新 cwd，但须验证绑定时机；已绑定且无 fork 能力的会话不能在副作用后才报错。 |
| 专项   | **Auto Review / headless Auto**               | #69 的核心限制仍在：官方审核依赖已记录的 native/PTC 调用，并用请求头模型直接 `ctx.llm.stream`；即使具备所需日志身份，ACP 路由的辅助模型调用仍会落入 `ACP_STUB_ROUTE`。需要单独的审核路由和策略接入，不能把完整 ACP 权限请求缩成原生一次审批。                 |
| 专项   | **CUA / PTC VM Script、跨调用状态**           | 随按 Agent scope 选择 executor 的新机制适配；确认 run_code 取消分类、嵌套权限、撤销及持久进程清理。旧 `tools.mode` 用例不能直接证明新组合可用。                                                                                                               |

主要源码依据：[官方可选组合](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/util/official-bundles/src/bundles.ts)、[统计](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/client-ui-stats/src/client/stats-definition.ts)、[推荐卡](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/action-cards/src/index.ts)、[Forge Worktree](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/client-ui-forge/src/worktree.ts)、[Auto Review](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/auto-review/src/index.ts)。

## 4. 官方 ACP 类能否复用

在目标标签的 `packages` 与 `apps` 中未找到名为 `AcpTools` 或 `ACPTools` 的类。实际实现如下；源码中的 `export class` 不等于正式 npm 包主入口导出，这些内部 ACP 类/函数均未作为主入口 API 导出。

| 实现                                                                                                                                                                                                                                                                                | 实际职责                                                                                                                    | 对本插件的结论                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [AcpSession](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/acp/acp/src/session.ts#L92)                                                                                                                                                           | 收到外部 ACP 请求后，创建/恢复**本地 DSH Agent**。                                                                          | 协议方向相反，不能替换调用外部 Agent 的 `AcpSessionRuntime`。                                                                         |
| [AcpModelControl](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/acp/acp/src/model-control.ts#L35)                                                                                                                                                | 把 ACP 模型选项映射到本地 `agent.model.select`。                                                                            | 不覆盖外部 Agent 的模式、任意 configOptions 和能力差异。                                                                              |
| 私有 [AcpProvider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/subagent/subagent-acp/src/index.ts#L80) / [startAcpRun](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/subagent/subagent-acp/src/run.ts#L336) | 一次性 fresh 子任务，`clientCapabilities:{}`、`mcpServers:[]`，汇总文本；固定 allow/reject，allow 分支可选 `allow_always`。 | 没有等价的持续会话、MCP、完整权限、fork/recovery、Teams 和流式 UI，不能继承或整块替换；其客户端源码相对 RC.4 没有变化。               |
| [ToolsService / ResolvedToolSet](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/core/tools/src/index.ts) / [ToolExecutor](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/core/tools/src/executor.ts)            | 官方公共的工具注册、按步准入和按作用域执行器。                                                                              | **应优先复用的主干接口**。`@deepseek-ai/dsh-tools/pipeline` 也提供调度组成部分，但不能忽略选定 executor 或跨独立 MCP 调用的顺序保证。 |

## 实施顺序与完成条件

1. **基础兼容**：正式分支更新精确依赖/Node 要求；迁移投影 handles、模型 owner 读取和批次工具 API；更新 fixture。要求生产、测试、工具类型检查通过，投影失败/卸载回归通过。
2. **行为兼容**：绑定同一步 toolSet、处理 fork 来源，并验证 Forge 直接 cwd 入口的恢复门禁，验证条件工具撤销、重试、迟到调用、接受后卸载、父/子审批及 fork 不降级。无 Host 运行证据前不发布兼容版本。
3. **小范围删债和快速功能**：移除 turn 提升补丁与无读取权限字段；启用原生回复偏好和统计视图，恢复已有可选功能矩阵。独立桌面验证 ds-bot 共存、热启停、首次会话、模型切换及 390px 明暗布局。
4. **独立专项**：推荐卡/生成页面、自动 Worktree、OAR、Auto Review、原生工具日志复用各自提供启停、取消、恢复及实际结果证据。真实 Agent 使用单独记录的精确 CLI/模型，优先免费或最便宜可用选项；协议夹具不代替真实运行证明。

## 实施记录（0.2.2-alpha 分支，未发布）

- 正式 manifest/lockfile 已精确锁定 alpha.2；候选插件版本 `0.2.2-alpha.2.1`，Node 要求改为 `>=24.9.0`。README 的安装命令继续指向已发布 RC.4，避免引用不存在的 alpha 发布资产。
- 工具桥使用官方批次执行器，保留 PTC 私有 `run_code` 声明及批次反馈/结束语义。由 `system-prompt/assemble` 借用宿主本步唯一 `ResolvedToolSet`，在真正 `step/start` 后开放调用；不重复执行条件工具谓词、不持有或销毁宿主工具集。稳定目录在连续轮次复用，跨 MCP 请求的互斥排序和已接受任务结算仍由桥维护。
- ACP 执行事实改为自有 Service 内部等待注册、持有私有 ProjectionHandle 并提供同步领域读取；fork guard 等待其投影可读后才发布路由。删除弃用的 key 读取与无人使用的 `SessionLike.permissions`，保留持久化绑定和恢复证据。
- Teams 模型使用 `agent.model.current()/select()`；删除自建 ModelSelectionRef、按 prompt 重新注入选择及旧 request 改写。模型选择由原生 owner 持久化，已进入的步骤不被重新指向。Sidecar 仅暂存未应用的休眠成员选择，核验保存时的原生记录截点，在原生选择成功落盘后按原值删除，不能覆盖后来的原生选择。旧版无截点的缓存若与已有原生选择冲突，以原生记录为准；未应用的旧偏好可能需要重新选择一次。
- 删除 ACP 回答强制提升到 turn 的显示补丁，遵循原生 all/final 折叠偏好；保留 journal 顺序、稳定 key 和末段归属。Statistics 通过官方可选插件启停，未知 usage 保留未知，不编造外部 Agent 的工具调用数量。
- 独立桌面发现 ds-bot 热启停时的会话撤销窗口：旧诊断 gate 的 React 清理会修改全局 view roster，触发宿主刷新已撤销但尚未清理的 binding。诊断视图改为随插件稳定注册，同一个会话可见性 owner 过滤官方 header/body 的公开 `conversationViews` source；保留原生组件、选择回退与侧栏隔离，清理 gate 不再修改全局 roster。旧失败证据保留，修复后的验收单独记录。
- 普通 fork 继续调用原生会话 fork、标题与目录逻辑；对 alpha.2 不再提供 parentSession 的分支，用经源/子双资源授权和官方精确 seed 核验的 Sidecar 来源凭据承接。没有可信来源或不满足最新截点/Agent fork 能力时仍拒绝，绝不降级为空白续聊。
- Forge 首轮建树先于 ACP 初始绑定，可直接使用新目录。**空闲时直接切回项目目录不会自动完成 ACP 交接**：该入口绕过工具准入，下一次输入进入 cwd reconciliation；已补直接服务入口测试。上游没有公开变更前 guard，不为此复制 Forge 投影或修改官方 service。

自动 Review、生成页面、推荐卡、OAR 和 ACP 桥接工具的原生日志仍属于独立适配范围；本次不能据依赖更新或 Stats 通过就声称这些功能完全兼容。

### 新发现的发布阻塞：已开始会话切换模型

实际 `team-model-selection.e2e.ts` 确认：成员唤醒时 `model/selection` 已恢复目标模型，但 alpha.2 的 `compaction-basic` 在 `agent/request` 上对切模执行严格容量检查。ACP 模型目录没有 `contextWindow` 时抛出 `MODEL_SWITCH_COMPACTION_FAILED`，尚未进入 ACP prompt。该限制同样可能影响已开始的普通 ACP 会话切模，不是 Teams 选择未保存。

最小触发条件是：ACP 模型 A 已有一次请求记录 → 通过原生模型 owner 选择 B → 再次提交输入。失败发生在官方 `compaction-basic` 的切模监听器读取 B 的上下文容量时；协议夹具日志确认第二次 ACP 请求尚未派发。首轮选择 B 不构成相同场景，也不能代替切模回归。

官方 `compactPressure` 是私有方法，`compactIfNeeded` 覆盖或替换 `ctx.compaction` 不会替换已注册的切模监听器；目前没有公开的外部上下文准入钩子。用双 `agent/request` 监听器吞掉错误可能丢失第三方路由钩子的最终配置，不能作为通用兼容。此分支保留真实失败回归，不伪造容量、不改写历史 header、不关闭全局原生压缩；**尚不具备发布完整 alpha.2 兼容版本的条件**。推荐上游公开含目标模型的自动压缩准入，让 ACP 可明确声明外部上下文所有权，普通原生会话保持原策略。

Statistics 的 390px 截图已人工检查：原生表格列过窄，存在文本挤压；本次验证其数据、启停、刷新及未知值语义，不声明窄屏表格体验合格。

### 本地验证记录

验证时间为 2026-10-28 至 29 日；macOS arm64、Node `24.19.0`；适配器 pnpm `10.7.0`，源码 scaffold pnpm `11.28.5`。正式依赖均来自精确版本 npm 包，共 101 项开发依赖检查通过。

| 验证                                                           | 结果与范围                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 官方 `pnpm build:artifacts`                                    | 8 gates 通过；只作为 alpha.2 scaffold 构建证据                                                                                 |
| 适配器 `pnpm build`                                            | 通过；包含 Typert、Host/client/worker 构建、公开消费类型及包导入闭包检查                                                       |
| 生产、单测、工具、E2E TypeScript                               | 通过                                                                                                                           |
| `pnpm exec vitest run`                                         | 202 文件通过、1 文件跳过；2549 项通过、3 项跳过，无未处理异常                                                                  |
| 原生回复 all/final、Statistics、普通 fork                      | 真实 Loader/浏览器夹具通过；fork 包含热重载后同 ACP child 恢复                                                                 |
| `native-navigation.e2e.ts`                                     | 最终构建通过：保留草稿、原生菜单、窄屏诊断页，以及已选诊断→真正原生会话→返回 ACP 的页签/正文恢复；ACP 和本地原生夹具各一次调用 |
| `long-conversation.e2e.ts`                                     | 12 轮原生/ACP 对照通过，包含真实 native/PTC 调用、恢复原生执行器及历史渲染稳定性；100 轮 soak 未启用                           |
| Worktree、可选宿主工具、插件生命周期、首次活动等待、原生子代理 | 5 文件、9 项通过                                                                                                               |
| `team-model-selection.e2e.ts`                                  | 最终修复后复测仍失败：seq 18 记录目标模型 B，seq 24 被上游切模压缩缺容量阻断；详见发布阻塞                                     |
| 独立桌面 ds-bot `0.2.2` 共存与热启停                           | 发现并修复撤销窗口；最终双方启停、Bot/原生导航、诊断正文回退及恢复通过，renderer errors 为空                                   |
| 独立桌面首次加载、活动取消与恢复                               | 无密钥夹具的真实 `session/new` 延迟门控未出现重连提示；活动中停用观察到 cancel/SIGTERM，重新启用后新会话回复正常               |
| 独立桌面 390px 明暗布局                                        | 最终构建的 Chat/Diagnostics 已目视检查，无正文/输入区重叠或泄漏的别名 DOM 锚点；不含 Statistics 表格                           |

独立桌面使用精确 npm 库、匹配标签的官方桌面壳和单独的 home/profile/workspace；两次桌面进程均已退出。修复前的 `validation-result.json` 与 `corrected-lifecycle-result.json` 保留失败，修复后另存 `owner-fix-result.json`、`owner-fix-views.json` 和截图，不以复跑成功覆盖原始失败。

这些运行均为无密钥协议夹具或本地确定性原生适配器，不构成真实商业 Agent 或跨平台认证。其余可选功能矩阵及发布 CI 没有重跑。原始日志在 gitignored `.local/migration-0.2.2-alpha.2/`，桌面过程说明为其 `desktop/evidence-note.md`。

## 完整复审与受限解决路径（2026-10-29）

复审采用目标标签 `.agents/skills` 的代码审查、简化评估、错误处理、Cordis 生命周期、UI/响应式与 prose 规范，并按适配器自己的 review/validation 工作流限定验证范围。检查包含当前分支完整未提交改动、公开包入口、生成 Remote、独立 worker、真实 Loader 的消费者销毁顺序，以及源码、脚本、资源的消费路径。

### 切模解决路径

现有公开接口提供一个**需要手工选择的临时方案**：新增独立 `acp-external-context` preset，仅其隔离的 `compaction-basic` 配置 `auto:false`，不修改默认 native preset。用户必须在新会话首次输入前选择该 preset；已经开始的会话不能迁入，不能通过修改旧日志绕过限制。native 子任务会继承父 preset，因此同样失去自动压缩。这不会自动兼容 Auto Review、标题或其他辅助模型调用。

已用精确 npm `0.2.2-alpha.2` 的真实 Loader/preset registry/AgentLoop 和本地 scripted adapter 验证 **4/4**：ACP 请求由 A 切到 B；默认 native 仍执行严格容量检查；子任务继承该设置；已开始会话拒绝改选 preset。测试组合只装入相关压缩隔离组，完整 standard preset 示例尚未运行 Host/桌面。例子和证据在 `.local/assessment-0.2.2-alpha.2/acp-external-context.patch.yml`、`verify-compaction-preset-npm.mjs` 和 `compaction-solution-verification.json`，未写入用户配置或正式插件默认组合。

正式方案已形成 `compaction-automatic-policy.proposed.patch`：让 `compaction-basic` 在压力、切模和 overflow 三个自动入口修改历史前询问同步、Agent 作用域内的路由策略；默认继续，只有当前 ACP 路由 owner 明确跳过。草案的四项定向回归覆盖无容量读取/历史改写、scope 和卸载、其他中间件失败及策略失败；连同临时方案源码用例共 **8/8** 通过，补丁应用检查通过。该补丁只在忽略的源副本验证，未改上游 tracked 源码或发布依赖，尚需上游类型/构建及真实 ACP 验收。默认组合的发布阻塞仍然存在。

### 审查发现与清理边界

- **P2，慢工具卸载**：原来的传输宽限期也限制了已准入工具的收尾，工具超过宽限期时依赖可以提前释放。现保留真实 tools 消费者直到调用、结果和反馈完成；普通连接关闭仍可限时。两个 fake-clock 回归覆盖直接卸载和先关闭连接再卸载，推进 30 秒后仍要求依赖卸载等待，最终反馈只记录一次。若工具始终不结算，provider 卸载也会继续等待；传输超时不能冒充已完成的工具收尾。
- **P2，普通 fork 生命周期**：原生 child 已创建而 ACP 来源尚未登记时停用插件，会遗失关联；Client Remote 与插件 disposer 并发，单纯等待协调器不能保证 Remote 仍在。现在会在派发前保存恢复记录，以 Host Sidecar 的持久化随机 scope 和 source/cut 隔离；已知 child 只重试来源登记，未知提交结果不能重做创建。登记仍需 Host 双资源授权和精确 seed 校验，客户端记录不构成授权。
- **P2，fork 预期拒绝分类**：来源失效、历史不匹配、child 已活动等拒绝现已保留稳定类型及相应反馈，不再全部压为通用可重试错误。导航成功后才清除已创建 child 的重试关联。
- 删除只写不读的 `feedbackArchives`、无生产消费者的 `isQwenTaskWakeStep` 包装、测试中弃用的 registry `stateOf` 读取，以及没有生产/manifest 消费的 `sandbox-policy` optional peer（保留测试 devDependency）。错误关联 ID 改为时间戳加 128 bit 随机值，去掉模块计数器；历史 ID 的显式传入仍保留。清理入口和构建文件中重复、过时的说明。
- 源码可达性检查覆盖公开 Host/client/permission-policy 与独立 MCP worker 入口，没有确认可删除的完整源文件。36 个脚本都有调用、CI 或文档消费者；图片与 registry 资源有消费路径；locale 文件通过发布通配入口和宿主加载。CSS class 和动态 locale key 不能仅因文本搜索为空就删除。

**该轮暂留的规范债**：当时 `host-execution-owners` 和 `local-settlement` 的进程级 registry 负责跨热重装的在途结算，不能当死缓存移除；`live-diagnostic-trace` 的进程级 sink 也有脚本与 E2E 消费者，尚未证明多个 Host 的诊断隔离。这些 owner 随后的迁移及最终清理顺序见下节“剩余规范债清理”，不以删除缓存替代连续性设计。

该轮还记录了 Audit 等旧版 CSS 未全部使用 `(hover: hover)` 的响应式缺口，未在该轮修改或实测；后续修复见下节。空白 Chat 的模块级订阅集合已改为无状态常量 source，原生 renderer 别名计数改为每次挂载拥有，避免无意义的全局可变 owner。

### 该轮修复验收

- `pnpm build` 通过，包含生产 TypeScript、Typert 生成、严格公开消费程序、291 个打包文件及 116 个 JavaScript 相对导入闭包。
- `tsc --noEmit -p tsconfig.test.json`、`tsc -p tsconfig.tools.json`、`pnpm typecheck:e2e` 通过；`pnpm format:check` 和 `git diff --check` 通过。
- 慢工具关闭、owner 清理及相邻桥接回归共 100 项通过。fork 协调器、Host registrar、权限 Remote 和客户端 source/renderer 的 5 文件定向检查 69 项通过，包含不同 Host 隔离、存储故障、导航失败、owner 撤销和 query provider 单独撤销。
- Qwen 实际输入分流 10 项通过；错误 ID 与客户端本地化 12 项通过。相邻 Sidecar、registry、Remote 和公开面检查初次 166 项中两项公开方法清单仍缺新 `nativeForkScope`，补齐清单后对应两个文件 15 项复测通过；没有将失败日志覆盖为成功。
- `pnpm test:e2e test/e2e/native-fork.e2e.ts test/e2e/native-navigation.e2e.ts`：2 文件、2 项通过。真实 native fork 在 child 已发布、标题 RPC 暂停期间停用插件，随后释放操作、重新启用并刷新页签；再次点击同一源/截点只登记并打开原 child，原生 fork 总共调用一次。接着验证真正 ACP fork 历史和再次热重载后的同 ACP child 恢复。原生导航用例覆盖草稿、视图切换及窄屏入口；本轮 child 截图已目视检查。

fork 登记现在有自己的停准入和在途操作等待；registry 交出真实 query dependency disposer，按顺序完成登记后才释放查询与 Sidecar。scope ID 初始化为同步 SQLite 操作，并在既有清理链建立后执行，避免新增的初始化等待窗口。

该轮没有重跑全量单测、独立桌面、真实 Agent 或跨平台矩阵。此前桌面记录属于此前构建；该轮新增的页签恢复逻辑以受控回归和真实浏览器组合为证据。页签关闭、清除站点存储或浏览器强退丢失尚未记下的 child 时，不承诺自动恢复；创建结果未知会阻断重复派发。

该轮日志和消费图保存在 gitignored `.local/review-0.2.2-alpha.2/`，工具生命周期日志保存在 `.local/migration-0.2.2-alpha.2/review-tool-*.log`。上游压缩方案的源码实验也已移入适配器 `.local/assessment-0.2.2-alpha.2/acp-compaction-policy/`；reference 工作树只保留原有 `.claude/skills` 删除，没有新增源码或临时文件。

## 剩余规范债清理（2026-10-29）

执行连续性改由显式 Host 根服务 `acpHostContinuity` 拥有。每个 Host 独立持有 `HostExecutionOwners` 的退役 runtime、恢复门禁及 `LocalSettlementOwner` 的待补存队列；插件热重装借用同一 Host owner，使已经受理的工具与本地结果结算能够延续。独立 adapter 直接拥有自己的实例，不再依靠模块或进程级 Map。该内存连续性仍不保证跨 Host 进程重启恢复。旧 runtime 的晚到收尾只删除自己所属的执行集合，不再误删同会话的新门禁。

Host 最终关闭先停止新资源借用、新结算 sink 和后台重试，再调用并等待各 registry 已登记的实际清理。registry 停止路由及新准入，等待已接纳的 fork 登记、工具、投影和最终写入，之后释放查询、持久化 scope 与 Sidecar；某项清理失败仍尝试后续资源清理并报告错误。最后由 Host owner 等待退役 runtime 和结算中的写入，释放队列与映射并撤销服务。热重装只释放该代消费者，不提前清空共享的在途状态。独立 adapter 的重复关闭共享同一个完成 Promise；多个 runtime 中一项关闭失败，也会等其余 runtime 的最终写入和 handoff 收尾之后再关闭 owner。fork 投影的异步就绪检查移到 Sidecar 获取之前，并在等待后验证 scope 仍有效，避免安装失败或中途停用时留下未托管存储。

诊断收集器也改为显式 owner：Host 根服务 `acpLiveDiagnostics` 在同一 Host 的热重装之间保留身份，独立 live 检查直接拥有自己的 collector；不同 Host、不同检查运行不共享 sink。默认不安装 sink、不增加诊断日志。替换先停止向旧 sink 送入新记录，collector 继续持有其已接纳的写入；sink 的撤销 disposer 和 Host 关闭会等待这些写入，排空 collector 后再撤销服务，写入失败仍可观察。

`AcpAuditHeaderAction`、`AcpSection`、`AcpAgentControl` 三份 CSS 的 hover 效果已限定于 `(hover: hover)`，不依赖窗口宽度判断输入设备；选中、展开、禁用和 `focus-visible` 样式保持独立。真实点按还发现旧工具栏在 390px 下将筛选组压至不可点击；现改为筛选与操作组换行、搜索框弹性分配空间，回归同时断言六个控件位于可见边界内、互不重叠且拥有点击命中目标。新增 `hover-responsive.e2e.ts`，在同一真实 Loader 夹具内只发送一次本地 mock ACP prompt，分别检查桌面悬停与 Chromium `hasTouch` 上下文的 390px 明暗点按、选中态及键盘焦点。删除操作只打开确认再取消，配置编辑不保存。Electron helper 未模拟触屏，因此该场景在 Electron 模式明确跳过；本轮实际运行的是 Chromium。

最终 `pnpm exec vitest run` 为 **206 文件、2592 项通过，1 文件／3 项跳过**；覆盖 Host 隔离、重装、待结算写入、计时器停止、旧 owner 晚到、重复关闭、部分关闭失败，以及安装失败／安装中撤销。首轮有 2 文件／18 项失败：旧 registry 测试替身缺少真实 Context 生命周期，以及共存测试仍假定安装不创建 Sidecar。前者改用真实 Cordis 事件及卸载，后者改为只读 SQLite 全表快照，确认安装仅生成 fork scope 元数据、原生调用前后所有会话业务表仍为空且 scope 不变；修复后完整复测通过，保留首轮失败日志。

`pnpm build` 通过，包括生产 TypeScript、Typert、严格公开消费程序、295 个打包文件及 118 个 JavaScript 相对导入闭包；测试、工具及 E2E 类型检查、全量格式检查也已通过。浏览器首轮 5 文件中热启停、首次绑定加载、普通 fork 恢复和原生导航 4 项通过，hover 用例失败。先修正夹具使用的记录分类，再由真实点按定位并修复上述工具栏遮挡；官方 Button 在 touchend 后短暂保留 `:active` 的行为按其真实完成状态等待，不改产品按下反馈。每次失败日志和截图另存，未覆盖。

最终 CSS 构建后，`native-navigation.e2e.ts` 再次通过；`pnpm test:e2e test/e2e/hover-responsive.e2e.ts` 最终 **1/1 通过**，包含明暗两色、鼠标／触屏的 36 组样式比较、真实点按、选中／展开／键盘焦点与六个工具栏控件的边界及命中目标。只派发一次本地 mock ACP prompt，renderer errors 为空；390px 列表、详情和插件配置截图已目视检查。先前 4 项浏览器通过记录中的 Host 热重装、首次加载与 fork 代码在后续只改 CSS／hover 夹具时未再变化；没有将分场景证据写成一次五项全通过。静态消费图覆盖 171 个源／样式文件，除按 tsconfig 纳入的 ambient `.d.ts` 外均可达；没有确认可删除的完整源文件或未消费 CSS class。只读常量表、React Context 身份和独立 MCP worker 的进程入口没有当作共享生命周期缓存删除。

本轮证据目录为 gitignored `.local/standards-debt-0.2.2-alpha.2/`；hover 的计算样式、390px 截图及运行结果由测试写入其中 `hover/`。此前独立桌面证据仍只覆盖其对应构建，不能自动认证本轮改动。上游切模压缩的发布阻塞保持不变，未新增正式默认 preset，也未发布候选版本。
