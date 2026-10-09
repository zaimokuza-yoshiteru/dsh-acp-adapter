# DSH alpha.2 源码核对与优化

本次优化的目标是：不增加用户的配置、操作或迁移负担，保留现有功能，优先采用能够保持这些条件的官方新特性和逻辑。UI/UX 同时核对原生入口、交互、状态反馈和主题设置，避免增加相互冲突的第二套机制。工作在 `0.2.1-alpha` 分支进行，不发布、不创建版本标签，也不合并 main；Antigravity 默认配置继续暂缓。

## 范围与方法

2026-10-09 通过上游实时分支及标签查询，并于 10 月 10 日再次复核，确认 `master` 仍为 DSH `0.2.1-alpha.2`，提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。插件审查起点为 `365952a685b28315b326568a946354a1379d9498`。精确依赖与上一轮兼容结果见 [alpha 兼容记录](dsh-0.2.1-alpha.md)。

每个业务领域都沿生产入口、官方提供方、消费接口和可观察结果核对源码。先判断官方能力是否覆盖现有行为，再确认能删除的维护工作、保留的适配和回归风险；仅移动复杂度、引入新配置或减少用户能力的替换不作为优化。下表是源码核对范围，不代表所有平台和真实 Agent 都重新验收。

## 业务全景

| 业务领域                         | 插件实现 / 官方实现                                                                                                                          | 采用与保留判断                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装、配置、Agent 目录           | `src/client/data/catalog.ts`、`src/host/composition/config.ts` / `packages/boot/plugin-manager`、官方配置编辑器                              | 继续使用可安装插件配置层、原生配置编辑和构建时 Registry 快照；目录元数据不决定运行权限。官方 Codex/Claude bundle 是可选后台委派，不强制安装或迁移已有 ACP 连接                    |
| ACP 协议与能力协商               | `src/protocol/v1/connection.ts` / `packages/subagent/subagent-acp/src/run.ts`                                                                | 已采用官方 ACP SDK；保留图片、文件、终端、认证和会话能力协商。官方 ACP 子任务只执行一次，不能替代交互式连接                                                                       |
| 进程、期限、取消                 | `src/runtime/process` / `packages/subprocess`、`packages/util/timeout`                                                                       | 已消费宿主 subprocess 与 timeout；保留 ACP 取消收敛、期限分类与连接关闭。任务完成、进程退出和资源释放分别处理                                                                     |
| 输入、Queue、Steer               | `src/domain/session/current-step-admission.ts`、`src/host/composition/stream-handoff.ts` / `packages/core/agent`、`packages/core/agent-loop` | 沿用原生 inbox、pre-step 和已提交输入；只转发当前准入输入，不以完整历史代替当前请求，不自行创建第二个 AgentLoop                                                                   |
| 会话连续性、恢复、持久化         | `src/runtime/session`、`src/persistence/sidecar.ts` / `packages/session`、`packages/session-projection`                                      | 原生投影拥有执行事实的缓存与恢复；Sidecar 保留 binding、dispatch 与诊断事务。确认远端完成后的本地补存与远端结果未知分别处理，不能改成用户手动重试                                 |
| 共享 AGENTS 与运行时 skills      | `src/domain/session/prompt-content.ts`、`model-context-snapshots.ts` / `packages/context/agent-instructions`、`packages/skill`               | 读取宿主已组装的有效指令和当前工具路由，兼容共享 agents 根及可变工作目录；不复制到 Agent 私有目录、不增加同步器。空白重绑定需要恢复当前有效指令，见下方改动                       |
| DSH 工具、MCP、PTC               | `src/host/teams/bridge.ts`、`tool-execution-scheduler.ts` / `packages/core/tools`、`packages/ptc-runtime`                                    | 继续调用公开 `tools.execute`，遵循每次请求的 native 或 PTC 呈现、可见工具交集和撤销规则；官方内部 `ToolRuntimeScheduler` 不能作为插件公开接口依赖                                 |
| 审批、权限、问答                 | `src/domain/policy`、`src/client/ui/acp-permission-question.ts` / `packages/interaction`、原生审批与问题组件                                 | 普通请求使用原生组件；固定权限选项保留明确选择与提交，不引入自由回答或默认批准。Agent 自有权限与 DSH 工具策略保持各自归属                                                         |
| 文件与终端客户端能力             | `src/runtime/client-capabilities` / `packages/fs`、`packages/subprocess`                                                                     | 宿主服务能复用的继续复用。文件字节、最终符号链接、并发哈希保护和原子创建不能由会规范化文本的写入接口等价替代；错误分类改用结构化标识                                              |
| Teams 通信与管理                 | `src/host/teams`、`AcpTeamManagement.ts`、`AcpTeamApprovals.ts` / `packages/experimental/agent-team`、`client-ui-agent-team`                 | 使用原生 agentTeam、sessionStatus、成员导航和 send_message；保留 ACP 模式、成员模型、批量审批和绑定检查。原生只读名单不能覆盖这些写入能力                                         |
| 子 Agent 与官方 bundle           | `src/host/subagent` / `packages/subagent`                                                                                                    | 原生 spawn/fork 有可续聊 Session；Codex app-server、Claude SDK、ACP 和 DSH SDK 外部委派只返回结果。保留真实观测的只读投影，不把最终摘要伪装成完整流，也不把主会话降级为一次性任务 |
| 模型、推理、模式                 | `member-models.ts`、`agent-session-controls.ts` / `packages/client/ui-model-selection`、`packages/api/api-session-controller`                | 主模型和推理由原生选择器管理；ACP 专有配置沿用原生 Menu。成员待生效模型与持久化绑定继续由适配器处理，避免重复模型入口                                                             |
| 聊天流、思考、分组、折叠与滚动   | `AcpAssistantStream.ts`、`acp-chat-normalization.ts` / `packages/client/ui-chat`、`ui-conversation`                                          | 保留完整原生组件树、viewport hooks、公开 builder 与分组状态；ACP 只接入数据投影，原生详细度和折叠设置继续生效                                                                     |
| 工具树、命令、文件差异、交付     | `AcpActivityNode.ts`、`native-tool-renderer.ts` / `packages/client/ui-tool`、`ui-toolview`、`ui-primitives`、`tool-present`                  | 使用原生 ToolCallTree、TerminalBlock、DiffBlock 与文件卡；事实不足时回退通用详情，不伪造退出码、工具执行事件或原生 turn 文件变更                                                  |
| 恢复面板、诊断、反馈、字体与键盘 | `AcpRecoveryDock.ts`、`AcpAuditHeaderAction.ts`、`AcpAgentControl.ts` / `packages/client/ui-primitives`、`ui-theme`                          | 继续使用原生 Modal、Menu、DisclosureRow、JsonTree、Toast 和主题角色；修复关闭菜单后的失败可见性及诊断正文的固定字号。原生小型菜单与表格字号保持原有规则                           |
| 构建、测试、CI、发布             | `scripts`、`.github/workflows`、`test/e2e` / 官方 Loader、Web scaffold 和开发 workflows                                                      | 保留精确发布依赖、产物检查、分片和普通用户平台检查；迁移失效的模型菜单与 Schedule 夹具。只运行受本次改动影响的本地检查，CI 负责平台矩阵                                           |

## 本轮改动

1. 空白重绑定仅恢复本次宿主有效消息投影中、来源明确的 AGENTS 指令，保留顺序和替换/删除语义，排除当前已准入消息的重复项。普通用户历史、其他来源及已从有效投影移除的指令不重放；正常续聊、已有会话恢复和 Steer 不因此增加传输。
2. 会话选项与 DSH 工具策略的写入失败使用已有全局 Toast。会话选项的写入错误与读取失效分开，重新打开菜单不再误触发读取重连并立即关闭。读取失败保留现有重试行为，迟到结果继续受会话/epoch 检查；不增加每次成功选择的通知。
3. 诊断原始正文使用官方 small-code 字体角色，使代码字体设置生效；不修改全局间距或小型 UI 的字号规则。
4. 文件读取的审计原因和写入的并发冲突判定使用稳定标识。错误消息不再决定这两类状态，IO、超时、取消和真实并发保护保持各自语义。
5. 浏览器回归沿用 alpha.2 实际模型菜单入口及 Schedule 组合；Windows 普通用户检查分别观察子进程结果与 ACL 清理结果，不将一项掩盖为另一项。

## 官方 skills 的采用

本仓库继续维护少量适配后的 workflows，不复制 DSH 整套 `.agents/skills`。对照 rc.2 与 alpha.2：`dsh-code-review` 新增结构化错误处理核对，`dsh-client-ui-ux` 接入同一错误处理原则，`dsh-error-handling` 为新增 workflow；`dsh-find-simplifications` 进一步要求保留失败状态及安全继续的依据。`dsh-pre-push-checks`、`dsh-ci-test-reliability`、`dsh-prose-standard` 在两版本之间没有内容变化。

采用到本仓库的重点是：每个维护对象有当前消费者和明确所有者；预期失败有稳定标识；捕获异常不等于恢复，只有状态所有者确认安全才能继续；已提交与未知结果分开；错误提示可见、可操作且本地化；变更的实际入口、取消、清理和负面控制有适当证据。规范同时约束代码审查和后续业务功能的源码对照。

DSH 的 monorepo 命令、100% 覆盖率门禁、专属快照目录、组织设计审批、Agent Notes/stack 管理和无限真实模型额度不导入本插件。仓库与用户现有授权、实际构建链和测试说明仍是执行依据。skills 的修改不为产品用户增加配置或使用步骤。

## 明确保留与后续条件

不将官方外部子任务的自动权限策略套到交互式人工审批，不用一次性 `SubagentRun` 替代持久 ACP 会话，也不以官方 SDK 消费了流为由声称 UI 已展示完整子会话。直接 app-server / Claude SDK 的完整聊天后端是另一项产品能力，本轮不扩大到该范围。

不删除 Sidecar、不改写用户历史或认证、不将 ACP 文件访问改成具有不同字节与并发语义的宿主文本工具。共享 AGENTS 与 skills 的文件发现、去重和加载仍归宿主；本插件只处理跨 ACP 会话的传递。

新增官方能力今后按本表对应领域追踪：源码入口与消费者 → 行为差异 → 用户负担与保留能力 → 可删除的维护工作 → 最小验证 → 原生 UI 冲突检查。仅有版本更新或“官方已有类似功能”不足以决定替换。

## 测试流程与耗时

上一轮 [CI 37949539479](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37949539479) 从创建至结束约 15 分钟。其中三个独立 runner 的 Host 构建各约 2–2 分 39 秒，浏览器用例各约 5 分 38 秒–8 分 48 秒；macOS/Linux 的完整 npm 兼容检查分别约 3 分钟和 3 分 41 秒。Windows 约 5 分钟后因清理失败结束。这次记录不能证明用户感受到的一个多小时由单次 CI 造成，也不能作为修复后的耗时承诺。

本轮消除失效夹具及清理错误导致的重复排查，并把本地操作文档对齐已采用的 library 构建入口。开发时按受影响行为选择检查，平台全量由 CI 执行；已经通过且输入未变的本地检查不因提交再重跑。保留精确依赖、实际产物与独立安装检查，不用减少验证范围来制造提速。发布仍验证同一 tarball，本轮不运行发布，也不改变发布门禁。

本轮完整成功 [CI 37958222030](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37958222030) 用时 11 分 12 秒，三个浏览器分片各约 6 分 52 秒–7 分 33 秒，Host 构建各约 2 分 15 秒–2 分 21 秒。Windows 普通用户安装、检查、打包及清理约 3 分 48 秒。两次 CI 的失败状态、缓存与 runner 条件不同，这是一条成功执行记录，不能据此承诺固定提速比例或端到端发布耗时。

## 验证记录

2026-10-10 本地输入：Node `24.19.0`、插件 pnpm `10.7.0`、精确发布依赖 DSH `0.2.1-alpha.2`，源码 scaffold 固定为上述 `d743267`，未改 lockfile、Registry 快照或用户 profile。

| 检查                     | 结果与范围                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`         | 通过：产品、单元测试、脚本及 mock Agent 类型                                                                                                                                                                                                                                                                                                                  |
| 定向单元测试             | 9 个相关文件分批通过，覆盖文件读写、空白重绑定、prompt/context、UI 注册与反馈、架构约束；后续 UI 修正再次通过其 2 个 owning 文件                                                                                                                                                                                                                              |
| `pnpm build`             | 通过：类型编译、Typert、bundle、244 个包文件及 92 个运行时 JavaScript 产物闭包、严格公共声明消费者                                                                                                                                                                                                                                                            |
| `pnpm test:e2e` 定向检查 | 10 个用例分批通过：4 个 Agent 目录恢复、3 个 Schedule、恢复队列、Codex response controls、Devin diagnostics；每次先检查完整 E2E 类型与准确 scaffold。过滤未选中的用例不计作本地通过                                                                                                                                                                           |
| UI 截图与实际样式        | 已检查菜单关闭时的失败提示、420px 菜单与 Toast、诊断明暗主题；11/16px 字号及 16/21px 行高、官方字体回退链、表格字号、无横向溢出均由真实浏览器断言                                                                                                                                                                                                             |
| 格式、diff               | 改动文件格式检查及 `git diff --check` 通过                                                                                                                                                                                                                                                                                                                    |
| 平台 CI                  | [`37958222030`](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/37958222030) 在代码提交 `1231cbd3f590c52c59433b283a0a38b3f69d237d` 全部通过：Linux/macOS/Windows npm 兼容、三个完整 keyless 浏览器分片及汇总门禁。Windows 131 个文件、1435 个单元用例通过，普通用户退出码为 0；Developer Mode、工作区 ACL、普通账号及临时目录清理逐项成功 |

新增回归曾揭示三个需要修正的假设或行为：Schedule 工具注销会关闭整个 MCP lease，而非在旧连接返回空目录；官方字体保留完整 fallback；会话选项写失败曾误触发读取重连并关闭菜单。前两项按真实所有者修正夹具，后一项在产品中区分读写错误；对应用例修复后均通过，没有加入重试。

上一轮 CI `37949539479` 的 macOS/Linux npm 兼容检查及浏览器分片 1、3 通过；分片 2 有失效的模型菜单/Schedule 夹具，Windows 在测试和打包通过后发生 ACL 清理错误。该 CI 不能记为整体通过。空白重绑定的指令补发使用 durable Sidecar + mock runtime 单测验证，恢复队列另通过 Loader/浏览器检查；真实 Agent、模型用量和完整桌面安装包未因本次优化重新验收。
