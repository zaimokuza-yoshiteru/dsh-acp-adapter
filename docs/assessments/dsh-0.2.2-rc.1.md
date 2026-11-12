# DSH 0.2.2-rc.1 兼容、复用与 UI/UX 评估

评估日期：2026-11-11。适配器基线为 `0.2.2-alpha` 分支的 `9a53467f984f6e7f432e66278e2c1838fad6d70c`，评估开始时目标为 DSH `0.2.2-alpha.2`；后续实施已锁定 RC.1，候选插件为 `0.2.2-rc.1.1`，未发布。本次对照上游 `dsh-v0.2.2-alpha.2`（`f3803c96974ad4a94195fb97e5c637e9c2a3afe3`）与 `dsh-v0.2.2-rc.1`（`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）。

评估结论：**需要兼容，但不需要重做 alpha.2 已完成的核心迁移。** 精确 npm 探针发现一处生产类型破坏和一处测试声明缺失，最小修正后类型检查与构建通过。Cordis 生命周期和原生浮层提供了窄范围删债机会；RC.1 的新菜单与移动端布局需要重新验收。已有 ACP 切模压缩、Auto Review 和 Forge 目录交接限制没有自动解决。

第 1–6 节保留实施前评估，第 7 节记录正式迁移后的改动与实际验证结果。

## 1. 评估阶段的更新与证据范围

- 参考库已 checkout 到 RC.1 标签，原有 `.claude/skills` 删除保留。没有修改上游生产源码。
- 评估阶段只记录调查并更正原生 FS 复用说明，没有修改生产代码或依赖；后续实施与最终验证见末节，仍在 `0.2.2-alpha`。
- [RC.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)发表于 2026-11-04，汇总范围从 `dsh-v0.2.1-rc.5` 开始。下面结论来自 alpha.2 → RC.1 实际差异，不能把累计说明中的每个功能都视为本次新增。
- 使用适配器的 [adapter-review](../../.agents/skills/adapter-review/SKILL.md) 与 [adapter-validation](../../.agents/skills/adapter-validation/SKILL.md)，并对照 RC.1 官方 [代码审查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/.agents/skills/dsh-code-review/SKILL.md)、[简化评估](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/.agents/skills/dsh-find-simplifications/SKILL.md)、UI/响应式规范和相关 defensive patterns。源码生产者、消费者及 npm 导出优先于旧说明。

### 发布依赖探针

隔离目录为 gitignored `.local/assessment-0.2.2-rc.1/npm-probe/`。从上述适配器提交复制 tracked 文件，只在隔离 manifest 中将 DSH 依赖、peers 和 `engines.dsh` 对齐 RC.1；Cordis、Loader、group、Schemastery 按该标签的实际版本对齐。该探针阶段未改变主工作树依赖，正式迁移见第 7 节。

| 检查                                                         | 结果与限制                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --ignore-scripts --no-frozen-lockfile`         | Node `24.19.0` / pnpm `10.7.0` 下成功；跳过安装脚本，未将源码或 workspace 包冒充发布包。                                                                               |
| `node scripts/verify-dev-dependencies.ts`、`pnpm gen:typert` | 101 项精确开发依赖检查通过；生成 5 项 Typert 产物。                                                                                                                    |
| 原源码 `tsc --noEmit -p tsconfig.json`                       | 2 个诊断，均为 `native-tool-renderer.ts` 的 `fileMentions` 旧字段。                                                                                                    |
| 原源码 `tsc --noEmit -p tsconfig.test.json`                  | 上述 2 个诊断，加 `current-step-admission.spec.ts:83` 的 `session-title` purpose 声明缺失。并非另有 3 个生产错误。                                                     |
| 原源码 `tsc -p tsconfig.tools.json`                          | 通过。                                                                                                                                                                 |
| 原源码定向单测                                               | 6 个文件、38 项通过，覆盖 continuity、投影、注册启动、关闭时最终投影写入、旧设置读取/导入、当前步骤准入。                                                              |
| 隔离最小修正后的 `pnpm typecheck`                            | 生产、测试、工具类型检查全部通过。修正仅删除两处旧 `fileMentions` 透传，并在测试引入 `session-title-llm` 类型声明。                                                    |
| 隔离最小修正后的 `pnpm build`                                | 构建和 bundle 校验通过：295 个 tarball 文件、118 个 JavaScript 运行时相对导入闭包、公开 Remote 类型严格消费通过。                                                      |
| 隔离最小修正后的补充单测                                     | 原生渲染器与 Audit 生命周期 2 文件、7 项通过；工具桥 1 文件、8 项通过。工具桥首次因沙箱禁止监听 `127.0.0.1` 而失败，允许本机监听后单独重跑通过；不是产品失败后改断言。 |

单测命令及原始结果保存在同目录的 `npm-focused-tests.log`、`npm-minimal-focused-tests.log`、`npm-minimal-bridge-tests-localnet.log`；原始类型诊断、修正补丁和构建日志也在该目录。两批合计 9 个不同测试文件、53 项通过，不代表完整测试矩阵。

评估阶段尚未验收 RC.1 Host、浏览器或独立桌面，参考产物仍是旧版本，源参考门禁因版本不同而不满足；旧 alpha.2 截图和真实 Agent 结果没有计入 RC.1 证据。后续实施重新构建 RC.1 并执行独立验证，结果见末节。

## 2. 必须兼容与无需重做的部分

### 必须处理

1. **精确版本输入。** 正式迁移时更新 `engines.dsh`、peer/dev 依赖与 lockfile。RC.1 使用 Cordis `4.1.0`、Loader `1.1.0`、Schemastery `3.19.0`。当前精确 alpha.2 声明不能作为 RC.1 支持声明；隔离编译通过也不代替正式分支迁移。
2. **原生工具 owner。** [native-tool-renderer.ts](../../src/client/ui/native-tool-renderer.ts#L19) 删除 `fileMentions` 的旧 owner 透传。官方现在在 [assistant renderer](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-chat/src/client/chat/register-node-renderers.ts#L64) 的注入层提供文件交互；本插件 `mountNativeEntry` 已保留原条目的 `inject`。应继续借用官方机制，不把新文件菜单重写到 ACP 卡片里。
3. **purpose 的生产者声明。** [准入测试](../../test/unit/domain/current-step-admission.spec.ts#L83) 构造 `purpose: 'session-title'` 时显式 `import type {} from '@deepseek-ai/dsh-session-title-llm'`。官方改为 [可扩展 purpose map](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/llm-request-purpose-declarations/guide.md)；不要在适配器重新定义中心 union，或为消除类型错误放行辅助 ACP 请求。
4. **原生分叉入口的能力一致性。** 新的会话上下文菜单扩大了直接调用原生 fork 的表面，而 ACP 的来源登记目前只在自己的 Chat `forkAt` 路径中。这是 P2 体验缺口；官方尚无覆盖全部入口的公开扩展点，需要上游统一 fork action 后接入现有 coordinator，或由同一能力声明禁用不支持的入口。当前不能承诺所有原生“分叉”按钮都已有 ACP 连续性。详见 UI/UX 节。

### 核心接入无需再次迁移

Agent/AgentLoop、模型选择、Tools 和 native/PTC executors、Jobs、Subagent、Session Query、Remote/Typert 主要生产接口相对 alpha.2 没有本次所需的重新设计。现有 `agent.model.current/select`、同一步 `ResolvedToolSet`、批次执行、条件工具撤销和异步投影 handle 均可继续使用。

有变化但当前消费者可沿用的接口：

- Cordis waterfall 新增每层 `next()` 最多调用一次的约束；已审查的适配器 middleware 均只调用一次。
- Loader 的配置更新、停用更完整地等待生命周期结束；本插件使用的 Volatile 更新事件仍在。必须用真实 Loader 验证热更新，而不是仅看手工挂载测试。
- [投影 frame](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/projection-event-frames/guide.md) 变为每次事件携带 `changes: [{ key, val }]`；本插件借用官方 Session client，没有直接解码旧 frame。ACP 自有 Activity stream 不应跟着改格式。
- [投影 snapshot](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/projection-snapshot-scope/guide.md) 只计算指定 wire keys；本插件 Host facts 已通过 ready handle 读取，无需补一次全量 snapshot。
- [投影注销](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/projection-released-checkpoint/guide.md) 后可保留既有 checkpoint，公开 snapshot 仍隐藏失活能力。它改善热停用缓存保存，不替代 ACP Sidecar 的绑定、派发和恢复事务。

## 3. 评估时识别的技术债及保留理由

| 项目                                     | 建议                                                                                                                                                                                                    | 删除前的验收                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具桥延迟开始 `pipelineOwner.dispose()` | 窄范围简化。[bridge.ts:1823](../../src/host/tools/bridge.ts#L1823) 防止已卸载 consumer 从旧 Cordis registry 消失的前提已改变。Cordis 4.1 按 service impl 保留 dependents，并等待真实 unload。           | 保留 accepted calls 排空、有限 transport close 和防止等待自己的 disposer。覆盖 consumer-first、provider-first、transport grace 后 provider 卸载、根关闭与热重装；现有测试通过只能证明现状，不能认证删改后的逻辑。 |
| Catalog 目录浮层手工测量                 | RC.1 `useAnchoredPosition` 新增 `minWidthFromAnchor`、visualViewport 和逐帧锚点跟随，可减少当时 `CatalogAnchor` 的宽度/位置测量；该 helper 后续已删除，见第 7 节。                                      | 官方 hook 尚未提供旧实现的上/下选侧和按侧可用高度。只删除重叠部分，或先验收新的定位行为；不能称整块等价替换。                                                                                                     |
| 旧设置导入的异步任务                     | [legacy-settings.ts:32](../../src/host/composition/legacy-settings.ts#L32) 用 `void` 链启动，cleanup 仅置 disposed；已进入 `configEditor.edit` 的写入可能在停用后继续。属于旧规范债，并非 RC.1 新回归。 | 归属并等待已接纳写入，未开始的 Loader 等待可撤销；不能盲目 await 整条 `loader.await()` 链造成加载/卸载互等。需 controlled promise 覆盖 mapper 后暂停、卸载、最终 profile/marker 写入。当前为静态交错证据。        |

以下内容**没有等价替代，不建议删除**：

- `acpHostContinuity`、未结算执行 owner、Sidecar 和 fork journal：它们跨插件重装保存业务事实，Cordis 只保证资源生命周期。
- registry 内部有顺序的清理和 `allSettled`：同一 fiber 的 sibling disposer 仍可并发，一项失败不能跳过后续收尾。
- MCP 跨请求互斥、同一步准入、未知远端结果恢复、多范围权限和 ACP 文件保护。
- 原生 renderer 私有 slot alias 与 `data-slot` observer：ui-slots/ui-renderer 本次没有提供独立 DOM anchor 名称，仍不能删。
- 稳定 Audit 注册及 header/body 的每会话可见性过滤：上游会话退休窗口没有等价替换机制。
- 本地 client bundle preset：官方仍未作为 npm 公共入口导出；平台 module table 未变。新增 inline-safe 条目并不要求把未消费模块全部复制进本插件白名单。

同时更正旧 FS 论据：官方 `writeText` 实际原样写入 UTF-8 content，只有返回的 diff `after` 归一 LF。保留 ACP 写层的理由是最终 symlink 拒绝、staging 后发布前重新检查内容 hash、新建不覆盖竞争及实际字节审计；官方接口的 symlink 和版本检查时点并不等价。本次同步纠正 [中文](../native-reuse.md)与[英文](../native-reuse.en.md)说明。

## 4. UI/UX 影响

| 表面                 | RC.1 影响与建议                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件路径与上下文菜单 | 官方新增统一菜单和文件动作，按交互时的 live cwd 解析；优先复用 native entry 的完整注入。最小类型修正后，验证 ACP 工具卡文件打开、右键/长按、复制、窗口边缘和工具卸载，不再造一套菜单。                                                                                     |
| 会话分叉菜单         | 原生 `uiWorkspace.forkSession` 直接调用 Session fork；ACP Chat 的 coordinator 还负责来源与 cut 的持久登记。侧栏原先已有同类缺口，RC.1 在标题等表面增加入口，扩大了用户触达面。必须检查未登记 child 的第一条输入和冷恢复，不能把仅复制可见日志视为外部 Agent 上下文已分叉。 |
| 390px / 平板侧栏     | `<768px` 改为覆盖式抽屉，关闭侧栏和打开时的主会话分别使用 `inert`；Menu 会关闭位于 inert/hidden 锚点的菜单。重新验收 Agent picker、ACP settings、诊断、draft 保留、侧栏与菜单互斥、键盘焦点及明暗主题。旧 alpha.2 截图不足以证明新布局。                                   |
| Composer 浮层        | 新 `will-change: transform` 会影响 fixed 定位；官方要求弹层 portal 到 body。本插件已有 `AgentSessionMenu` portal 和 Team `createPortal`，未发现必须新增的生产修正，仍需真实窗口检查。                                                                                      |
| 引用、回复过滤与轨迹 | Quote 协议此次未变；Forge 的“加入输入”复用 `conversation.input.for(scope).insertQuote`。继续用原生 composer、All/Final replies、轨迹折叠，验证一次提交/一次展示，不添加 ACP 专用重复按钮。                                                                                 |
| 插件详情与更新       | RC.1 加强官方第三方插件更新/回滚；本插件继续使用原生 Plugins 入口。对精确 RC.1 版本做安装、更新、回退与热启停检查，无需另做 ACP 更新页。                                                                                                                                   |

原生分叉的具体限制：新菜单通过 [session.fork](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-workspace/src/client/session-actions/context-menus.tsx#L51) 调用 `uiWorkspace.forkSession`，所得独立 seeded child 没有 ACP 来源登记。静态执行链显示，同 ACP 续聊先由 [backend guard](../../src/host/composition/backend-guard.ts#L155) 以 `binding-missing` 进入恢复；provider 还在 [runtime 启动前](../../src/host/composition/profile-adapter.ts#L2464) 用 `ACP_FORK_SOURCE_REQUIRED` 兜底。不会静默降级为新的远端会话。现有测试覆盖该拒绝规则，但本轮未运行 RC.1 三类菜单入口的端到端场景。

RC.1 `session/created` 只有 child，没有可验证的 source 和 exact cut，不能从复制的历史猜测来源并异步追认。Context Menu 也不能通过相同 id 的新贡献覆盖内置动作；只隐藏菜单还遗漏快捷键。最小规范方案是上游增加共用 fork action 的能力/override，覆盖标题、侧栏及快捷键，再让 ACP 走现有 coordinator。接入前保留拒绝与清楚的恢复提示，现有 Chat 节点 fork 是独立的已适配路径。

以上记录初次评估时已确认的类型破坏、可复用的新界面和待运行的体验检查；后续实际验收范围见第 7 节。

## 5. 旧阻塞、实验功能和官方 ACP 类

### 模型切换与 Auto Review 仍需独立处理

**切模压缩仍阻塞。** [自动切模路径](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/compaction/compaction-basic/src/index.ts#L183) 所在的 `compaction-basic` 的 index/config/region/summarizer 运行源码从 alpha.2 到 RC.1 完全未变。已有请求历史的会话切换模型时仍强制解析目标新模型容量；没有容量会在 ACP prompt 前报 `MODEL_SWITCH_COMPACTION_FAILED`，短历史也不例外。`modelPolicies` 仍没有 route-level `auto`。

长期方案仍是上游提供按 scope/最终模型决定是否执行自动压缩的接口，在容量解析与写 Session 前跳过外部 ACP 私有上下文。独立 ACP preset 的 `auto: false` 是受限备选，会增加 preset 选择，并影响同 preset 内原生子任务的自动压缩；不应改全局默认。以前的提案与 alpha.2 验证不是 RC.1 已合入或已验收证据。

**#69 / Auto Review 没有因 OpenCode 修复而解决。** 官方新增的是[审核请求](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/experimental/auto-review/src/index.ts#L678)的 `sessionId` 和 `purpose: 'auto-review'`，针对原生 LLM provider 的路由、header 与缓存；不是外部 OpenCode ACP CLI 的会话支持。ACP 工具桥目前缺少审核要求的 native root `tool/call` 日志身份，审核路由又会命中明确拒绝 auxiliary call 的 ACP adapter。向正在等待工具审批的同一个 ACP 会话再发审核 prompt 还会造成并发/递归问题。

可行专项是为真实桥接的 Host 工具接入官方 batch 日志，并给 ACP-origin Auto Review 配置独立的原生 reviewer route；还必须提供与 root tool-call 身份匹配的 assistant/message；这涉及日志/replay/可见历史、身份、取消、权限和模型费用，不是一处透传。Agent 自有工具权限不能靠伪造 native 调用日志实现兼容。

### 实验功能增量

- **Forge**：新增更完整的文件树、diff/review、普通 worktree 工具组合和按 Session 执行的 Git 权限。界面和 Git 策略交给官方。工作目录服务仍没有公开变更前准入；已绑定 ACP 会话的“返回项目”仍可能绕过工具 guard，在下次输入进入恢复门禁。私有 ACP shell 不会自动变成 Forge 可识别的原生工具日志；手动关联 PR 可复用。
- **OAR / Teams**：Host 业务逻辑此次无实质变化。现有工具桥和成员适配继续沿用；OAR fresh-only、额外 CLI/认证和 Teams 成员切模限制仍在，不能从累计发布说明推断已经无缝兼容。
- **官方 ACP 类**：目标源码没有 `AcpTools`/`ACPTools`。`AcpSession`/`AcpModelControl` 把外部 ACP 请求映射到本地 DSH，方向相反；`AcpProvider`/`startAcpRun` 是一次 fresh 子任务，空 MCP/clientCapabilities、文本汇总，不具备本插件的持续会话、完整权限、文件/terminal、恢复和 Teams。实现也未作为公共主类完整导出。继续复用 Tools、executor、pipeline、projection 和原生 UI，而非继承这些内部类。

## 6. 评估时的迁移顺序与完成条件

1. 将正式目标统一为精确 RC.1，落地已验证的两项最小兼容修正，重新生成/构建并完成源参考校验。
2. 处理原生会话分叉各入口的一致性；重新验证真实 Loader 下共存、热启停、首次会话、投影注销/checkpoint 和关键权限路径。
3. 独立桌面覆盖文件菜单、工具卡、普通/ACP 切换、390px 明暗、侧栏抽屉及 composer 弹层。生产类型通过不能代替这些行为证据。
4. 在受控卸载回归保护下简化工具桥；独立清理旧设置任务归属，再评估 Catalog 浮层测量。不要把必要的连续性状态一起删除。
5. 压缩策略与 Auto Review 单独设计和验收。解决既有发布阻塞前，不把“基础 RC.1 编译兼容”写成完整功能支持；本轮不发布。

## 7. 实施记录（0.2.2-alpha，未发布）

- 正式 manifest/lockfile 对齐精确 DSH `0.2.2-rc.1`、Cordis `4.1.0`、Loader `1.1.0` 和 Schemastery `3.19.0`；候选插件 `0.2.2-rc.1.1`，README 安装命令继续指向已发布 RC.4。
- 移除 `nativeOwner.fileMentions` 旧透传，由原生条目注入文件交互；测试显式载入 session-title producer 声明。
- 工具桥删除 `pipelineRetirement` 及等调用清零后才启动 dispose 的旧分支，继续保留有限传输关闭、真实工具排空和防止等待自身的检查。受控回归验证 provider-first、consumer-first 及根关闭时资源与 post-execute listener 保持到反馈恰好提交一次。
- Catalog 删除自有探针、DOM 类查询、逐帧测量、宽高变量和选侧状态，使用 RC.1 原生 Menu 定位与 `minWidthFromAnchor`。接受原生 clamp 可覆盖触发器的行为，回归要求菜单/固定入口始终在视口内、可实际命中、键盘焦点和未保存草稿保留。Team 浮层采用原生 visualViewport 尺寸上限。
- 补齐投影注销后的 checkpoint 保留、失活 snapshot 隐藏、旧 reader 最终推进及重新注册恢复；补齐缺来源 seeded child 在 Sidecar 重开后仍拒绝且不调用远端的回归。
- 集成类型检查额外发现 Schedule API 变化：夹具迁移到 create/list/view/edit、一次 RRULE、显式目标、分页 list 和按 task 查询的 receipt，保留真实桥接、委派拒绝、活动/空闲投递及重装持久化。生产桥动态使用官方工具，无需另加 Schedule 适配分支。
- 修正 Web provider 回归中过时的 `fiber.config` 身份断言：RC.1 区分 rawConfig/effectiveConfig；保留服务/有效配置身份、原始配置内容及真实 MCP 请求结果检查。
- 旧设置导入没有加入简单 await：可控 facade 展示了 ConfigEditor 并发重装/关闭的等待环风险（普通 volatile 配置导入不必然触发 ACP 重装），不能用新死锁替换旧规范债。分叉共用入口、自动压缩、Auto Review、Forge 目录准入和 ConfigEditor 事务收尾共五项，单独记录在[上游方案](dsh-0.2.2-rc.1-upstream.md)，均未宣称已解决，也未对外发 issue/PR。

### 本次验证

本机 Node `24.19.0` / adapter pnpm `10.7.0`；官方源码构建使用其固定 pnpm `11.28.5`。日志保存在 gitignored `.local/migration-0.2.2-rc.1/`。依赖变更使旧 alpha.2 结果失效，本次均以 RC.1 重新验证。

- 101 项精确发布开发依赖、`pnpm typecheck`、`pnpm build` 与 `verify:source-reference` 通过；包校验仍为 295 个文件及 118 个 JavaScript 闭包。
- 官方参考 `pnpm build:artifacts` 8 个阶段通过，再运行 `pnpm build:check` 的 Host/Client 两项聚合检查通过。首次 tsx IPC 被沙箱拒绝，允许本机 IPC 后构建成功；上游源码未打补丁。
- 全量单测首轮 207 文件：2593 通过、1 个过时配置身份断言失败、3 跳过；修正后该文件定向 7/7 通过。新增投影/准入定向 24/24、工具桥 9/9、fork 32/32、原生 renderer 5/5 通过。这些定向数量与全量覆盖有重叠，不相加宣称新的总数。
- 首轮兼容 E2E 为 8 文件、10 项：7 个浏览器场景及 `native-file-path` 的 3 项源码约束检查；9 通过，旧 hover 夹具在窄屏导航前变宽，导致侧栏 opener 被卸载而失败，保留于 `e2e.log`。修正夹具后该场景通过；最终测试保持触屏全程 390px，通过真实抽屉及 More conversation views 导航，不强制点击 inert 元素。
- 最终 Schedule 三场景与完整触屏 hover 共 2 文件、4 项通过（`e2e-final.log`），`pnpm typecheck:e2e` 通过。与首轮和 hover 修正后的证据合并，覆盖 10 个不同的浏览器场景及上述 3 项源码检查；源码检查不计为浏览器行为验收。
- 额外定向执行 `native-parity` 的 Codex 协议夹具：1 项通过、34 项因名称过滤未运行（`e2e-native-file-localnet.log`）。实际验证刷新后的 ACP 图片/工具卡、原生文件右键菜单、下载的精确文件内容与侧栏预览；明暗截图位于 `.local/rc1-native-images/`。首次启动被沙箱拒绝监听 `127.0.0.1`，允许本机监听后通过。合计覆盖 11 个不同浏览器场景，不代表全部 Agent/profile 矩阵。
- 最终 `pnpm exec prettier --check .` 与 `git diff --check` 通过；补充文件菜单用例后的 E2E 类型检查通过。

### 独立 macOS 桌面

使用 RC.1 源码重建的真实 Electron shell/私有 Desktop Host glue，加适配器精确安装的 npm RC.1 公共库，按官方 `prepareDevelopmentProject` 构造独立项目。DSH_HOME、desktop profile、工作区和 Electron user-data 均位于本轮 `.local/.../desktop/`，没有修改日常桌面资料。`ds-bot 0.2.2` 使用先前保存的原包；ACP 使用仓库无凭据协议夹具。

- 初次 session/new 人为阻塞后再释放，等待约 2.3 秒，观察期间没有 reconnecting activity 提示；最终回复完成，Chat/Trajectory/Diagnostics 各一份。
- 通过真实 Plugins 开关分别停启 ds-bot 与 ACP，Bot/classic 页面可来回切换，历史和视图恢复。
- 正在执行的 ACP 停用时记录到 `session/cancel`；重新启用后新会话完成，未重启 Host。
- 1440px 和 390px 明暗主题截图已目视检查。390px 下 Chat、Diagnostics、Session 菜单无页面横向溢出；抽屉打开时主会话 inert，关闭后恢复交互。
- `desktop/rc1-lifecycle-result.json` 为 passed、rendererErrors 为空，16 张截图保存在同目录；验证后关闭本轮独立桌面。

这是 macOS 独立桌面与可控协议验证，不是 Windows、签名安装包/更新、真实 Agent 或付费模型认证。首次加载与已建立会话切模是不同路径；上述成功不消除上游模型压缩和辅助请求限制。

## 8. 插件侧收尾（2026-11-11，仍未发布）

本轮按 P0-1、五项 P1、切模出口及恢复 UX 落地，继续提交到 `0.2.2-alpha`。未修改上游源码、版本或依赖；以下均使用插件公开接口，不以未来上游合入作为前提。

### 行为与限制

- **通用 Agent 入口**：成功探测但没有 `category=model` 目录时，原生模型位提供 `Agent current configuration`。没有 `configOptions`、缺失分类、未知分类均可开始会话；通用配置保持可见且后续 prompt 不擅自还原。`dsh-acp:current-config` 仅为 Host 路由，绝不作为模型值发送 Agent。真实值撞到保留前缀时可逆编码；协议探测和 Teams 也采用同一分类语义。认证、协议和进程启动失败没有被伪装成可用。
- **切模出口**：RC.1 已开始的 ACP 会话不支持原地改变 Host 模型路由。原生 picker 改值后，插件自动恢复已提交模型；弹窗用 Agent 名称及模型名称解释，可保留当前模型或明确确认另开独立会话。原会话历史及草稿保留，新会话不继承 Agent 私有上下文。Host 在 compaction 的容量检查前以稳定错误码拒绝绕过 UI 的请求。首次请求前选择、同模型 reasoning 调整和其他 provider 不受此限制。即使某个自定义 preset 关闭了自动压缩，插件也保守采用同一能力边界，不猜测私有配置。
- **Teams**：已开始成员禁用其他模型，成员事实流及时反映限制；旧的待切换意图不再自动应用。选择当前模型可取消旧意图。写入前同步核验实际 Session、原生选择、序号及最新请求，首次请求在异步读取期间完成也不会落入过期选择。缺少原模型目录项和路由编码长度的边界另有定向回归。
- **P1-1**：原生分叉创建、登记并打开后，恢复记录清理失败显示“分叉已创建并打开”，只提供清理重试，不将成功误报为创建失败，也不重复创建。
- **P1-2**：`creating` 表示远端结果未确认，可明确放弃该次恢复；原未知意图单独归档。放弃本身不创建、取消或删除远端会话，再次创建需第二次明确确认。关闭弹窗、重试与热重载不隐式重复创建，其他原生入口仍需可核验的 source/cut。
- **P1-3**：Host 最终排空同时检查 pending calls、uncommitted feedback 和 retained feedback。已执行但尚未提交的反馈不再被当成清空。
- **P1-4**：关闭先停新准入，等待已接纳工具、独立 prompt 终态处理和最终本地补存，再撤销 settlement sink。持续存储失败抛出含会话、profile、dispatch 身份的 `ACP_LOCAL_SETTLEMENT_SHUTDOWN_FAILED`，不静默清空或重做工具。此方案没有增加 durable outbox：进程最终退出后仍可能无法恢复未落盘的 payload，不能承诺零丢失。
- **P1-5**：probe 与正常 runtime 的进程拆除警告接入结构化 Host logger；日志观察器故障不打断清理，独立 fallback 仍保留。
- **恢复 UX**：可恢复状态优先显示“重新连接原会话”；“新建独立会话”不再为默认 primary，明确不会继承上下文。重置为空白 Agent 上下文需再次确认，并在提交时重查权限。390px 下切模/恢复动作换行，保留重要说明与操作。

### 不实施的上游依赖能力

不伪造 ACP 容量、不改写 compaction 或原生分叉私有方法、不仿造 assistant/tool 日志。完整原地切模、所有原生入口统一 fork、ACP Auto Review、Forge 所有入口的目录变更前准入、ConfigEditor 并发关闭的事务保证不在本轮实现；现有门禁与限制保留。上游设计仅作[分析备忘](dsh-0.2.2-rc.1-upstream.md)，不会要求用户等待或修改上游。

### 本轮验证

使用 Node `24.19.0`、pnpm `10.7.0`、精确 npm DSH `0.2.2-rc.1`。独立桌面仍采用第 7 节所述源码 shell/私有 Host glue 与正式 npm 公共库，使用全新 `.local/rc1-plugin-fixes/desktop/` profile、workspace、Electron user-data；未使用日常桌面资料、凭据或模型额度。协议夹具不等于真实 Agent 认证。

- `pnpm typecheck`、`pnpm typecheck:e2e` 与最终 `pnpm build` 均通过；校验 101 个精确发布开发依赖、302 个包文件、121 个运行时 JavaScript 闭包。
- `pnpm exec vitest run` 首轮 210 文件：2643 通过、1 个旧浮层数量断言失败、3 跳过；新增分叉恢复浮层纳入断言后，该注册文件 3/3 通过。后续 Teams 事实/竞态、协议探测分类、缺目录当前模型恢复及长路由边界分别定向 51/51、17/17、49/49 通过，覆盖有重叠，不相加宣称全量重跑。相关日志为 `unit.log`、`client-registration-final.log`、`.local/rc1-team-facts-routing.log` 和 `.local/rc1-followup-review/`。
- 浏览器通过 8 个文件的 13 个不同场景：`generic-agent` 三变体，`native-model-picker`，`native-fork`，`recovery-queue`，`team-model-selection`，`teams-boundaries` 三场景，`qwen-code` 两场景，`team-card-layout`。没有运行整个 E2E/profile 矩阵。
- 首轮浏览器 6/10 通过；4 个失败分别为 390px 导航浮层与业务弹窗的选择器重名、关闭与取消按钮重名、测试审批参数与协议夹具不一致、原生对照模型缺少容量声明。修正夹具后下一批 8/9 通过；剩余为固定日志路径累计旧 prompt，改为每次独立 Host 工作区后，切模用例最终 1/1 通过。原生对照模型的容量只定义在该测试适配器中，ACP 生产路由未伪造容量。日志为 `e2e.log`、`e2e-followup.log`、`e2e-model-exit-final.log`。
- 分叉浏览器注入本页 journal 清理失败，核实 child 已打开、重试不重复创建；再模拟未知创建记录，经放弃归档及单独确认后才执行第二次创建。390px 恢复截图位于 `.local/native-fork-alpha2/web/`；该路径沿用测试既有约定，结果由本轮重新生成。
- 新隔离 Electron 的 `desktop/rc1-lifecycle-result.json` 为 passed，7 组行为检查、23 张截图，`rendererErrors` 为空。首次 session/new 延迟 2241ms 后完成，MutationObserver 没有捕获重连活动提示；Chat/Trajectory/Diagnostics 各一份。
- 通过真实 Plugins 开关分别热停启 ds-bot 与 ACP；活动 ACP 停用记录到 `session/cancel`，重新启用后新会话正常完成。通用 Agent 没有 configOptions 也可从原生 picker 进入，首次 prompt 没有任何模型配置写入。
- 同 Agent 改模型时取消保留原会话与草稿，确认后独立 B 会话完成；返回原会话草稿仍在。崩溃恢复的空白重置先确认，取消保持恢复门禁，明确确认后后续请求成功。1440px 与 390px 明暗、切模/恢复/重置确认、诊断与抽屉截图已检查；无页面横向溢出，抽屉打开和关闭时 inert 状态正确。验证后已关闭该独立桌面。

本轮没有调用真实模型或消耗模型额度，不构成 Windows、签名安装包/升级或真实 Agent 的兼容认证。上游 checkout 保持原状。

## 9. 保留 worktree 历史的完整迁入（2026-11-12，未发布）

迁入来源为 `copilot-worktrees/dsh-devin/cartecho-refactored-pancake/dsh-acp-adapter` 的 `fix/review-batch-1`，不是此前检查的旧 worktree。从 `927b6dc` 到 `77d6450` 的 21 个提交通过 fast-forward 完整进入 `0.2.2-alpha`，没有 squash、重新生成提交或改写来源分支；下面的修复作为后续提交保留。依赖、包版本和发布状态均未改变。

### 六处修复及保留边界

| 复核问题                         | 迁入后的行为与回归                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可选授权表单的 Skip 被当作接受   | Codex 工具授权 `persist` 即使未被 schema 标为 required，空回答也返回 cancel；真正可选的普通字段仍可省略，必填字段空回答取消。覆盖 false、数值 0 与整数 0 的有效回答。                                                      |
| `_custom` 名称猜测合并了独立字段 | 删除按后缀和相邻位置合并的逻辑，保留每个字段的标题、说明和值及 anyOf 选项。原生 Optional/Skip 分页仍存在，没有宣称实现无额外 Other 页的专用交互。                                                                          |
| 用量缓存重叠、累计值重复入账     | 删除未经确认的 `acpTurnUsage` 映射及原生 usage emission。缺失、非法、缓存包含/不包含和累计 100→250 均不写入宿主计费统计；`usage_update` 上下文占用继续展示。只有各 Agent 的逐次计数及缓存口径可验证时才恢复映射。          |
| 单工具撤权后审批仍可通过         | Ask、Auto、审计等待及 Codex elicitation 都绑定当前 prompt 和原工具目标，撤权立即取消，RPC 回复前再次校验。标题匹配只附加撤权检查，不赋予 Auto 或执行身份；无关工具及 Agent 自有权限不被误取消。                            |
| 整目录刷新仍切断连接             | 空目录保留传输并排空已接纳调用，旧目标撤权不能绑定到新 owner；真正服务或 Agent 消失仍关闭连接。下一安全轮次刷新 lease，同一对象/相同 key 恢复也会刷新。流交接捕获原目录身份，不能在注册替换后通过两次读取新 key 绕过刷新。 |
| 原始 batch cause 泄露诊断数据    | 回复及结构化 Host 日志只保留经现有规则脱敏、移除控制字符、总长最多 1000 字符的错误文本，不展开任意 cause 对象。                                                                                                            |

同时更新中英文 native-reuse 说明，明确首次未绑定会话的受限历史交付条件、逐工具撤权、用量及原生问答的边界。未修改上游，也未扩大此前拒绝实现的原地切模、原生任意分叉或 Auto Review 能力。

### 本轮验证与可复现证据

使用 Node `24.19.0`、pnpm `10.7.0`、101 个精确 npm 开发依赖及 DSH `0.2.2-rc.1`。官方源码 scaffold 为 `66491b05e3`；其已有 `.claude/skills` 删除状态保持不变。日志、桌面脚本和隔离数据位于 gitignored `.local/merge-21-fixes/`。

- `pnpm typecheck`、`pnpm build`、`pnpm typecheck:e2e` 通过；构建校验 304 个包文件和 122 个运行时 JavaScript 闭包。先刷新构建后执行 E2E 类型检查，避免迁入前的旧声明与新源码同时被解析。
- `DSH_E2E_LIVE_QWEN=0 pnpm exec vitest run`：213 个文件中 212 通过、1 跳过；2736 项通过、3 跳过。工具桥、权限、准入和图像能力定向 149/149 与全量存在重叠，不相加计算覆盖。
- 浏览器三项不同场景通过：目录导入、探测刷新、独立可选字段与授权 Skip。命令使用官方 `vitest.mjs run --config .local/merge-21-fixes/e2e.config.mjs`；该临时配置仅将 scaffold 缺少的 `@deepseek-ai/cordis-plugin-include` 指向插件依赖中已有的精确包，没有修改上游目录。未运行完整浏览器/profile 矩阵。
- 新表单用例首次截图发现测试 helper 的第二参数是高度，已改为显式 `390×844` 并断言 `innerWidth === 390`；修正后重新通过。`.local/e2e-acp-elicitation-detail/web/` 的三张 Optional/Skip 明暗截图已检查，分别验证独立文本值、普通可选省略和授权取消。
- 全新隔离 Electron 使用 RC.1 源码 shell、复制到隔离项目的私有 Host glue 与正式 npm 公共库；profile、workspace、user-data 均独立。`desktop/rc1-lifecycle-result.json` 为 passed，7 组行为检查、23 张截图，`rendererErrors` 为空。
- ACP 与 ds-bot 分别通过原生 Plugins 开关热停启；活动 ACP 停用发出 `session/cancel`，重新启用后新会话完成。首次绑定人为延迟，2352ms 后完成，MutationObserver 未捕获重连活动提示；Chat/Trajectory/ACP Diagnostics 各一份。无 configOptions 的通用 Agent 也完成首次会话且没有模型配置写入。
- 同 Agent 切模取消保留原会话及草稿，确认后建立独立模型 B 会话；崩溃恢复取消保留门禁，明确空白重置后可继续。已检查 1440px 及 390px 明暗的会话、切模、恢复/重置确认、诊断、菜单与抽屉，无页面横向溢出，抽屉 inert 状态正确。验证后测试桌面已关闭。

上述 UI 和协议结果来自免密夹具，不是实际模型、真实 Agent、Windows 或签名安装包的兼容认证。本轮未使用日常桌面数据或模型额度，未发布、打 tag 或推送远端。

## 10. 迁入后复核修复（2026-11-12，未发布）

以 `b727c35` 为基线，继续在 `0.2.2-alpha` 上修复复核确认的问题；保留已迁入的 21 个提交。依赖、包版本和上游 checkout 不变。本轮按本地 adapter-review / adapter-validation 与实际 RC.1 的官方规范检查。

### 行为修复与清理

- **目录刷新误触发恢复**：普通输入已经准入并写入派发保护、但尚未进入 `session/prompt` 时，连接关闭、目录 lease 失效或 key 变化现在产生窄类型 `ACP_PROMPT_NOT_DISPATCHED`。只清除此输入的精确 WAL key，保留 binding 和已消费历史位置，重试仍 resume/load 原 ACP ID；不进入未知结果恢复，也不创建空白会话。已派发请求、待接管或正在接管的 Qwen 自动回合不使用这个证明。清理写盘失败进入现有本地补存 owner，下一输入继续等待，不绕过保护。
- **CodeBuddy 思考档发现（#80 的对应子项）**：识别真实 `codebuddy-code` 握手并复用现有逐模型探测。无有效 model 分类时仍使用当前配置入口；通用 Agent 或误标 runtime 不新增切模。模型探测失败不借用默认模型档位，探测串行且不发送 prompt，临时会话正常清理。该协议回归不宣称验证了实际 CodeBuddy CLI 或模型账号。
- **插件活动标题本地化**：会话活动卡的插件生成终端、差异、资源、输出与工具占位标题使用中英 locale。文件名来自结构化路径；占位来源由 Host 自有 metadata 标记，压缩详情时保留。删除以英文 `Agent tool activity` 文案判断去重的分支，Agent 原始同名标题不再被误隐藏；旧记录缺少标记或普通超大明细被截断到不可解析时保守保留原文，不为翻译改写既有诊断截断语义。
- **收窄表面与规范**：移除 25 个没有跨文件或公开入口消费者的内部 `export`，保留实现及所有公开入口；没有删除动态启动器或必要 ambient 声明。版本检测移除进程全局结果缓存，暂时读取失败后下一次可重新检测。AGENTS 和三份本地技能的规范链接更正到真实 RC.1 提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，不再把旧提交标成 RC.1。

### 本地化方案的修正与保留限制

复核时提出的原生模型 label slot 方案不能无副作用落地。精确 RC.1 的 `conversation.input.model.label` 是 `kind: single`；相同优先级的第二贡献会冲突，较高优先级组件即使返回 null 也不会回退其他贡献或原生标签。因此本轮不接管该插槽、不复制原生 name/badge renderer，也不增加全局按语言缓存的模型目录。原生 picker 的 `Agent current configuration`，及其 aria/title、`/model` 文案仍保留现状；插件自己的 Teams 和切模确认已有本地化。

若未来存在官方的条件 resolver 或可回退 label chain，应由一个原生解析入口同时供 trigger/menu/option、aria/title 和 slash 使用，插件只处理自有 provider 的内部 sentinel；真实模型名称保留 Agent 原文。当前不修改或等待上游。此前已有会话切模、任意原生分叉入口、Auto Review、optional Other 页等边界不因本轮改变。

### 本轮验证

验证记录和新隔离桌面位于 gitignored `.local/fix-review-b727c35/`；定向开发回归另在 `.local/review-b727c35/`。使用 Node `24.19.0`、pnpm `10.7.0`、精确 npm DSH `0.2.2-rc.1`。所有 ACP 输入均来自免密协议夹具，没有调用真实模型或使用日常桌面数据。实际结果如下：

- `pnpm build`、`pnpm typecheck`、`pnpm typecheck:e2e` 与最终测试 TypeScript 检查通过；构建校验 101 个精确开发依赖、304 个包文件、122 个运行时 JavaScript 闭包及公开 Remote 消费者类型。改动文件 Prettier 和 `git diff --check` 通过。
- `DSH_E2E_LIVE_QWEN=0 pnpm exec vitest run`：215 个文件中 214 通过、1 跳过；2763 项通过、3 跳过。随后本地化增补断言的五个定向文件 155/155、活动 producer 最终文件 71/71 通过；这些与全量重叠，不相加宣称覆盖。最后的 `tsc --noEmit -p tsconfig.test.json` 通过。
- 目录刷新回归使用真实 ACP 子进程、runtime 与磁盘 Sidecar：directory/key/lease 三类失效均保留同一 ACP ID，同输入重试无额外 `session/new`；写盘失败不发新 RPC；旧写入暂停时热卸载等待，失败任务由替换 sink 接管，旧 writer 释放后仍可完成且不重复派发。实际派发后崩溃与 Qwen 自动回合负例保留未知结果门禁。CodeBuddy 新增 7 项协议回归，修复前 3 失败、4 通过，修复后及原逐模型/Qwen 探测合计 22/22 通过；没有发送 prompt。
- 新浏览器用例 `native-parity.e2e.ts -t 'localizes adapter-owned activity titles'` 在 codex 免密夹具下通过：1 场景通过，35 项因名称筛选未执行。英文→中文→英文切换保持同一挂载页面，生成标题翻译、Agent 原文保留，390px 明暗无横向溢出。首轮失败是 exact button locator 未包括原生状态文案；只修测试选择器后通过，没有用生产改动迎合断言。两张截图已目视检查。命令沿用 `.local/fix-review-b727c35/e2e.config.mjs` 的既有 include 包解析补偿，没有改上游。
- 全新隔离 Electron 的 `desktop/rc1-lifecycle-result.json` 为 passed：7 组行为检查、23 张截图，rendererErrors 为空。ACP 与 ds-bot 分别热停启、活动请求取消、重新启用后首次请求成功；首次 session/new 延迟 2369ms，MutationObserver 没有观察到重连提示，Chat/Trajectory/Diagnostics 各一份。通用 Agent、切模取消/独立会话、崩溃恢复和 390px 明暗、抽屉均通过。关键窄屏截图已目视检查。
- 最终本地化构建重新载入同一隔离桌面，用真实 `E2E_RICH` 轮次加四条可控历史孤立内容记录验证。`desktop/rc1-locales-result.json` 为 passed，新增两张 390px 明暗截图已检查：终端、差异及原生 fallback 工具标题中文显示，同名 Agent 标题保留英文，无渲染错误。总计 25 张桌面截图；验证后独立桌面正常关闭。

本轮没有修改上游源码、依赖或现有工作区状态（上游原有 `.claude/skills` 删除保持不变）。没有发布、打 tag 或推送远端；以上结果不构成真实 CodeBuddy/其他 Agent、Windows 或签名安装包的认证。
