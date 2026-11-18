# DSH RC.1：ACP 能力限制与上游设计备忘

本文保留基于 DSH `dsh-v0.2.2-rc.1` 的五项接口设计分析。当前决策是不修改上游，也不把上游合入作为本轮前提；下方接口名称只是备忘，不是待实施或已发布 API，未提交上游 issue 或 PR。

当前插件侧落地边界：已有会话切模恢复原模型并提供独立新会话确认，Teams 拒绝不可执行的变更；已适配的 Chat 分叉入口补齐未知结果放弃与成功后清理恢复。其他原生分叉入口缺少可靠来源时继续拒绝，不伪造来源或补丁私有方法。Auto Review 完整兼容、Forge 所有入口的目录变更前准入、ConfigEditor 关闭事务保证暂不实施；保留现有安全门禁与能力限制。兼容证据与迁移范围见[总评估](dsh-0.2.2-rc.1.md)，当前能力边界见[原生复用说明](../native-reuse.md)。

| 问题           | RC.1 受限能力                                                                   | 上游责任                                                                 | 适配器责任                                                   |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 原生分叉入口   | ACP Chat 节点已有来源登记；其他原生入口可能先创建 child，再在输入时拒绝缺少来源 | 统一动作与能力状态；提供创建时的真实 source/cut 和可等待的扩展完成边界   | 核验 ACP fork 能力、绑定和历史截点；持久登记、失败恢复与权限 |
| 自动压缩       | 已建立会话不支持原地切模；插件恢复旧模并提供独立会话                            | 在自动压缩读容量或写历史前，允许 scope/route 策略决定是否执行            | 本轮不跳过压缩；使用插件 guard 与独立会话出口                |
| Auto Review    | 宿主桥接工具缺审核日志身份；ACP 路由拒绝辅助请求                                | 明确独立 reviewer route 和审核可用性                                     | 记录真实 Host 工具调用，保留准入、取消和审批语义             |
| Forge 工作目录 | 工具路径会检查 fork 能力；已绑定会话从 Forge 返回项目后仍可能进入恢复           | 在目录提交及 Git 建树副作用前提供统一准入                                | 检查 Agent 保留上下文的能力，结算旧执行后交接绑定            |
| 旧设置导入收尾 | 自动导入保留，但插件停用后已接纳的配置编辑与标记写入可能继续                    | 拆分事务接纳、持久化与 Loader 激活等待，提供不会等待自身卸载的操作 owner | 停止接纳新导入，跟踪原生事务终态，成功后写幂等标记           |

## 1. 统一原生分叉动作、能力状态与精确来源

### 当前问题

RC.1 的标题/侧栏菜单与快捷键通过 [`UiWorkspace.forkSession`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-workspace/src/client/navigation.ts#L324) 调用原生 Session fork。省略 `atSeq` 时，Host 从自己持有的 observation 选择最新完整轮次边界，再用 [`buildForkSeed`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/commands.ts#L213) 生成种子。普通 child 保持独立 Session，没有 `parentSession` 关系。

本插件的 [Chat fork coordinator](../../src/client/coordinator/native-fork.ts) 会在原生创建后登记 source/cut；Host 登记链路依次检查[双方资源权限](../../src/remote/service.ts#L595)和[真实种子、子会话未活动、父 ACP 绑定等条件](../../src/host/composition/native-fork.ts)。其他原生入口不经过这个 coordinator。未建立 ACP 绑定、没有 `parentSession` 来源的普通 seeded child，在默认保留历史的继续路径上，会由 backend guard 进入 `binding-missing` 恢复，或由 provider 在 `runtime.start` 前报 `ACP_FORK_SOURCE_REQUIRED`；不会把新建空白远端会话冒充历史分叉。已有绑定恢复、受管子代理及用户显式选择空白恢复不属于这一拒绝范围。

`session/created` 通知只提供 child，不能可靠恢复本次选择的 source 和 exact cut。两个来源可以有相同历史，默认边界也可能在读取之间变化；复制的 ACP replay marker 不是调用者授权或来源登记。只隐藏一个菜单仍会遗漏快捷键和直接 API 调用。

### 上游建议

由会话动作 owner 提供共用 fork 动作入口，标题、侧栏、快捷键和 Chat 节点共同消费其能力状态和执行函数。能力状态至少区分“可执行”“正在检查”“当前不可执行及本地化原因”，更新必须跟随当前 Session、路由、插件及权限生命周期。查询结果仅用于展示；执行时重新核验。

Host 的 fork 操作需要提供两个有生命周期的扩展阶段，均使用同一次 observation 选出的真实截点：

1. **创建前准入**：原生权限检查和边界解析后、创建 child 前，向 scoped 扩展提供 source 身份、已解析的 inclusive `atSeq`、所选种子及取消信号。省略边界时也必须明确最终取值。默认保留原生行为；外部上下文 owner 可明确拒绝不支持的历史分叉。
2. **创建后完成**：在向用户承诺 child 可以继续输入前，以同一操作的 source、child、cut 等事实等待扩展登记完成。Native 继续拥有创建、编目、工作区与标题；ACP 扩展拥有外部绑定来源。不要把独立 fork 改成受管子代理关系。

共用客户端动作需能将已解析的 source/cut 交给现有 ACP coordinator，或消费 Host 已完成的等价登记。不要要求客户端从“最新 seq”重新计算默认 cut。直接调用原生 fork API 也须经过 Host 准入；UI capability 不是授权边界。

原生创建成功而后续登记、标题或工作区关联失败时，返回结构化阶段与已确认 child ID，保留可重试对象。扩展应能按操作/child 幂等重试；结果未知时不能再创建另一个 child。接纳后卸载要停止新操作并等待本次原生调用和登记结束，保持授权、query 和存储依赖可用。单独的事后广播不能提供这些保证。

### 适配器配套

复用现有 source/cut 验证、双资源权限、Sidecar 与重试 journal，补接统一入口。只接受当前绑定、空闲父执行和真实 `session/fork` 能力；外部 Agent 仅支持最新私有上下文时，旧 cut 应在创建前明确拒绝。原生目标不受 ACP 限制，插件撤销后恢复原生动作贡献。

上游接口到位前，保留当前安全拒绝，明确提示使用已适配的 Chat 分叉路径或新建独立会话。不能用 monkeypatch、重复菜单 id、扫描历史猜父会话，或补造 `parentSession` 来宣称所有入口已兼容。

### 验收与风险

- 标题、侧栏、快捷键、Chat 节点及直接 API 使用同一准入；无 fork 能力、旧 cut、忙碌父会话、权限不足时，不创建 child、不派发 ACP。
- 省略 cut 时，父历史并发增长不会改变已选边界；显式 cut 与实际 seed 严格一致。来源相同但 cut 不同、历史相同但来源不同均不得混用。
- 创建后登记失败、工作区关联失败、标题失败、刷新和插件卸载后重试沿用已确认 child；未知结果不重复创建。迟到结果不能打开或登记到新的 owner。
- 冷恢复缺来源 child 仍拒绝，`start/fork/prompt` 调用数均为零；恢复原生路由后不得意外继承 ACP 私有状态。

主要风险是跨原生持久化与插件 Sidecar 的非原子提交。方案必须暴露“child 已创建但未可用”，不能承诺回滚已发生的创建或远端 fork。公开来源事实不应暴露调用者无权读取的 Session 内容。

## 2. 按路由决定宿主自动压缩

### 当前问题

[`compaction-basic` 的模型切换处理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/compaction/compaction-basic/src/index.ts#L183) 在下游路由解析后，使用目标新模型容量检查历史。缺容量会抛 `MODEL_SWITCH_COMPACTION_FAILED`，发生在 ACP prompt 前；短历史也一样。`modelPolicies` 只有阈值、保留和摘要策略，没有每路由 `auto`。

Host 的 replay 历史和 token meter 不代表外部 Agent 的私有上下文。编造容量，或为 ACP 调用一个原生摘要模型，都不能使两者等价。覆盖公开 `compactIfNeeded` 也不能覆盖切模直接调用的私有 `compactPressure`。

### 上游建议

由 compaction 包声明 scoped 自动压缩准入，默认执行现有策略。提供真实 Agent、最终 provider/model、trigger（步前压力、模型切换、请求溢出）与取消信号；允许外部上下文 owner 明确返回跳过。决策应发生在容量解析、prune 和 Session 替换写入之前，三种自动路径都使用它。

跳过切模压缩时返回已经由下游解析的原始 config；不重写 header，不吞路由、权限或真实服务错误。没有扩展时原生行为完全一致。扩展失败应作为显式失败报告，不能默认“安全跳过”。该接口属于压缩策略 owner，无需让所有 LLM adapter 依赖可选 compaction 包。

手动 `/compact` 是另一项用户操作：对私有上下文没有对应 ACP 能力时，明确报告不支持。不要把自动 skip 扩展成“手动压缩成功”，也不要未经用户选择只压缩 DSH 展示历史。

### 适配器配套

按实际注册并仍存活的 ACP route owner 决定跳过，不能仅凭 `acp-` 前缀豁免任意 provider。插件热停启撤销并恢复 scoped 策略；外部 Agent 继续管理自己的上下文。普通模型选择和 backend transition guard 保留。

可用的受限备选是独立 ACP preset 的 `compaction-basic.auto: false`，由用户为新 Session 选择。它会影响该 preset 内原生子任务的自动压缩，也不能迁移已开始 Session 的 preset 或解决辅助调用，不应改写全局默认。

### 验收与风险

- ACP A 已成功请求后选择 B，下一次 prompt 和 Teams 成员恢复唤醒都真正到达 B；跳过路径无 Host prune/compact 写入。
- 同一 Host 的原生 A→B 保留容量检查、实际压缩和真实错误；普通 pre-step、溢出和手动命令分别验证。
- 第三方路由 hook、backend guard 的拒绝以及取消仍生效；热重装和 owner 变化不能让已失效路由继续获得豁免。

风险是“外部上下文”判定过宽导致原生上下文失去保护，或 skip 发生在部分历史修改之后。应从真实 route owner 决策，并将准入放在所有自动副作用之前。

## 3. Auto Review：独立 reviewer 与真实 Host 工具日志

### 当前问题

RC.1 给[审核请求](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/experimental/auto-review/src/index.ts#L678) 增加 `sessionId` 和 `purpose: 'auto-review'`，修复原生 OpenCode provider 的 header/路由等需求。这不是外部 OpenCode ACP CLI 的会话接入。

审核仍要求当前 open step 中唯一的 native root `tool/call`，以及身份匹配的 `assistant/message`；PTC 还要匹配 inner-start。当前 [ACP 工具桥](../../src/host/tools/bridge.ts) 调用官方 batch executor 时没有提供 `log`，因此通常在构造审核输入时已经失败。即使补齐日志，审核模型仍来自本会话 request header，ACP adapter 会拒绝辅助 purpose。此时外部 Agent 的 prompt 正等待工具结果，不能向同一会话再次发审核 prompt。

### 上游建议

Auto Review 提供明确的 reviewer route 配置或 scoped 解析器，可为外部上下文会话选择普通原生 provider/model；默认仍使用原会话模型。解析结果须在同一审核操作内固定，保留 Session 归属、`purpose`、取消与超时；缺少可用 reviewer 应在选择该能力时显示不可用，而不是将每次工具请求伪装为风险拒绝。

审核输入、政策、决策解析、原生 approval fallback 和 pre-execute hook 继续由官方拥有。无需在适配器复制审核引擎。临时通过公开 `llm/stream` 按 purpose 转到另一原生 route 在结构上可行，但仍需明确配置、处理递归及生命周期，不能静默借用用户默认付费模型。

### 适配器可先完成的工作

为真正执行的 Host 工具调用接入已有 [`ToolBatchInput.log`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/core/tools/src/executor.ts#L38)，绑定已准入步骤的 turn/step、Host root call ID 和同一个 toolSet。PTC root/inner 身份沿用官方执行器。调用、结果、额外 context 和结算失败必须归属于同一执行，卸载等待最终日志写入。

新增日志会进入原生 replay、工具轨迹、Forge 等消费者，必须检查“外部 Agent 发起的桥接调用”能否由当前原生事件准确表达，以及 replay 是否错误重建 assistant 工具调用。如需标记来源或补齐日志 API，应由工具事件 owner 定义；不能伪造 assistant 回答或把缺少的终态补成成功。

只将真实 Host 桥接工具纳入这项工作。Agent 自有 shell/文件操作和 `session/request_permission` 的多范围选项没有同样的 native schema、历史和执行 owner；它们继续走现有 ACP 权限路径。ACP Auto/Ask 与原生 Auto Review 必须保持明确区分。

### 验收与风险

- native 与 PTC 桥接调用有唯一、真实的根/内层日志；普通成功、拒绝、取消、超时及结果写入失败均可重建，重试不会重做已完成工具。
- reviewer 使用明确选择的原生路由；Session id/purpose 保留，主 ACP prompt 继续等待本次工具结果，不发生第二次 ACP prompt、递归调用或模型选择污染。
- 低风险允许、风险拒绝、审批 fallback、reviewer 不可用与服务错误分别呈现。插件停用或取消后迟到决定不能执行工具。
- 比较新增日志对聊天记录、replay、Forge 自动关联和工具结果展示的影响，避免重复内容；外部私有工具没有被伪装成 Host 工具。

风险包括额外模型认证/费用、向另一 provider 发送审核上下文，以及原生历史语义改变。启用时应让用户明确 reviewer 及其范围；不能通过“修复兼容”隐式授权跨 provider 传输。该专项不以取消企业权限或缩减 ACP 授权选项为代价。

## 4. Forge 与工作目录变更前准入

### 当前问题

本插件对 `create_worktree` 和带 `cd` 的 `working_directory` 工具执行前检查 Agent 的上下文保留能力。Forge 首轮建树发生在初始 ACP 绑定之前，可直接采用新目录；但 [`continueInProject`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/experimental/client-ui-forge/src/index.ts#L529) 直接调用 `workingDirectory.set`，绕过工具 guard。已绑定 ACP 会话下一次输入可能进入 cwd reconciliation，即使 Agent 支持 fork。

[`WorkingDirectoryService.set`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/session/working-directory/src/index.ts#L163) 没有公开变更前准入。[Worktree 创建](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/experimental/worktree/src/index.ts#L169) 则先改 Git，再调用该服务。因此仅在最终 set 前加 guard，仍可能在拒绝前留下分支和 checkout。

### 上游建议

工作目录 owner 提供 scoped 的计划变更准入，包含精确 Agent/Session、当前目录、目标绝对路径、来源原因和取消信号。普通 set 在路径验证后、持久提交前检查；Worktree create/restore 必须在第一个 Git/目录副作用前使用同一机制。目标目录尚未创建的 worktree 计划不能要求它此时已经存在，应在实际提交时再做现有目录验证。

准入不能只是一次过期的布尔检查。将它限定于当前 owner、旧目录和一次计划操作，在提交前复查，取消或卸载后失效；不同目标/新绑定不得复用。原生默认允许，显式拒绝通过同一原生 UI 和工具错误机制报告。直接服务调用和自动目录恢复也要有明确行为，避免只覆盖某一个按钮。

提交后的事件或结果应清楚区分“目录未改”“Git 部分完成但目录未改”“目录已提交”，并允许等待上下文 owner 的必要交接。Git 的已有副作用不能假称回滚；路径消失等自动恢复不能偷偷重建空白 ACP 会话。

### 适配器配套

首次绑定前不要求 fork；已有绑定则核实同代 owner 与真实 `session/fork` 能力。预检查不能等待当前工具所依赖的 ACP prompt 完成，否则会自锁；先确认能力和绑定身份，等工具结果、旧 prompt 与 Host 写入结算后执行现有 fork 交接。

直接 UI 发起的空闲目录变更也要由同一个会话交接 owner 承接，在新绑定完成前阻止下一次 prompt。已派发但结果未知继续保留恢复门禁；不支持 fork 的 Agent 在副作用前得到明确拒绝。继续复用官方 workingDirectory/worktree 服务，不复制 Forge 状态机或修改其私有方法。

### 验收与风险

- 无 fork Agent 从工具、Forge 返回项目、worktree create/restore 等入口请求改变目录时，在允许范围外没有 Git、目录或远端副作用；首次空白会话建树保持可用。
- 有 fork Agent 的工具路径和空闲 UI 路径都保留外部上下文；提交后立即输入、取消、热停用、并发变更不会使用旧绑定或错误目录。
- Git 部分失败、目录提交后 fork 失败、远端结果未知分别保留真实状态；重试不重复建树或降级为空白会话。
- 原生 Session 仍沿用官方权限、Git helper 限制、目录恢复和提示，不受 ACP 专项能力误拦。

主要风险是检查与执行之间的 owner/目录变化，以及跨 Git、DSH Session、外部 ACP 的非原子交接。应复用现有操作 owner 与明确阶段结果，避免引入一个只检查 UI、无法约束实际执行的旁路开关。

## 5. ConfigEditor 旧设置导入的事务与卸载边界

### 当前问题

[旧设置导入器](../../src/host/composition/legacy-settings.ts) 仍自动将旧 `dsh-acp.agents` 配置交给官方 ConfigEditor；保留源文件，并尊重当前 profile 已显式设置的 `agents`，包括空对象。本轮保留这项功能，没有合入会死锁的收尾改动。

当前插件卸载只设置 `disposed`。它能阻止尚未接纳的导入，但已经进入 `configEditor.edit` 的异步任务可能继续，随后创建目录并写入不含配置或凭据的导入标记。插件报告停止并不代表这部分工作已静止；Host 退出可能中断后续编辑或标记。标记失败仍可重试，已显式保存的 `agents` 会防止重试覆盖新配置，但这不等于具备完整的卸载收尾保证。

[`ConfigEditor.edit`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/boot/config-editor/src/index.ts#L87) 的 Promise 在 Loader reconciliation 完成后才成功：先 reconcile，再运行 change mapper，原子写配置后再次 reconcile；失败时回写原文并再次 reconcile。每次 [reconcile](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/boot/app-boot/src/index.ts#L343) 都可能等待本次捕获的旧 fiber 和 Loader 就绪。

因此两种简单收尾改动都不成立：

- 在发起导入的 ACP 插件 disposer 中等待 edit：不能笼统认定正常导入必然重装 ACP：`agents` 和 `toolApprovalDefault` 是 volatile 配置。风险在并发的 entry/provider 重装或关闭；此时 reconcile 可能等待旧 fiber，旧 disposer 又等待 edit，形成等待环。
- 将导入移到 `root.inject(['configEditor', 'profileContext'])` 后等待 edit：只能绕开目标 ACP entry 的一条环。[ConfigEditor 自身也是 Loader entry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/bundle/base/cordis.patch.yml#L105)；它卸载时，[Cordis 4.1 会等待依赖它的任务退出](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/vendor/cordis/src/fiber.ts#L712)，任务却可能在 edit 的 reconcile 中等待该 provider fiber。换到 root 不能消除这条环。

### 上游建议

由 ConfigEditor 与 app-boot/Loader 的协调 owner 提供显式事务 receipt，把“接纳并负责完成配置事务”与“等待所影响插件激活”分开。操作 owner 必须能跨目标 entry 重装存活，并在 ConfigEditor provider 或 Host 关闭时协调事务阶段；不能仅把 Promise 放进另一个依赖该 provider 的插件。

接口至少需要明确这些事实：

1. **接纳前**：校验 profile、目标 entry 身份和预期配置版本；change mapper 仍由官方锁、schema 和 overlay 规则约束。取消或 owner 撤销后不得再接纳新变更。
2. **已接纳**：返回操作身份和可查询的 receipt。原生 owner 负责锁、原子写入及必要回滚，不再依赖发起插件继续存活；取消不能伪装成“写入没有发生”。
3. **持久化与激活分别可观察**：区分尚未写入、已写入待激活、最终应用成功、已回滚与结果未知。若激活失败仍可触发回滚，“文件已写入”不是导入成功，不能此时写成功标记。
4. **卸载与关闭**：提供专门的协调阶段，停止新事务、取消尚未提交的事务，并在影响其执行的 Loader 资源撤销前完成或安全终止已接纳的持久化工作。目标插件的 cleanup 不能等待包含自身 fiber 的激活 barrier；provider 的 cleanup 同样不能与依赖它的 receipt waiter 互相等待。最终激活结果由独立操作 owner 保留，重装后的消费者可重新观察。

现有 `edit` 可保留为需要等待完整激活的便捷接口；自修改插件使用新的事务入口。仅增加 `AbortSignal`、提前 resolve 一个没有 owner 的 Promise，或把“写入成功”当作最终成功，都不足以建立上述保证。具体协调阶段应由上游实现并证明退出顺序，适配器不能绕过 ConfigEditor 自己写 profile YAML。

### 适配器配套

插件本代结束时停止新导入；已接纳操作交给原生 owner，按 receipt 跟踪真正终态。只有最终应用成功才写幂等标记；标记写入也由明确、可等待的任务 owner 收尾。新插件代次应复用仍在进行的同一导入，不能与旧代同时重做编辑。

继续保留旧文件、显式 `agents` 优先和不记录敏感配置的行为。失败、回滚或未知结果不能写成功标记；重试必须重新检查现有 profile。不能通过删除自动导入、吞错、延时或复制原生配置写入流程来关闭这项旧债。

### 验收与风险

- 导入引发 ACP entry 重装时，无自身等待，只有一个受跟踪事务；新代次看到已生效配置且不会重复导入。
- 分别在接纳前、原子写入后、激活等待中停用 ConfigEditor provider 或退出 Host：退出完成，操作终态可信，无卸载后访问已撤销服务。
- 校验失败、overlay 冲突、写入失败、激活失败和回滚失败分别保留真实结果；未知结果不写成功标记。
- 旧代次导入与新配置编辑并发、标记写入失败及重启重试均不覆盖用户显式配置，不泄漏源配置或凭据。

目前的隔离证据使用真实 Cordis 4.1/Loader 1.1，加上与原生两处等待对应的可控 reconcile facade，展示了 provider 与 dependent 均处于卸载中的一种等待环。它用于否定简单 `root.inject` 修复，不是完整 ConfigEditor/Host 端到端验证；测试的解锁逻辑仅供 fixture 收尾，不是可发布方案。本轮没有修复这项旧债。

## 实施与证据边界

五项分析分别保留，当前只实施可由插件公开接口可靠承担的部分。不会为保留功能而改写上游私有方法、伪造容量或工具日志；不能保证的能力明确放弃完整兼容声明。

现有单测覆盖分叉来源缺失、exact-cut 不匹配、种子不匹配、权限检查、未知创建结果和重试不重复创建。本次补充 Sidecar 重开后的缺来源拒绝，观察零 `start/fork/prompt` 调用；这只是安全边界回归，不是 RC.1 标题、侧栏和快捷键的端到端认证。真实入口、热启停和桌面行为的结果由[总评估](dsh-0.2.2-rc.1.md)记录。
