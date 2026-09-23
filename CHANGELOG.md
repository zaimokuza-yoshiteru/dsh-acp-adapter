# 更新记录 / Changelog

用户可见的变化与升级提示。发布时间、精确安装方式及校验值见 [GitHub Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases)。历史条目根据对应标签的代码差异补录；不代表重新发布了 npm 包。

User-facing changes and upgrade notes. See [GitHub Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases) for publication dates, exact installation instructions, and checksums. Historical entries were reconstructed from tag diffs; npm packages were not republished.

## 0.1.7-alpha.2.0

未发布 / Unreleased

### 中文

- 适配 DSH `0.1.7-alpha.2`，宿主与插件需要同时升级；Read/Diff 继续使用新版原生代码卡和中英文工具栏。
- 团队成员创建后及时出现管理入口；读取成员或恢复状态失败时可重试。点击成员名在原生侧栏打开，保留主会话。
- 会话设置说明运行中只读的原因；成员待生效提示可换行并保持设置行对齐，批量模式操作可查看各成员结果。
- 普通审批直接展示操作事实，页面状态和按钮由原生界面本地化；工具桥权限判断新增脱敏诊断，可复制所选记录及版本。自动审批范围不变。

### English

- Targets DSH `0.1.7-alpha.2`; upgrade the host and plugin together. Read/Diff use the updated native code cards and bilingual toolbar labels.
- Member controls appear as teammates are created. Failed roster and recovery reads can be retried. Member names open the native sidebar while preserving the main conversation.
- Session controls explain why settings are read-only during execution. Pending member settings wrap without clipping and stay aligned; batch mode results identify each member's outcome.
- Ordinary approvals show operation facts, with native localized states and buttons. Redacted bridge permission checks and versioned diagnostic copying improve troubleshooting without broadening automatic approval.

## 0.1.7-alpha.1.1

### 中文

- 修复已有 Devin MCP 入口命令正确、但缺失或错误配置 `ELECTRON_RUN_AS_NODE` 时，桌面端无法正常启动工具桥的问题。每次连接通过 Devin 原生命令刷新同一个 DSH 入口，不增加会话条目，也不覆盖其他 MCP 服务。

### English

- Repairs existing Devin MCP entries with a matching command but missing or incorrect `ELECTRON_RUN_AS_NODE`, which could prevent the desktop tool bridge from starting. Each connection refreshes the same DSH entry through Devin's native CLI, preserving other MCP servers without adding per-session entries.

## 0.1.7-alpha.1.0

### 中文

- 升级到 DSH `0.1.7-alpha.1`；宿主与插件需要同时升级。
- Agent 配置使用原生插件设置表单，自动导入旧配置且保留当前配置中的 Agent 列表。
- ACP 主会话流使用原生过程分组和紧凑、详细、展开模式，沿用宿主的工具分类、思考展示、折叠及间距。
- 外部子会话记录进入原生子会话目录；恢复旧记录时使用宿主的 V3 → V4 迁移。
- 对齐新版 Teams 成员状态、后台任务所有权及菜单接口。
- 修复成员管理弹层缺少原生背景模糊导致的内容穿透；识别 Devin 的完整 MCP 工具标签，让合法团队协调请求自动处理，Bash 审批展示完整命令。
- 修复会话选项提示在成员面板中偏移并产生横向滚动条的问题。

### English

- Targets DSH `0.1.7-alpha.1`; upgrade the host and plugin together.
- Uses native plugin configuration forms, importing legacy Agent settings while preserving an Agent list already configured in the current profile.
- Uses native process grouping and compact, detailed, and expanded transcript modes, including the host’s tool classification, reasoning display, disclosure controls, and spacing.
- Publishes external subagent records to the native child catalog and uses the host’s V3 → V4 migration when restoring old records.
- Adapts to updated Teams member states, background-job ownership, and menu APIs.
- Fixes text showing through the member-management popup by applying native backdrop styling. Recognizes Devin's exact MCP tool labels for team coordination and shows full commands in Bash approvals.
- Fixes misplaced session-option tooltips and the horizontal scrolling they caused inside member panels.

## 0.1.6-alpha.2.0

### 中文

- 升级到 DSH `0.1.6-alpha.2`，移除 alpha.1 兼容层；升级插件时必须同时匹配宿主版本。
- 当前会话可见的 DSH 工具自动提供给 Agent，包括宿主提供的 `present`；不再手动维护 `hostTools` 列表。
- 主会话流复用原生工具与 Bash 展示、思考摘要和工具调用分组；审批卡与会话选项菜单统一使用原生组件。
- 点击团队成员和子会话默认在侧栏打开；团队管理支持中断所有 teammate，并统一模型和模式选择器。

### English

- Targets DSH `0.1.6-alpha.2` and removes alpha.1 compatibility. Upgrade the host to the matching version.
- Automatically exposes visible DSH tools to the Agent, including `present` when available. The manual `hostTools` list is retired.
- Reuses native tool/Bash rendering, thought summaries, and tool-call grouping in the transcript, with native approval and session-menu components.
- Opens teammates and subagent records in the sidebar. Team management can interrupt all teammates and shares model/mode selectors with the main session.

## 0.1.6-alpha.1.6

### 中文

- 修复审批选项身份的保留与传递，避免显示文案影响实际批准或拒绝结果。
- 创建新文件时增加并发保护，避免覆盖在写入过程中由其他操作创建的文件。

### English

- Preserves approval option identities so display text cannot change the actual approval or rejection result.
- Protects new-file creation against concurrent writes, avoiding overwriting a file created by another operation.

## 0.1.6-alpha.1.5

### 中文

- 「添加 Agent」改为使用随插件提供的官方 ACP Registry 快照，分组显示已验证适配与未验证目录条目，并提供安装指引。
- 目录中的版本只作参考；更新目录不再因旧版本参考字段而中断已有会话。不会覆盖用户已配置的命令和环境变量。
- 修复普通 Windows 用户下 Devin 团队工具配置的文件链接处理，并调整目录菜单高度与分组。

### English

- The Add Agent menu uses a bundled official ACP Registry snapshot, separates verified adapters from unverified entries, and supplies installation guidance.
- Catalog versions are reference information. Retired version-reference fields no longer interrupt existing sessions after catalog upgrades; saved commands and environment variables remain intact.
- Improves Devin team-tool configuration links for ordinary Windows users and refines catalog grouping and menu height.

## 0.1.6-alpha.1.4

### 中文

- 支持向当前执行插话：优先使用 Agent 声明的安全注入能力，否则取消并在同一 Agent 会话续发；取消超时不盲目重发。
- 增强工具活动、文件差异和宿主工具返回内容的展示，保留原生工具链的展示信息。

### English

- Adds steering during execution, preferring an Agent's declared safe injection capability and otherwise cancelling before continuing in the same Agent session. A cancellation timeout does not trigger a blind resend.
- Improves tool activity, file-diff, and host-tool result presentation while retaining presentation data from the native tool chain.

## 0.1.6-alpha.1.3

### 中文

- 修复 ACP 文本、思考和工具活动在主会话中的交错顺序与历史回放。
- 调整团队成员卡片布局，改善模式与成员信息的显示。

### English

- Preserves the order of interleaved ACP text, thoughts, and tool activity in the main transcript and history replay.
- Refines team member cards to improve mode and member information display.

## 0.1.6-alpha.1.2

### 中文

- 修复历史会话中已中断回答的展示，不再依赖缺失的前置活动节点。
- 恢复团队管理时可通过原生会话控制器激活休眠的主会话，无需发送新提示或启动 ACP 执行。

### English

- Fixes interrupted-answer rendering when the preceding activity context is missing from loaded history.
- Restores team management through native activation of a dormant lead session, without submitting a prompt or starting ACP execution.

## 0.1.6-alpha.1.1

### 中文

- 适配 DSH `0.1.6-alpha.1`，更新会话状态与消息投影接口。
- 团队管理增加成员模型选择与状态持久化，保留主会话和成员各自的模型选择。

### English

- Adapts session state and transcript projection to DSH `0.1.6-alpha.1`.
- Adds team member model selection and persisted state, keeping lead and member model choices independent.

## 0.1.5-rc.2.5

### 中文

- 修复 ACP 流式消息分段，避免工具调用前后的文本片段被错误合并或顺序错乱。

### English

- Preserves ACP stream segments so text around tool calls is not incorrectly combined or reordered.

## 0.1.5-rc.2.4

### 中文

- 增加团队管理面板，支持查看成员状态、逐个或批量调整 Agent 模式。
- 改善团队成员审批的批量处理与会话恢复，保存模式选择以供后续运行使用。

### English

- Adds a team management panel with member status and individual or bulk Agent mode changes.
- Improves bulk handling of teammate approvals and session recovery, persisting mode choices for subsequent runs.

## 0.1.5-rc.2.3

### 中文

- 会话选项改为持续订阅更新，避免迟到的请求响应覆盖较新的模式或模型状态；运行期间禁止不适用的设置修改。
- 修复启动配置比较，并以流式哈希检查文件变更，降低大文件写入前的内存占用。
- 包含未成功发布的 `0.1.5-rc.2.2` 的修复，并修正文档兼容范围检查。`0.1.5-rc.2.2` 只有 Git 标签，没有 npm 发行。

### English

- Streams session-option updates and prevents late responses from overwriting newer model or mode state; unavailable changes are disabled during execution.
- Corrects launch-configuration comparisons and streams file hashing to reduce memory use before writing large files.
- Includes the fixes from the failed `0.1.5-rc.2.2` publication and repairs documentation compatibility checks. `0.1.5-rc.2.2` has a Git tag but no npm release.

## 0.1.5-rc.2.1

### 中文

- 适配 DSH `0.1.5-rc.2`，通过 MCP 桥接 Agent Teams 工具，包括 Devin 的团队工具配置。
- 在主会话显示成员审批请求，并对齐原生团队审批行为。

### English

- Targets DSH `0.1.5-rc.2` and bridges Agent Teams tools over MCP, including Devin team-tool configuration.
- Shows teammate approval requests in the lead conversation and aligns their handling with native team approvals.

## 0.1.5-rc.1

### 中文

- 适配 DSH `0.1.5-rc.1`，同步原生活动展示样式与精确发布依赖。

### English

- Adapts to DSH `0.1.5-rc.1`, updating native activity styling and exact release dependencies.

## 0.1.5-alpha.2

### 中文

- 适配 DSH `0.1.5-alpha.2`；设置和诊断面板复用更多原生控件，减少自定义样式。

### English

- Targets DSH `0.1.5-alpha.2` and reuses more native settings and diagnostic controls, reducing custom styling.

## 0.1.5-alpha.1

### 中文

- 适配 DSH `0.1.5-alpha.1`，同步系统提示与子代理投影接口。
- 调整 ACP 活动与回放展示，使其匹配新版宿主的数据结构。

### English

- Adapts system-prompt and subagent-projection interfaces to DSH `0.1.5-alpha.1`.
- Updates ACP activity and replay presentation for the new host data structures.

## 0.1.3-alpha.2

### 中文

- 将审计入口整理为「ACP 诊断」，区分异常、操作与技术记录，展示已记录的原因及恢复状态。
- 终端操作接入原生后台任务状态，改进停止和退出状态的可观察性。

### English

- Reorganizes the audit view as ACP Diagnostics, separating issues, operations, and technical records with recorded causes and recovery state.
- Connects terminal operations to native job status, improving visibility into stop requests and process exits.

## 0.1.3-alpha.1

### 中文

- 适配 DSH `0.1.3-alpha.2`。注意插件版本与宿主版本不完全同名，应按兼容声明选择宿主。
- 复用原生超时与会话资源释放机制，修复跨平台延迟启动错误的保留，并更新原生 UI 接口。

### English

- Targets DSH `0.1.3-alpha.2`. The plugin and host version names differ; select the host from the compatibility declaration.
- Reuses native deadlines and session disposal, preserves delayed launch errors across platforms, and updates native UI integration.

## 0.1.2-rc.1.1

### 中文

- 使用 DSH `0.1.2-rc.1` 构建与验证，同步远程接口；保留已声明的 DSH `>=0.1.2-alpha.4 <0.1.3` 兼容范围。

### English

- Builds and validates against DSH `0.1.2-rc.1`, updating the remote interface while retaining the declared `>=0.1.2-alpha.4 <0.1.3` host range.

## 0.1.2-alpha.5

### 中文

- 将宿主兼容声明调整为 DSH `>=0.1.2-alpha.4 <0.1.3`，使用精确的 alpha.5 依赖构建，并同步 RPC 错误处理。

### English

- Declares DSH `>=0.1.2-alpha.4 <0.1.3` compatibility, builds with exact alpha.5 dependencies, and updates RPC error handling.

## 0.1.2-alpha.4

### 中文

- 精确适配 DSH `0.1.2-alpha.4`，更新远程调用、会话执行和子代理投影接口，并调整活动与设置布局。

### English

- Targets DSH `0.1.2-alpha.4`, updating remote calls, session execution, and subagent projection alongside activity and settings layouts.

## 0.1.2-alpha.3

### 中文

- Agent 会话菜单中的上下文用量改用 `k` / `m` 缩写，保留小于 1k 的非零用量，避免大数字挤占空间。

### English

- Formats context usage in the Agent session menu with `k` / `m` units while preserving nonzero values below 1k, reducing space taken by large counts.
