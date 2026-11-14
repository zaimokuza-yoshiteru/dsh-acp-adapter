# DSH 0.2.2-rc.2 升级评估

评估日期：2026-11-13。插件基线为 `0.2.2-alpha` 的 `328ef39fcd0ea8a6560d538c4e2757d29b779f98`，已发布版本 `0.2.2-rc.1.2`，该基线声明的宿主为 RC.1。第 1–8 节保留实施前评估；获授权后的 RC.2 迁移和首次验收见第 9 节，后续真实 Devin Teams 补验见第 10 节，旧节中的“本轮”均指评估阶段。上游和原 RC.1 试用实例保持不变，未发布。

**RC.2 的代码迁移与确定性回归已完成；后续真实 Devin 共享任务、成员消息、ACP 审批和待审批取消/续接均通过，分项边界见第 9、10 节。** 以下保留实施前的迁移判断：不能只升依赖。 最大变化是具名、多层子代理与按会话启用 Teams；可同步删除旧团队成员补丁、重复归属遍历和第二套团队弹层。ACP 连续性、审批、补存与首次绑定静默仍由插件负责。已有会话切模压缩、原生分叉的完整能力预检并未被 RC.2 解决。

## 1. Devin 真实测试的准确状态

**本次 RC.1.2 发行没有执行真实 Devin 模型对话，不能标记为已通过。** 普通 CI 的协议测试和无凭证 CLI 发现不等同于真实对话。

| 时间与基线                                         | 实际证据                                                                                                                          | 可以得出的结论                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-11-13，RC.1 生产复核                          | [RC.1 评估记录](dsh-0.2.2-rc.1.md)明确记录真实 Codex `1.6.2` / `gpt-5.6-luna` 两轮与刷新通过，并写明没有调用 Devin                | 当前真实模型证据只覆盖所记录的 Codex 场景                                      |
| 本次普通 CI                                        | Devin `3000.10.31` 无凭证 MCP 配置发现，见 [脚本](../../scripts/check-devin-mcp.ts)及 [CI](../../.github/workflows/ci.yml)        | 证明 CLI 配置发现路径，不证明对话、工具调用或 Teams                            |
| 2026-10-21，DSH `0.2.1-rc.2` / 插件 `0.2.1-rc.2.4` | Devin `3000.11.92`、`3000.3.27` 各一次 `swe-2-high` Teams B–D，首轮 `session/prompt` 均返回 `-32013 Permission denied / error 12` | 未验收；没有模型、工具、审批或成员输出。不能据此单独归因于插件、账号或模型权限 |
| 2026-10-18，插件 `v0.2.1-rc.2.2`                   | Devin `3000.3.27` / `swe-2-high`，Windows/macOS 真实 AgentLoop/Teams 工具与消息通过；没有浏览器 receipt 验证                      | 属于旧版的有限历史通过，不能覆盖当前版本，也不能抵消后来的失败                 |

较新失败原始证据在 `.local/native-agent-fix/validation.json` 的 `id: real-cli` 记录；历史跨平台证据在 `.local/fix-37000fb/devin-live-39101252210/verification.json`。更早的 SWE-1.7 发布验证保留在 [回归记录](../../test/e2e/REGRESSION.md)，本轮不将其改写为当前结果。

RC.2 实施后，真实 Devin 应独立验收：先记录确切 CLI、可用模型及首轮准入，再检查两轮/恢复、真实 DSH 工具、具名多层 Teams、审批与取消。如果首轮仍拒绝，应报告未到达的场景；不能反复换模型或用历史通过记录代替。本轮没有调用真实 Agent 或消耗模型额度。

## 2. 基线、官方规范与实际验证

- 官方 RC.1：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- 官方 [RC.2 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)：`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。
- 已抓取标签并创建 `.local/upgrade-rc2/upstream` 分离工作树；原 `reference/deepseek-harness` 保持 RC.1，其预先存在的 `.claude/skills` 删除状态未处理。运行中的 RC.1 试用实例未变。
- 按插件 `adapter-review`、`adapter-validation`，以及官方 RC.2 `dsh-code-review`、`dsh-error-handling`、`dsh-find-simplifications`、`dsh-client-ui-ux`、`dsh-responsive-ui`、Cordis 规范与 defensive patterns 追踪生产者、消费者和公开包导出。
- 官方升级指南有些放在较早的版本目录，不能只读 `v0.2.2-rc.1` 目录；有些指南描述中间接口，例如 `agent_id`，须以 RC.2 最终源码的 `agent` 为准。

隔离 npm 探针最终位于 `/private/tmp/dsh-acp-rc2-assessment-328ef39`，与主项目 `node_modules` 无祖先关系，避免已删除的旧包从 RC.1 环境回退解析。仅修改探针 manifest/lockfile，生产源码保持基线。

| 检查                                           | 结果与边界                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方发布依赖安装                               | `pnpm install --ignore-scripts` 成功；Node `24.19.0` / pnpm `10.7.0`。保留 ACP SDK 等自有依赖，DSH 依赖/peers/engine 对齐精确 RC.2；manifest 中旧 Team 包改为新包，源码仍使用旧接口     |
| 开发依赖核验                                   | `verify-dev-dependencies.ts` 核验 114 项精确发布依赖通过                                                                                                                                |
| 首次 `pnpm typecheck`                          | 在 Typert 生成阶段失败：发布 `files` 缺少 `lib/typert.remote-client.d.ts.map`                                                                                                           |
| 探针补齐该文件清单后                           | Typert 生成 5 个产物成功；生产源码出现 143 条类型诊断，包括 Zod `4.4.3` 与 RC.2 `4.6.6` 的类型不兼容                                                                                    |
| 探针将 Zod 对齐 `4.6.6` 后                     | 7 条相关诊断消失；生产源码仍有 136 条诊断，分布于 16 个文件，其中 104 条来自自定义 ACP 错误码构造方式。其余集中在 Team/归属/中断与 UI API 迁移，含连带类型错误；不是 136 个独立产品缺陷 |
| 单测、打包、Host、浏览器、独立桌面、真实 Agent | 本轮未执行；生产类型检查失败后不会到达脚本中的测试/工具类型检查。不能宣称 RC.2 已可运行或通过验收                                                                                       |

原始日志、manifest 补丁、机器可读汇总及专项审查保存在 `.local/upgrade-rc2/`。本轮得到的是发布依赖和源码契约层面的迁移依据。

## 3. 必须兼容

### 发布契约与错误边界

1. 正式更新精确 DSH peers/devDependencies、`engines.dsh`、锁文件、参考版本与 CI 输入。`@deepseek-ai/dsh-experimental-agent-team` 已不存在，替换为 `@deepseek-ai/dsh-agent-team`；不要留下旧包兼容层。
2. 将 Zod 对齐官方 `4.6.6`。插件投影 schema 直接进入宿主公共类型边界，继续保留 `4.4.3` 已实测无法通过类型检查。
3. 将已生成的 `typert.remote-client.d.ts.map` 纳入发布清单和产物验证；核对安装包中的声明映射目标。官方要求位于 `packages/typert/generator/src/workspace.ts:151`。现有生成脚本已经写出该文件，不需另造生成器。
4. 使用公开 `LlmError.fromFailure({ message, code, ...facts }, { cause })` 承载 `ACP_*` 自定义错误；构造器现在只接受宿主内建码。官方定义：`packages/llm/llm/src/index.ts:142`；[迁移指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/docs/upgrade-guide/v0.2.2-alpha.2/llm-error-builtin-codes/guide.md)。

错误迁移必须保留原码、`LlmError` 实例身份、完整 `.failure` 和 cause。不要通过强转消除诊断，也不要统一改成 `TIMEOUT/TRANSPORT`，否则可能改变默认重试并重发结果未知的操作。`src/remote/service.ts:143` 的切模应用内出口依赖原类型与错误码；`AcpClientError` 到宿主错误的包装也须保留。回归应覆盖真实错误传播链、恢复出口和禁止重复派发，不能只测试工厂本身。

### 子代理、Teams、审批和协作工具

官方 TeamService 已不再拥有成员注册表，`tryMembership/listMembers` 被删除；AgentRegistry 的 `roots/isOwnedBy` 和创建参数 `parentAgent` 也被移除。替代边界是 `subagents.rootOf/namesOf/resolveName/listDescendants`，定义于 `packages/subagent/subagent/src/index.ts:300` 起。

插件受影响的主要消费者为 `src/host/subagent/approval-children.ts`、`tool-approval-policy.ts`、`src/host/composition/external-agent-questions.ts` 和 `src/host/teams/`。建议集中成一个窄的子代理关系读取模块，直接读取宿主事实，删除重复的父链遍历。必须区分：

- 实际运行时根与最初创建者；冷恢复的叶子不要求中间创建者仍驻留。
- 具名路径与授权；名字、目录记录和持久化 parent 字段都不能替代活实例与资源权限检查。
- Team 开关与子代理生命周期；关闭 Team 不等于删除已有子代理，更不等于取消已接纳审批。
- 普通会话分叉与受管子代理；普通分叉是独立根。

审批策略迁移建议保留既有持久化选择；新受管后代以明确的树级继承规则处理，Team 开关控制任务工具和 Team 指导上下文，不隐式改写 ACP Auto/Ask。多范围授权继续回复原始 ACP 请求，不能缩成一次批准。

工具消费者要同步迁移：

- `spawn_teammate` 已删除，使用当前实际开放的 `subagent/subagent_fork` 等工具；fresh-only 校验针对真实目标能力，不再保留旧工具分支。
- `send_message` 最终参数为 `{ agent, message }`；`src/host/tools/bridge.ts:1103,1336` 仍读取 `args.target`，审批展示、结果跟踪、诊断及 `scripts/check-devin-live.ts` 必须一起更新。
- `list_agents` 返回具名路径、状态、描述；不能继续按旧 roster 的模型字段改写结果。
- `interruptByParent` Remote 已删除，不能机械改名后保留旧授权假设。优先复用原生用户控制入口；确有 ACP 附加需要时接公开 `interruptByUser` 并核验实际资源权限。该回执只表示取消信号已接纳，不证明目标已停止或补存完成。内建预设默认关闭模型侧 `interrupt_agent`，不要为了旧测试强制打开。

### Client API 与入口

- `src/client/ui/AcpTeamManagement.ts:11` 使用的 `useAnchoredPosition` 已删除。
- `src/client/ui/AgentSessionMenu.ts:121` 的 `getAnchorRect` 改用 `anchorRef/anchorPoint`。
- `native-team-ui-lifecycle.ts:15` 查找的 header `agent-team` 入口已迁移；继续沿用旧检测会静默丢失 ACP 管理入口。
- 新入口为原生 `subagent-catalog`；TeamBoard 贡献在公开 `conversation.session.header.actions.subagent.footer`。不能只换一个旧 ID 就认为 UI 迁移完成。

## 4. 可以顺手删掉的技术债

| 当前维护内容                                                    | RC.2 方案                                                         | 必须保留的能力                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `src/host/teams/member-model-tools.ts` 对原生名单模型字段的补写 | 移除该模块及接线；新 `list_agents` 不再返回旧模型字段             | ACP 成员模型/模式控件、未提交选择、实际写入校验     |
| Team roster 与多处父链遍历                                      | 使用原生具名子代理树，集中读取与权限核验                          | 精确实例校验、await 前后复核、跨会话授权            |
| `spawn_teammate` 专用 schema、旧参数诊断与夹具                  | 按真实 `subagent`、`subagent_fork`、`send_message` 契约迁移后删除 | fork 能力预检、已准入工具目录、真实副作用与回执追踪 |
| 第二个团队入口、独立 portal/定位/关闭/焦点管理                  | 将 ACP 附加控制接入原生 `subagent.footer`，复用成员树和任务板     | ACP 专属 mode、模型、审批及忙时限制                 |

原生 footer 目前只提供 session 级扩展，没有成员行 actions 扩展。可在 footer 提供紧凑 ACP 操作；若嵌套菜单焦点难以可靠配合，则用一个原生 Modal 承载附加操作。不要复制宿主私有成员组件，也不要声称新任务板已经覆盖全部 ACP 控制。

这轮不建议同时重写 `AcpProfileAdapter` 派发/恢复顺序、调整全部模型路由或新增模式。先消除旧 Team 契约，现有 Agent 差异模块、会话控件与工具目录 owner 可以继续使用；Kimi 仍保持退役。

## 5. 官方 ACP 主类与 MCP manager 能否替代我们

**没有找到可直接替换完整交互式客户端的公共 `AcpTools` 主类。** 名字相近不代表职责相同：

- `dsh-acp` 是 ACP **服务端**，供外部程序驱动 DSH。`AcpSession` 是其内部实现，包入口没有导出它；复用它会把协议方向弄反。
- `dsh-subagent-acp` 是新进程、新 ACP session 的一次性子任务后端，权限策略只有 allow/reject，启动请求使用空 `mcpServers`。它不是带交互审批、宿主工具桥、续接与恢复的会话客户端。
- 新 `dsh-mcp-manager` 管理 DSH 连接外部 MCP server，将其工具引入 DSH；我们的 MCP bridge 向外部 ACP Agent 提供当前 DSH 已准入的工具，方向相反。不能用 manager 替换它，也不应把当前会话工具注册成全局 MCP 服务。

真正应复用的是公共工具执行流水线、Session/投影、子代理树、原生 UI 和结构化错误。已有 ACP 绑定、Sidecar、进程结束确认、Host feedback、审批有效期与最终补存顺序仍须保留；不能因宿主取消/销毁逻辑增强而删除这些外部协议责任。

`ctx.subprocess`、`tools.execute`、公开 `dsh-tools/pipeline` 与 `dsh-timeout` 已在实质使用。后续可小范围减少手写进程契约类型，并识别官方新增的结构化进程错误；不要为“复用”重新搬一套实现。尤其不能把任意带 errno 的后期进程错误都归为启动失败并触发 shell 重试。官方内部 `disposeAcpChild` 的退出等待，以及子任务 `settleRunResult` 的本地取消语义，也不等价于插件的受限等待和远端结果未知恢复。

## 6. UI/UX、创造模式和首次加载

**创造模式仍可与 ACP 共用。** 本次未发现生产源码硬编码旧技能名；活跃旧名在 `test/e2e/creator-flow.e2e.ts:152`，需迁为 `dsh-doc`，按需读取 `references/plugin-development.md`。继续验证原生创造入口、技能读取、插件安装引起的目录变化、后续请求、停启和恢复。标准、创造及可选 ACP 预设不互斥，不迁移旧会话或覆盖默认。

RC.2 仍可能在正常历史打开期间显示加载状态。现有 `activity-binding-pending` 的首次静默和健康状态下隐藏恢复栏必须保留；同时保留真正读失败的错误与重试。不能以“首次都隐藏”为修复，掩盖真实异常。

新增回归关注：历史自动分页与 ACP Sidecar 合流不重复、滚动位置不跳；原生 Markdown fence 扩展在 ACP 投影中注册/卸载/失败回退；插件共存时不抢原生模型标签与渲染入口。

新 hoc 槽不是通用包装 API：当前 conversation view/flow/node 槽类型未统一改变，`native-tool-renderer` 的必要挂载桥与 DOM `data-slot` 修复暂无等价公开替代，暂不删除。

中英文与 390px 要检查团队面板、模型/模式菜单、设置、恢复和插件详情的主要操作、长名称、焦点与触屏。保留已精简的用户详情页；兼容矩阵、测试统计与技术限制放在工程文档，不重新加入日常页面。原生单一模型 label 槽仍不足以安全处理 `Agent current configuration` 的全局本地化，不能覆盖其他插件来解决这一条文案。

此前 390px 桌面顶部固定控件与内容重叠，RC.2 有相关布局改动，但源码不足以证明已修复；仍需独立桌面同路径实测，不通过插件全局 CSS 改宿主布局。

## 7. 仍不能解除的限制及数据边界

1. **已有会话切模压缩。** `packages/compaction/compaction-basic/src/index.ts:183` 的切模检查与 `:326` 的 context capacity 要求在 RC.1→RC.2 未改变。继续保留应用内“保留当前模型 / 创建独立新会话”出口、草稿和历史保护；不伪造容量、不吞错误、不承诺新会话延续旧上下文。
2. **原生普通分叉入口。** `packages/api/session-controller/src/commands.ts:230` 仍无 ACP 创建前目标能力扩展点。保留能力与来源校验；支持的 ACP 分叉继续使用现有 coordinator，不支持的路径不能退化为空白会话并宣称成功。
3. **Auto Review 等辅助模型调用。** 此次未发现能给辅助调用补齐 ACP 会话准入身份的通用新接口，不能扩大支持声明。
4. **Session.append。** 新增数组重载，旧单事件调用兼容；`session-facts.ts:119` 是插件窄 facade，无须机械改成批量接口。不过批次整体提交后才逐事件通知，监听器读到的是批次最终 seq/surface，须覆盖实际 Host 行为。
5. **数据回退。** Session 日志框架未因此更换，但 RC.2 的具名子代理目录 v3、`team/mode` 等新事实不能假定 RC.1 可读。升级验证使用复制的数据和独立 profile；回退应连同数据快照，不让 RC.1 直接打开被 RC.2 改写的存储。插件外部子任务的旧 v0 目录仍被 RC.2 接受，无须伪造新名字或将只读投影升级成可续接子代理。

## 8. 建议实施顺序与准入条件

1. **先闭合发布与基础类型。** 精确依赖、Zod、Typert files、错误工厂、Team 包与公开接口；保留原 ACP 错误语义和重试策略，不维持 RC.1/RC.2 双版本分支。
2. **再迁移运行时事实与删债。** 具名树、冷恢复、审批继承、Team 开关、工具参数、Remote 控制及 live 脚本；删除旧模型补写和旧工具分支。
3. **接原生 UI 与创造流程。** ACP 控制移入原生子代理面板；迁菜单 API 和 `dsh-doc` 测试；保留首次会话、恢复与简洁双语页面。
4. **完成新版本独立验收后再决定发布。** 本轮没有发布或修改支持声明。

最低验收矩阵：

| 范围           | 必须观察到的结果                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| 构建/安装      | 精确 npm 依赖、生产/测试/工具类型、构建与安装包闭包、Remote 声明消费通过                                |
| 树与权限       | 同名不同树隔离、多层子代理、中间创建者离线后冷恢复、实例替换、native↔ACP 混合根；原审批与回答目标不串线 |
| Teams 开关     | 默认关闭、开启、执行中关闭、保存后重启、再开启；既有任务/子代理/已准入审批语义正确，无幽灵工具或入口    |
| 工具/错误      | 新工具名参数及名单；原 ACP 错误码/cause/重试行为；未知结果和远端成功待补存不重发                        |
| 生命周期/存储  | 批次 append 的 seq/surface、持久化失败、retained feedback、取消并发、关闭等待最终依赖、进程退出失败可见 |
| 独立 RC.2 桌面 | 与 DS Bot 共存、单 entry 与 bundle 停启、首次会话无错误重连提示、真实读取错误可重试、恢复与支持的 fork  |
| UI/创造        | 中英文、390 CSS px、明暗与非默认主题、键盘/触控；原生创造→dsh-doc→安装→目录变化→后续请求→热启停→恢复    |
| 真实模型       | 记录 CLI/模型/环境和具体场景；Codex 与 Devin 分开出结论，未跑、首轮拒绝和历史通过不得合并记为通过       |

在这些条件满足前，继续把 `0.2.2-rc.1.2` 视为 RC.1 插件。本评估提供可实施迁移方案，不构成 RC.2 生产认证。

## 9. RC.2 实施与验收（2026-11-13）

分支 `0.2.2-alpha`；候选包 `0.2.2-rc.2.1`，宿主精确锁定 `0.2.2-rc.2`，尚未发布。原已发布 RC.1 安装链接保留，不把未发布的候选地址提供给普通用户。

### 实际迁移与保留边界

- 移除旧实验性 Team 包与成员模型补写模块。归属统一读取原生 subagent root、目录和具名路径；目录名称不充当授权。关闭 Team mode 不撤销已有子代理和审批。
- 原生子代理目录负责导航，ACP 控制放入其 footer 打开的原生 Modal；删除第二套入口、定位和浮层框架。修复第一次 Escape 被后台目录截走的问题；前台菜单仍优先关闭，并保留输入法保护。删除无生产来源的 provisioning/failed 成员状态、展示分支、双语词条与内部类型导出。模型、模式与审批有效性仍由各自 owner 检查。
- ACP 错误迁为公开 `LlmError.fromFailure`，保留分类、cause、provider facts 和禁止重放的重试策略。打包增加官方要求的公开 Typert 声明映射（含源内容），其余声明映射仍不进入包。
- 复核修正 Cordis traced proxy 的身份比较，核查真实底层服务与精确 Agent 实例。成员目录和成员操作需要 root、目录祖先与目标资源权限；异步审批目录返回前再次核查 root 权限。模型意图写入后重查 Agent、Session、序号与原生选择，避免应用到同 ID 的替代实例。
- RC.2 新增的 `working-directory/access` 可以复用，最初“上游没有服务级 hook”的判断已由实际发布实现更正。插件用它统一保护直接调用和原生工作目录工具，保留 `create_worktree` 在 Git 副作用之前的 guard。首次未绑定设置、正常 ensure 和物理同目录访问放行；不支持的实际变化及 idle 已绑定会话变化在提交前拒绝。它不提供与并发文件系统删除的原子事务，也不扩大 Forge 的完整交接声明。具体剩余窗口是 guard 检查后、原生 ensure 再次检查前当前目录被删除或路径目标改变，原生仍可能回退原目录；下次 ACP 请求由 binding/canonicalCwd 不一致保护阻止静默复用。公开 hook 没有 commit 前验证或已解析路径传参，插件不复制原生提交逻辑。
- Devin MCP 注册失败使用官方 `HarnessError`，区分超时、取消、启动、退出、I/O 与超量输出，用户只见简短说明；安全数值留在 cause，不保存 CLI 文本、argv、env 或任意第三方 cause。仍为 10 秒且不自动重试；真实 Teams 测试遇到本次树的错误 turn/end 立即失败，正常 completed 后仍等待消息续轮。相关 20 项单测和源码/测试类型通过，见 `devin-registration-validation.json`。
- 创造流程使用官方 `dsh-doc`，再通过 DSH `read` 加载其 `references/plugin-development.md`；没有将技能复制到 Agent 私有目录。Kimi 仍不受支持，旧会话和用户默认未迁移。

### 输入与验证记录

本轮使用 Node `24.19.0`、pnpm `10.7.0`、117 项精确发布的开发依赖。隔离 RC.2 scaffold 的 `pnpm run build:artifacts` 8 项产物门禁通过；它不是上游全量测试。原 `reference/deepseek-harness` 保持 RC.1 与预先存在的 `.claude/skills` 删除状态；隔离 RC.2 worktree 没有源码修改。

验收日志存放于 `.local/upgrade-rc2/`；失败尝试保留，不能用后续通过覆盖失败的原始记录。

| 范围                            | 当前结果与边界                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建与安装包                    | 最终 `build-8.log` 通过，含 325 个 tarball 文件、130 个运行时 JS 闭包、CSS 管线、模块请求与公开 Remote 声明消费                                                                                                                                                                                                   |
| 类型                            | `typecheck-final.log`、`typecheck-e2e-final.log` 通过；脚本入口调整的 tools 类型与 61 项相关用例见 `devin-script-validation.json`。最后 test-only 人工授权与版本取证调整的 test/E2E 类型检查均通过，见 `devin-manual-{test-types,e2e-types}.log` 与 `devin-cli-version-{test-types,e2e-types}.log`                |
| 单元与集成                      | 完整 `unit-5.log`：227 文件通过、1 文件跳过；2857 项通过、3 项跳过。此后仅测试夹具调整，人工授权受影响 5 文件 73 项通过（`devin-manual-unit.log`）；最后版本取证相关 3 文件 41 项通过（`devin-cli-version-unit.log`，其中新版本读取 12 项）。`unit-3.log` 是沙盒禁止本机 listen 的 EPERM 失败，不属于产品通过证据 |
| 树与权限、保存竞态、批次 append | `runtime-review-final.log`：6 文件、86 项通过；真实 Session 批次首回调可见最终 seq/surface/closed-step，不按旧中间状态接纳工具                                                                                                                                                                                    |
| 原生团队、首次会话、创造与窄屏  | `e2e-core-2.log` 25 项中 20 通过；`e2e-core-3.log` 对修正后的 16 项有 15 项通过，剩余首次 Escape 真实缺陷已修并在最后一组通过。原始失败均保留                                                                                                                                                                     |
| 最终原生集成回归                | `e2e-final-1.log` 17 文件 41 项：30 通过、11 个旧契约断言失败；五个受修正影响文件在 `e2e-final-2.log` 的 20 项全部通过。覆盖准确活跃实例/退驻目录、父级完整审批、Codex 延迟等待、工作目录、可选工具、调度、目录刷新、首次/恢复、停启、原生控件和触控布局                                                          |
| 预设与首轮控件                  | `e2e-presets-controls.log`：2 文件 11 项通过；可选 ACP 预设保留标准/创造组合及默认值，Devin/Codex/Claude/CodeBuddy 的首轮与延迟控件正常                                                                                                                                                                           |
| 原生目录 UI 诊断                | 严格诊断真实复现关闭 Modal 后焦点落 BODY，未返回目录按钮；Tab 可达可用控件，无焦点陷阱。空 footer 对照无差异。见下节                                                                                                                                                                                              |
| 独立完整桌面                    | `desktop/rc2-lifecycle-result.json` 4 组通过：DS Bot 0.2.2 共存、双方停启、运行中停止 ACP 后重新启用、首次延迟绑定无错误重连提示；`desktop/creator-ui-result.json` 12 组通过（8 轮创造与恢复、双语×明暗 390 CSS px），两组 renderer errors 均为空                                                                 |
| Devin 两轮与恢复                | **通过**：CLI `3000.12.43 (517d03d73926)`、精确模型 `swe-2-high`，当前 `devin models list --format json` 标为 Free；第二轮宿主指令更新与两轮刷新恢复通过，见 `devin-smoke-result.json` / `devin-smoke-1.log`                                                                                                      |
| Devin 团队专项                  | **未通过，不作生产认证**。最后 `devin-browser-teams-5.log` / `browser-teams-5-devin.json` 在批准前被测试身份校验拦截，0 授权、0 Host 工具派发、无成员；具体原因及各次失败见下文。普通对话通过不能覆盖此项                                                                                                         |
| Devin 零推理工具目录            | `devin-catalog-preflight-2.log` 通过：28 原生工具与实际隔离 MCP launcher 的 28 工具一致，新 subagent/send_message schema 一致；未启动带认证的 ACP 模型进程，也不证明模型实际调用工具                                                                                                                              |

独立桌面使用 build6 冻结包；其后 build7 仅删除无生产来源的成员状态展示及内部导出，build8 增加 Devin 注册失败的安全分类。本节使用 Codex 协议夹具的桌面流程不受影响，成员交互另由最终浏览器回归覆盖。原始失败脚本保留：一次中文按钮名称多了“的”，一次把宿主“中文”写成“简体中文”；修正定位器后只补未完成场景，不改产品来迎合测试。390px 是 Electron 页面 CSS 视口，原生窗口最小宽度仍为 520px；未验证 Windows 桌面或发行安装包。原 RC.1 试用实例未变，新 RC.2 验收实例在完成后关闭。

Devin 使用临时认证副本、HOME/XDG/profile/workspace，MCP 注册也发生在临时目录，关闭后删除；不复制原配置或历史。免费判断来自本次目录，不把模型名称或历史价格当永久免费承诺。headless 团队脚本的 16 次 Host 工具／4 分钟限制是测试预算，不是模型费用或生产限制。浏览器团队验收独立限定两个计算/审核任务、一个子代理与一次回信，最多 24 次原始一次授权、32 次 Host 调用和 24 次任务操作；不批准会话、永久、整台 MCP server 或 bypass 权限。

当前 CLI 的已观察请求不含 structured metadata，因此人工 UI 流程不能沿用生产 Auto 的身份前提。测试专用分支核查独立 CLI 版本 `3000.12.43`（ACP 握手版本另记，不等同于 CLI 版本）、隔离配置中唯一且属于本次实例的 dsh launcher、完整七项原始选项、当前工具标题、原文哈希、活跃 owner/tree/task 范围与实际 Host guard，再在原生界面选择 `allow_once`。完整参数取自同一原生问题的详情并核对原始哈希，不能把已脱敏审计摘要当完整输入。未知版本、外部 server、缺失/歧义选项或越界任务仍拒绝；这没有扩大生产 Auto 信任。最终专项单测包含保存的实际协议样本及上述反例。

### Devin Teams 未完成的真实验收

以下均保留原始失败，没有用后来修正的夹具改写结果：

1. `devin-teams-1.log`：headless 112 秒、两次主会话真实请求，0 DSH 工具派发、无子代理，等待成员 90 秒超时。
2. `devin-browser-teams-1.log`：模型请求前 MCP get 失败，错误事件距请求约 10 秒。零推理复核相同环境 get/add/get 分别 873/1681/1549ms 成功，不能断言认证或固定权限错误。
3. `devin-browser-teams-2.log`：模型已发现 DSH 工具，但旧夹具未回答 Devin 原生七选项授权，无工具派发。
4. `devin-browser-teams-3.log`：新增严格一次审批后仍在批准前失败，旧等待器以先前断言覆盖回调错误，且审计摘要脱敏影响完整输入核对。已离线修复错误保留和同一 native detail 的原文哈希核验；该轮缺少阶段记录，不能断言唯一根因。
5. `devin-browser-teams-4.log`：证实当前 CLI 使用 `devin-title`，没有 structured metadata；纯人工一次批准测试不应照搬 Auto 的元数据前提。已加入严格限于已知 CLI、隔离实例和原始七选项的 test-only 分支，生产 Auto 不变。
6. `devin-browser-teams-5.log`：最终一次真实尝试耗时 49.12 秒，模型请求 `team_task_create`，但 ACP `agentInfo.version` 实际为 `0.0.0-dev`，并非已安装 CLI `3000.12.43`。夹具错误地把握手版本当作 CLI 包版本，触发 `LIVE_TEAM_MANUAL_PERMISSION_IDENTITY_UNPROVEN`，在批准与副作用前退出。该失败属于测试取证错误，不是产品功能失败证据；同样不能算 Teams 通过。后续已修复独立 CLI 版本取证，固定同一绝对可执行路径供 `--version` 与 ACP 使用，分别记录 CLI/ACP 版本；离线回归通过。空白临时 HOME/XDG 下使用最终 helper 实际读取 `--version` 得到 `3000.12.43`，无认证、无 Host、零模型请求，见 `devin-cli-version-actual.json`。修复后没有重跑 Teams，本轮不再消耗模型调用。

本轮没有真实 Devin 子代理、共享任务完成、成员回信和成员审批通过证据；真实取消、跨模型 Teams 也不在通过范围。下一次专项验证应先离线确认当前 CLI 版本取证与隔离注册，再以明确模型和任务预算执行，不重复模型调用来寻找偶然通过。此项保留为发布前验收缺口，当前只提交候选，不发布。

### 原生 UI 返回焦点：插件侧暂不增加替代实现

`product-controls.e2e.ts` 在 `DSH_E2E_NATIVE_CATALOG_DIAGNOSTICS=1` 下完成全部观察后严格失败，严格失败日志为 `e2e-native-ui-diagnostic.log`；各次观察输出为 `.local/e2e-evidence/native-catalog/contracts.json`。Close 与 Escape 均落到 BODY；下一次 Tab 可到可用控件。普通回归验证菜单 Escape、Modal 焦点循环、退出后没有残留遮罩和键盘可用性，同时保留观察结果；不把 BODY 视为理想返回位置。

原因是原生目录在 Modal 操作时卸载 footer 触发按钮，而公开 Modal 仅能尝试返回原先的 DOM 节点；footer 没有 triggerRef/dismiss，Modal 没有返回焦点回退参数。可落地的上游方案是给 Modal 增加公开的返回目标回调，并由 subagent footer 提供稳定目录触发器。插件不修改上游，不使用私有 DOM 定位、模拟 Escape 或复制原生焦点管理。强行聚焦 composer 会改变用户位置并可能弹出触屏键盘，因此不采用。这是保留的 UI 限制，不是已修复项。

## 10. 真实 Devin Teams 补验（基线 141760b）

用户再次明确授权后，继续使用同一 RC.2 生产构建、独立 Host/profile/workspace 和临时认证副本；没有修改上游。新证据位于 `.local/devin-teams-rc2/`，上一轮失败原样保留。当前 CLI 仍为 `3000.12.43`，ACP 握手版本为 `0.0.0-dev`；独立 CLI 版本和隔离注册取证均通过。实际 `models list --format json` 目录将精确 `swe-2-high` 标为 `Free`，没有改用其他模型。

### 共享任务、成员消息与一次授权：通过

`shared-1.log`：1 项真实浏览器测试通过，93.15 秒；结果、模型目录与截图保存在 `shared-1/`。真实 Devin Lead 创建两个共享任务和一个名为 calculator 的真实 Devin 子代理：子代理领取并完成 Compute，发送一次带本次 token 和计算结果的消息；Lead 收到并持久化该 relay 后领取、完成依赖的 Review，再生成最终回复。两个任务均为 completed、revision 3，owner 分别是 calculator 与 lead。

11 次原始 `allow_once` 审批对应 11 次成功 Host 工具执行：两次创建任务、一次 subagent、两次获取任务、四次更新任务、一次 send_message 和一次任务列表。原始七选项在 native UI 完整展示，子会话请求转呈到 Lead；每项 owner、request、原文哈希和一次授权决定与结果关联，0 范围违规，没有改为会话授权或 bypass。截图确认原生子代理目录显示一个完成成员、两个完成共享任务和单一 ACP 成员设置入口。

共享任务通过不代表审批拒绝、主动取消或所有原生 sandbox escalation 均通过；这些边界单独验证。

### 审批拒绝与取消专项

`permissions-1.log`：1 项真实浏览器测试通过，88.85 秒；结果、目录、分阶段截图和脱敏 trace 保存在 `permissions-1/`。专项使用 `DSH_E2E_LIVE_DEVIN_PERMISSIONS=1`，避免重复已通过的共享任务。它沿用同一精确 CLI、模型与隔离环境，显式设置 ACP Ask；测试经公开 `startActivation` 创建一个真实 Devin 子会话，创建动作由夹具控制，不能把此项计作模型自主创建成员。模型自主创建已由上一项覆盖。

| 阶段       | 真实观察                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allow      | 在原生界面选择原始 `allow_once`，决定前无文件；仅 1 次 Host write 成功，内容精确匹配本阶段 marker，DSH turn completed                                                                 |
| Reject     | 在原生界面选择原始 `reject_once`，0 Host 派发、文件不存在；Agent 正常结束该轮，没有替代工具或重试写入                                                                                 |
| Stop       | 打开原生子会话侧栏，点击 Stop，经 `subagents.interruptByUser` 取消；原始权限请求 outcome=cancelled 且无 optionId，DSH turn=aborted，ACP stopReason=cancelled；0 Host 派发、文件不存在 |
| 继续与刷新 | 在同一子会话输入无工具续聊，真实 ACP prompt 的 session ID 与原请求相同，返回 end_turn 和新回复；被拒绝/取消的文件仍不存在，旧请求没有再出现，页面刷新后仍无旧审批                     |

三个请求均保留完整七选项与原文哈希；决定前重新验证 owner、root、请求与取消信号，实际工具执行还要匹配本阶段唯一请求和参数。同一执行的重复准入检查幂等，第二次写入不被接受。原生 standing approval 与 sandbox 没有因一次选择放宽，范围违规为 0。真实浏览器全程 renderer errors 为空。

### 本轮修复、回归与限制

本轮没有修改生产代码、包版本、锁文件或上游；沿用 `141760b` 的已验证 RC.2 产物。补齐独立 ACP 权限生命周期测试、11 项离线单测（含越界与错误决定反例）与入口文档。发现旧 `DSH_E2E_LIVE_TEAMS_APPROVAL` 只等待 DSH bash sandbox escalation、没有处理 Devin 更早的 ACP Ask，现对该不适用组合在 Host/模型启动前明确拒绝，并禁止与新专项混用；零推理前置拒绝验证通过（`native-approval-preflight.log`）。新专项不冒称覆盖原生 bash 升权。

11 项离线测试以及 test/E2E 类型检查通过，日志为 `permission-unit-result.log`、`permission-types-final.log` 和 `permission-unit-types.log`。原有生产全量、构建和桌面证据仍按第 9 节的输入边界复用，没有把它们冒充本轮重新执行。两项真实测试本轮各执行一次即通过，之后没有继续重复调用模型。

实测截图另确认一个原生标题限制：停止后的灰色工具分组仍可能显示 `Wrote files`，上方显示 `Stopped`。插件已将 cancelled 投为 `isError=true` 并附 Interrupted；上游 `process-activity` 只按工具名称分类，关闭分组一律取 `done.write`，并不读取取消/失败状态。因此该标题不是文件成功证据，本次实际取消仍为 0 派发、无文件。可落地的上游方案是让分组标题读取终态，取消/失败时改用中性工具名称或相应状态词；本轮不改上游，也不另造一套插件分组展示。

本轮通过范围为 macOS 上的 RC.2 真实浏览器、上述单模型任务及**待 ACP 审批时**取消。没有验证运行中 shell 取消、Host 重启恢复、双模型或 Windows。第 9 节的首次真实 Teams 验收缺口已由这里的分项结果补齐；原生返回焦点、切模压缩、分叉预检等既有限制不因此解除。只提交到 `0.2.2-alpha`，不发布。

## 11. 新版 Devin MCP 与完整复核（基线 0b82e68，2026-11-14）

按用户决定停止支持旧版 Devin MCP 配置路径；宿主仍精确固定 RC.2，不改上游、不发布。复核使用 RC.2 `ddac967` 的 `dsh-code-review`、`dsh-error-handling`、`dsh-find-simplifications`、Cordis、客户端 UI/UX、响应式与文案规范，并按本仓库 adapter-review / adapter-validation 调整验证范围。累计迁移对照发布基线 `328ef39`，本轮修改对照 `0b82e68`。

### 已实施的修复与删债

- **P1：恢复越过关闭边界。** `retryOriginal` 在读取绑定时暂停，profile close 完成后仍可创建并恢复新的 runtime；后续 close 只返回旧 promise，留下未被关闭流程收录的 Agent。恢复和重新绑定现在先登记任务，再在异步边界核对 adapter、原 Session 实例及 dispose 状态；关闭等待已准入任务结束，迟到结果不能清除替代实例的恢复门禁。受控 promise 回归同时覆盖读绑定、restore 和持久化写入阶段。
- **新版 Devin 采用标准会话 MCP。** 删除 `devin mcp get/add` 用户级注册、SQLite 注册锁、专用打包/复制启动器及启动前预建 lease；lease 统一在 initialize 后按真实能力创建，交给 new/load 等标准会话请求。保留通用 stdio 传输及其打包检查，删除 mock 的旧 native 注册/环境绕行。HTTP 回环沿用代理排除合并，只追加 `127.0.0.1`；隔离探针已复现缺少排除时的 502。
- **无来源的超时分支。** 删除已经没有生产构造点、也不参与历史反序列化的 `ACP_HOST_CALL_DRAIN_TIMEOUT`。对应回归改为真实的 transport crash 加待完成 Host 调用，仍核验远端结果不明、恢复拒绝与显式放弃后的 WAL 清理。
- **客户端规范。** 成员管理的节点参数改为窄数据和回调；触屏配置字段补 16px 字号下限，桌面字号不变。未新增用户选项或测试记账文案。

支持说明和 CI 统一为 Devin `3000.12.43` 或更新版本，以 `3000.12.43` 为本轮验证版本；更高版本不冒称已实测。官方[更新记录](https://docs.devin.ai/cli/changelog/stable)已记录会话级 MCP 支持修复。CI 删除旧版本选择项，保留真实模型用量的显式授权；macOS ARM64/x64 与 Windows x64 固定归档均实际流式下载并对照[官方 manifest](https://static.devin.ai/cli/3000.12.43/manifest.json)核验 SHA256。

### 旧注册与权限边界

不会自动删除用户已有的 `dsh` 注册或旧启动器。CLI 可能在 initialize 时预热旧用户级入口；早期探针没有观察到启动，固化测试却捕获了它，因此保留 `modern-script-1.log` 的严格失败，不再声称旧入口完全不启动。最终零推理夹具模拟旧入口没有会话端点时的空工具行为，验证新建/加载均连接本次 supplied HTTP/stdio、列表只保留当前定义，原 native 配置字节不变。通用 stdio 单测另外证明无端点时工具目录为空、旧工具调用被拒绝。

零推理 `/mcp` 只证明连接和替换，不证明实际模型选择工具。真实测试使用只复制认证的空白配置；人工审批前拒绝任何 native MCP 条目、项目覆盖或配置导入，再核对已知 CLI、原始七选项、原文 hash、活跃 owner/tree 和实际 Host 派发。它不为生产 Auto 增加权限，Devin 的原生审批仍交给用户。

### 复核范围与保留项

运行时复核覆盖初始化、关闭、补存、sidecar 恢复、工具撤权、子代理树和权限归属；客户端复核覆盖首次绑定的静默等待、恢复选择、中英文、插件详情、成员菜单与窄屏。没有发现需要扩大权限或复制上游服务的理由。既有原地切模压缩、分叉预检、原生 Modal 返回 BODY 和取消后分组标题的问题仍按第 9–10 节保留。

`AcpHostSettlementError` 等内部带 code 的错误类仍继承裸 `Error`，与官方统一基类规范不一致；本轮逐个追踪出站 owner 后，未发现丢失机器分类或错误重试，最终对宿主转换保留分类和 cause。基类迁移作为非阻塞规范债保留，不借本次 MCP 删债改变公开错误分类或新增依赖。

### 本轮验证记录

本轮日志和隔离证据位于 `.local/devin-modern-mcp/`。历史 Teams 通过记录仍保留，但不能代替本次传输变更后的实测。

- `pnpm exec vitest run --no-file-parallelism`：229 文件通过、1 文件跳过，2900 项通过、3 项跳过（`unit-full.log`）。之后仅修改真实测试的等待/发现提示及守卫，相关 3 文件 42 项回归通过；生产代码未再改变。
- 恢复生命周期专项 4 文件 91 项通过；activity 71 项通过。构建 `build-2.log` 通过，打包检查含 322 个文件、128 个运行时 JS 和严格类型消费者；专用 launcher 不再打包，通用 stdio 明确列入必需产物。源码、测试、工具、E2E 类型检查通过。
- 零推理 CLI：new/load/stale_new/stale_load 四场景通过，8 次固定 `/mcp`、0 模型请求、0 工具执行（`modern-script-2.log`）。`catalog-2.log` 使用最终产物分别通过 HTTP/stdio 读取并对齐 28 项实际 DSH 工具 schema。初次 catalog 脚本使用了 SDK 未导出的路径，已修正为公共导出；失败保留在 `catalog-1.log`。
- `hover-responsive.e2e.ts`、`team-management.e2e.ts` 两项通过（`ui-1.log`），已检查明暗 390px 触屏配置与成员菜单截图，renderer errors 为空。此处 build-1 与 build-2 的差异仅为无来源 timeout 分支删除，UI 输入相同。既有中英文、首次绑定、共存和创造模式桌面证据仅按未变输入复用，本轮不声称重跑了完整 Electron/Windows 矩阵。
- `permissions-1.log`：真实 `3000.12.43` / `swe-2-high` 在最终标准 MCP 产物上通过，65.77 秒。Allow 仅一次成功写入，Reject/Stop 零 Host 派发且无对应文件，Stop 原始决定为 cancelled，随后同一 DSH/ACP 子会话续聊成功；0 范围违规。当前价格目录复核标为 Free（`model-preflight-2.log`）；首次只因临时 cwd 尚未创建而在 spawn 前失败，已保留日志。

### 真实 Teams 目录发现限制

共享任务前三次失败均保留于 `shared-1/2/3.log`，不改写为通过：第一次完成两个任务创建和一个真实子代理后，请求合法的 `wait_agent { timeout_ms: 300000 }`，被原测试的 60 秒上限拒绝。原生等待收到新输入立即返回；测试现允许最多 300 秒并在提示中说明，补齐上下界、非法类型、额外字段和成员角色反例，仍保留 32 次工具、24 次任务操作、24 次审批及原有阶段/整体超时。

第二次全量 `mcp_list_tools` 输出溢出，Agent 请求 DSH read 读取私有临时目录，被测试范围守卫拒绝。第三次在提示中要求窄化发现后仍出现溢出，转为 Agent 私有 shell 请求，未获测试授权。当前官方文档没有按名/names-only 的 CLI 发现契约，不能将这条指导视为已实现能力，也不能把拒绝测试外行为归因为工具桥重放。完整目录传输正确不等于自主发现体验可靠；这仍需后续单独处理。可考虑 CLI 按名查询或更合理的目录输出，当前不新增插件私有文件访问旁路、不修改上游。

执行专项现在通过测试级提示词 section，从本次 Host 原生准入的 ToolSet 为主会话提供 8 个、为成员提供 3 个实际 schema；MCP 目录正确性由独立检查承担，真实执行仍走当前 bridge、原生权限和 Host guard。这个条件必须随通过结论一起保留，不能冒称全量目录自动发现也通过。

`shared-4.log` 和 `shared-5.log` 都在模型请求前失败：全局注册表及未挂原生预设的临时 Agent 缺少 `subagent`，不能代表真实回合。最终夹具改为原生工具解析完成后，通过非 complete、关闭变量插值的测试级 section 读取 `scope/toolSet`，只保留本次真实活跃 Agent 的定义，结束时撤销 section；不创建额外 catalog Agent，也不迁移生产路由。这两次前置失败不计为模型功能失败或通过。

`shared-6.log` 的业务断言已观察到两个 revision 3 的 completed 任务、calculator 的成功回信与 Lead 的最终回复，13 次 Host 调用均成功、0 范围违规；原测试却额外要求 `team_task_list`，与任务文字允许 get/list 二选一不一致。该记录仍标为失败，因为断言后的持久化和面板检查尚未执行。夹具已移除此多余要求，保留实际任务状态、owner、get/update、原始权限决定及后续 UI 检查。

最终 `shared-7.log`：1 项真实浏览器测试通过，61.39 秒；结果和截图归档 `shared-7/`。12 次原始一次授权对应 12 次成功 Host 调用，0 范围违规。真实 calculator 获取、领取、完成 Compute 并回信；Lead 等待被消息唤醒，查询任务后完成 Review；两个任务均 revision 3 / completed，owner 分别为 calculator 和 lead。持久化历史核对 relay 先于最终模型回复，原生面板显示一个完成成员、两个完成共享任务和单一 ACP 设置入口，renderer errors 为空。已查看最终面板及审批/停止截图。全量目录自主发现仍不在通过声明中。

本轮通过范围为 macOS、DSH RC.2、Devin `3000.12.43` 和目录标为 Free 的 `swe-2-high`，以及上述任务与待审批取消场景。Windows、iOS 真机和更高 Devin 版本未实跑；既有上游限制及内部错误基类规范债仍保留。最后的 E2E/test/tools 类型、全仓格式及 diff 检查通过，只提交、不发布。

## 12. Devin 大目录发现与投产候选复核（基线 d4ad863，2026-11-14）

### 原因与插件侧修复

真实 Standard 会话的目录有 36 个工具，Devin 展示格式为 48,738 字节；之前裸 Agent 探针只有 28 个工具，未代表原生预设。CLI `3000.12.43` 的 `mcp_list_tools` 只接收 server 名称，长输出按其自身机制保存为 overflow 文件。旧插件要求“先只列名称，再逐项查定义”，但 CLI 没有对应接口；旧验收又禁止所有原生文件读取，因此把正常保留机制变成了发现阻断。

插件现在在 Devin 差异模块说明可执行的读取路径：发现当前 MCP server，遇到长目录时用 Devin 原生 read/search 有界查看它返回的文件。DSH 任务和技能仍使用本会话的 MCP 工具。完整工具名、schema、描述、权限选项与 Host 执行链保持不变；没有裁剪参数、读取私有文件的插件旁路、统一调用包装工具或额外用户设置。通用 Agent 的说明也不再假设 names-only 接口存在。

这项修复解决溢出后的发现流程，不承诺 CLI 不再产生 overflow 文件。Agent 原生权限仍由原机制处理，不因此获得自动批准。零推理探针改经公开 `sessionController.create` 的 Standard 预设，再核对 HTTP/stdio 的完整目录；两条路径均为 36 项、33,762 字节的 `tools/list`，所有 schema 与描述一致。

### 验收方法与失败保留

真实 Teams 已删除测试级 schema section，主会话和成员必须各自完成 MCP listing。测试只为目录发现允许 CLI 原生有界 read/search，不批准原生 shell 或 DSH 私有文件读取；原始一次授权、owner、原文哈希、任务预算和实际 Host guard 保留。公开 ACP 活动单独记录发现与读取；当前 CLI 没有在这些活动中提供模型所见 overflow 路径，读取来源无法逐项关联时明确记为不可见，不把路径匹配用于授权。截断或非 JSON 的活动详情也记为不可见，不能伪造成功。

首轮 `shared-1.log` 保留为失败：Lead 与真实 calculator 都自行完成 listing、原生 grep 和分段 read；成员领取并完成 Compute、成功回信。Lead 随后并行调用 get/list 时，测试两次读取审批卡数量得到 1→0，因前景卡切换而错误失败。它不是目录发现失败，也不能算完整 Teams 通过。已针对审批卡切换补齐回归，操作始终绑定原问题与原始一次授权选项。

第二轮 `shared-2.log` 中两个任务均已完成（revision 3），成员回信与 Lead 回复持久化成功。验收仍失败。Lead 通过原生 `exec` 执行了 grep，另一次已批准的 `wait_agent` 发生在成员回信入队之后，未产生 Host 工具执行结果。插件的发现说明随后明确指定 Devin 自带的 `grep` 和 `read`，验收改用仅描述任务目标的用户输入。证据按实际工具种类判读，即使 CLI 把 shell 命令显示为“Searched”也不计为原生搜索。

第三轮 `shared-3.log` 使用业务提示，主会话和成员各自发现目录，两个任务完成，成员回信已送达。17 次原始一次审批对应 15 次成功的 Host 操作、2 次因成员消息排队而在 Host 执行前返回的等待。验收结束时重新查询在线成员，漏计了已退出成员的 5 次审批。另有 3 次原生 read 被旧参数校验拒绝。旧证据未保留这 3 次参数的形态，无法还原具体字段；CLI 自带工具定义确认 offset/limit 可省略，自身有读取上限。保留本次失败，补充成员退出、额外未答问题、原生工具默认读取范围的回归。

### 普通用户流程验收

`shared-4.log` 通过。实际执行使用 macOS、DSH RC.2、Devin CLI `3000.12.43` 与免费 `swe-2-high`。用户从原生对话框发出任务目标，未提供名称清单、schema、参数模板或溢出处理方法。Lead 与 calculator 各自列出当前目录；Lead 两次 grep、两次 read，成员一次 grep、一次 read，目标均属于本次隔离临时目录。没有 shell 调用、无法分类的工具活动或范围违规。CLI 未在公开的 listing 中透出模型所见文件路径，因此这六次只读操作不作逐条来源证明。

成员领取并完成 Compute，把结果和本轮标记发回 Lead；Lead 接收回信后领取并完成此前阻塞的 Review。两个任务均为 revision 3，真实原生成员面板与持久会话历史均已核对。该轮 11 个原始一次审批对应 11 个成功 Host 工具调用，耗时约 79 秒。

权限专项 `permissions-2.log` 通过，耗时约 61 秒。夹具使用原生子代理服务创建一个真实 Devin 成员，用户用自然语言给出文件路径和内容。成员独立发现目录，以原生 grep/read 完成读取。Allow 仅写入一次，Reject 和等待审批时的 Stop 均无 Host 派发、相应文件均不存在。随后在同一 DSH 与 ACP 成员会话继续，刷新后可见回复，无遗留审批卡或范围违规。这项 Stop 覆盖等待审批的请求。

### 当前候选产物与已完成检查

证据目录为 `.local/devin-catalog-recovery/`。兼容目标仍为发布的 DSH `0.2.2-rc.2`，CLI 固定 `3000.12.43 (517d03d73926)`；本轮实际认证目录仍将精确模型 `swe-2-high` 标为 Free。源码修改未触及上游。

- 最终全量单测 `pnpm exec vitest run --no-file-parallelism` 在 230 个文件中通过 2953 项，跳过 1 文件、3 项（`unit-final.log`）。源码、单测、工具脚本和 E2E 类型检查通过。首轮受限环境无法绑定回环端口，失败记录已保留。
- `registry-build-1.log` 的最终构建通过，`catalog-2.log` 核对 Standard 会话 HTTP/stdio 的完整目录。最终候选包有 322 个文件，包含 128 个运行时 JS。最终包逐文件比对一致，精确宿主的新增安装、插件组合、客户端启动与移除均通过（`install-final.log`）。SHA256 为 `32470faa17ea27a3371b084da33125a2e752aa5fe2371241411c3b19063df53b`。
- 独立 Electron 桌面通过 ds-bot／ACP 共存、双方热启停、活动取消与新会话。最终候选的首次绑定等待 3548ms，错误重连提示 0 次。创造入口、官方技能、插件安装及目录变化、停启与恢复通过。中英文 × 明暗 × 390px 已检查，无横向溢出、菜单越界或 renderer error。证据来自协议夹具和 macOS。
- 全量无模型 E2E 首轮 `e2e-full-1.log` 的 292 项中，259 通过、8 失败、25 跳过。下列定向复验覆盖全部 8 项失败；跳过项按原配置保留。RC.2 的任务按钮使用中性名称和可访问的 Running 描述，更新夹具后，三个 Agent 的后台任务和两个 Qwen 取消场景均通过（`e2e-fixes-1.log`）。原生 Web 设置已拆为独立的搜索／获取菜单；保存、重载、取消草稿、同名 Flash 模型徽标和 390px 明暗展示通过（`web-settings-2.log`）。Codex 动态发现测试首次跨越系统低电量休眠，在注册工具前超时；单独运行同一用例通过（`codex-parity-1.log`），无需放宽超时。

第八项失败是可复现的插件界面问题。1680px 缩至 900px 后，“添加 Agent”完全移出视野，浏览器隐藏目录浮层，但菜单内的“手动添加”仍有焦点。此时按 Tab 会误开编辑器（`registry-interaction-1.log`）。插件在触发器完全离开可见范围时收起菜单，必要时把焦点还给触发器。修复后验证了 Tab 不再误选、菜单能重新打开、三种窗口尺寸下键盘和点击均可用（`registry-recovery-1.log`），390px 触屏亮、暗主题也通过（`registry-touch-final.log`）。

后续发布仍按既有流程冻结 Registry 输入、执行平台 CI 和发布同一份经安装验证的 tarball。本轮不创建标签、不推送、不发布。切模压缩、分叉预检、原生焦点及取消分组标题的既有边界见前文。
