# 更新记录 / Changelog

用户可见的变化与升级提示。发布时间、精确安装方式及校验值见 [GitHub Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases)。历史条目根据对应标签的代码差异补录；不代表重新发布了 npm 包。

User-facing changes and upgrade notes. See [GitHub Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases) for publication dates, exact installation instructions, and checksums. Historical entries were reconstructed from tag diffs; npm packages were not republished.

## 0.2.0-rc.2.9

### 中文

- 引入适配插件的开发、审阅和发布技能，根据变更范围选择验证，并明确已有证据的复用条件。
- 减少重复 CI 触发，将原生界面回归拆到三个独立 runner，并缓存依赖与浏览器下载。保留平台检查、冷安装及最终包校验；延长 npm 发布后可见性等待，避免处理延迟使 Release 提前失败。
- 继续支持 DSH `0.2.0-rc.2`。此前真实 Devin macOS Teams 冒烟中的第二次消息调用仍未解决；本版未修改该测试守卫或生产消息规则。

### English

- Add adapter-specific development, review and release skills with scoped validation and explicit evidence reuse criteria.
- Reduce duplicate CI triggers, split native UI regression across three isolated runners, and cache dependency and browser downloads. Retain platform, cold-install and final-artifact checks; allow more time for npm processing before creating the GitHub Release.
- Continue to support DSH `0.2.0-rc.2`. The earlier real Devin macOS Teams smoke failure on a second message remains unresolved; this release changes neither that test guard nor production messaging rules.

## 0.2.0-rc.2.8

### 中文

- 新增显式 Antigravity ACP runtime。工具桥仅在 MCP 身份与当前 DSH 连接的已注册工具匹配时调用宿主工具；原生权限请求继续使用 DSH 审批或固定选项卡片，用户必须明确选择并提交。
- 固定选项卡片支持键盘选择、窄屏布局和中英文；按会话保留选项，不提供自由输入。
- 修复 ACP 表单请求说明与字段说明相同时的重复显示，并对齐插件固定选项卡片的说明正文；Teams 正常加载提示不再重复显示为红色错误，切换后端时也不再重复提示历史保留信息。刷新后，已完成轮次的思考内容仍可正常展开；新回合保留现有历史活动订阅，避免历史消息不必要重绘。
- 统一 ACP 诊断与管理界面的双语文案及主题样式；成员读取失败时保留已有列表并明确提示错误，避免重复刷新。修正 Agent 目录菜单随窗口和锚点变化的定位，保留原生滚动及键盘操作。
- 修复外部 Stop 期间原生工具报告失败后，已中止调用显示为失败的问题；仅当此前观察到调用正在执行且外部取消信号有效时，将其界面状态归为取消，并保留原始 provider 失败详情。
- 在真实 macOS 环境使用官方 raw ACP server 1.3.0 和 `gemini-3.8-flash-low` 验证五阶段原生交互及 DSH MCP 续聊。具体范围见 [E2E 指南](test/e2e/README.md)；未验收 wrapper、Teams 或 Windows，也不代表完整 OAuth 首次引导。
- 继续支持 DSH `0.2.0-rc.2`。

### English

- Add an explicit Antigravity ACP runtime. The bridge invokes host tools only when MCP identity matches a tool registered for the current DSH connection. Native permission requests continue through DSH approval or a fixed-choice card that requires an explicit user selection and submission.
- Fixed-choice cards support keyboard selection, narrow screens, and Chinese and English. Choices persist per session, and free-text input is not offered.
- Fix duplicate ACP form details when the request and field descriptions match, align detail text in the plugin's fixed-choice card, keep normal Teams loading feedback out of the red error notice, and remove the redundant history-retention notice when switching backends. Completed turns' reasoning remains expandable after refresh; new turns retain existing history activity subscriptions to avoid unnecessary historical message rerenders.
- Align bilingual ACP diagnostic and management copy and theme styling. Keep the existing member list and show an error when a membership read fails, without an immediate duplicate refresh. Correct Agent catalog positioning as the window or anchor moves while retaining native scrolling and keyboard interaction.
- Fix native tool calls appearing failed when they report failure during an external Stop. Only a previously observed running call with an active external cancellation signal is presented as cancelled; the original provider failure details are retained.
- Verify five native interaction phases and DSH MCP continuation on macOS with the official raw ACP server 1.3.0 and `gemini-3.8-flash-low`. See the [E2E guide](test/e2e/README.md) for scope. The wrapper, Teams and Windows are not verified, and this does not certify the full OAuth first-run flow.
- Continue to support DSH `0.2.0-rc.2`.

## 0.2.0-rc.2.7

### 中文

- 新增默认跳过的重大版本真实 ACP 长任务手动回归，覆盖固定公开源码查阅、Teams、Ask 审批及 Stop／刷新／队列恢复，并记录测试专用预算与会话归属证据。仅增加测试和指南，不改变产品执行行为、不新增生产限额或用户操作。
- 当前 CodeBuddy 长任务记录仍有续聊摘要错误描述 Reject 结果，以及 Stop 后出现新的同命令执行请求；原因尚未定位，不能据此归因于适配器或 Agent。完整 DSH Teams、成员审批和同任务原生对照尚未签收，详见 [E2E 指南](test/e2e/README.md)。
- 继续支持 DSH `0.2.0-rc.2`。

### English

- Add a major-release, real-ACP long-task regression that is skipped by default. It covers reading pinned public source, Teams, Ask approvals, and Stop/refresh/queued-input recovery, with test-only budgets and session-attribution evidence. This adds tests and guidance only; product execution behavior, production limits, and user actions do not change.
- Current CodeBuddy long-task records still show a follow-up summary that misstates a Reject result and a new request for the same command after Stop. The cause is unresolved and is not attributed to the adapter or Agent. Full DSH Teams, member approvals, and a same-task native comparison remain unverified; see the [E2E guide](test/e2e/README.md).
- Continue to support DSH `0.2.0-rc.2`.

## 0.2.0-rc.2.6

### 中文

- CodeBuddy CLI 加入添加 Agent 时的已验证列表。对显式 CodeBuddy CLI runtime，DSH 未重启且 ACP 会话绑定不变时收到已确认的取消结果后，自动恢复用户已确认的模式；不重发已取消的输入，也不需要人工恢复。真实 CLI 检查仍限 E2E 指南记录的 CodeBuddy CLI 2.161.2、macOS、minimax-m2.7 与 controls 场景，不代表其他平台、WorkBuddy 桌面端或所有功能均已验证。
- 保留完整 ACP 配置和模式标识符，避免休眠成员把长标识符误写成相同前缀；此前已截断的标识符不会由本次更新自动还原。
- 修复会话创建期间配置更新丢失、取消后晚完成的文件 I/O 清理，以及多 SQLite 连接间的审计序号冲突。
- 精确关联委派子会话与源工具，保留独立的活动记录，并防止带分隔符的工具标识符与内容记录碰撞。
- 支持 DSH `0.2.0-rc.2`，无需新增配置或人工恢复操作。

### English

- Add CodeBuddy CLI to the verified list shown when adding Agents. For the explicit CodeBuddy CLI runtime, automatically restore a user-confirmed mode after a confirmed cancellation while the same DSH host process and ACP binding remain active. Do not resend the cancelled input or require manual recovery. Real CLI checks remain limited to the CodeBuddy CLI 2.161.2, macOS, minimax-m2.7, and controls scenarios recorded in the E2E guide; this does not verify other platforms, the WorkBuddy desktop app, or every feature.
- Preserve complete ACP configuration and mode identifiers so a sleeping member cannot write a long identifier as a matching prefix. Previously truncated identifiers are not reconstructed by this update.
- Fix configuration updates lost during session creation, cleanup of file I/O that completes after cancellation, and audit sequence conflicts across SQLite connections.
- Match delegated sessions to their exact source tools, retain independent activity records, and prevent delimiter-bearing tool identifiers from colliding with content records.
- Support DSH `0.2.0-rc.2` with no new configuration or manual recovery steps.

## 0.2.0-rc.2.5

### 中文

- 拒绝审批只拒绝当前工具；如果 Agent 随后明确取消整轮，已输出内容会保留并显示为中断，不会作为普通处理失败丢失，也不会自动重发输入或要求手动恢复。
- 对显式 CodeBuddy CLI runtime，确认取消终态后关闭旧进程；下一条输入会重新加载同一 ACP 会话，不重发已取消的输入。
- 本轮终止后拒绝新的 ACP 文件读写和终端创建请求，同时允许已有终端的输出读取、等待与清理。
- 已知边界：DSH 发送输入后立即 Stop 时，该输入可能不会保留；本版不改变宿主此行为。CodeBuddy 在 Stop 后收到新的明确输入时，仍可能请求执行先前工具；本版不消除这一厂商行为。

### English

- Rejecting an approval rejects only the current tool. If the Agent then explicitly cancels the whole prompt, preserve emitted content and show it as interrupted instead of losing it as an ordinary processing failure; do not automatically resend the input or require manual recovery.
- For the explicit CodeBuddy CLI runtime, retire the old process after a confirmed cancelled terminal result. The next input reloads the same ACP session without resubmitting the cancelled input.
- After a prompt terminates, reject new ACP file operations and terminal creation while still allowing output reads, waits, and cleanup for existing terminals.
- Known limitations: input may not be retained if DSH is stopped immediately after sending it; this release does not change that host behavior. After Stop, CodeBuddy may still request a previously issued tool when given new explicit input; this vendor behavior is not eliminated here.

## 0.2.0-rc.2.4

### 中文

- 增强 Agent 日志脱敏，补齐 JSON 凭据与 Basic 认证信息处理；限制无换行日志缓冲，超长行显示截断标记，避免截断后残留敏感值。
- 修复文件范围读取：行数与单行长度限制作用于请求的内容范围；读取前拒绝非普通文件，继续保留文件总大小限制。
- 改善审计写入可靠性：单条失败不再丢弃整批记录，写入回滚后不重复分配已预留的序号。旧活动记录迁移使用事务，冲突原始数据保留供排查，不覆盖现有记录，并确保迁移后的查询索引属于当前表。
- 恢复状态连接稳定后重置重连等待时间，避免历史断线让后续恢复持续等待最长退避时间。
- 精简中英文安装说明；GitHub Release 提供与 npm 发布包一致的预构建 `.tgz`。
- 兼容 DSH `0.2.0-rc.2`，无需新增配置或手动恢复操作。

### English

- Improve Agent log redaction for JSON credentials and Basic authentication. Bound unterminated log buffering and replace oversized lines with a truncation marker so truncation cannot expose sensitive tails.
- Apply file-read line-count and line-length limits to the requested window. Reject non-regular files before opening them and retain the whole-file size limit.
- Improve audit persistence: isolate failed records instead of discarding a whole batch, and retain reserved sequence numbers after a rollback. Migrate legacy activities transactionally, preserve conflicting original records for diagnosis without overwriting current records, and retain query indexes on the current table.
- Reset recovery-status reconnect backoff after a healthy connection, so earlier disconnects do not leave subsequent recovery at the longest delay.
- Simplify Chinese and English installation instructions. GitHub Releases now include the same prebuilt `.tgz` published to npm.
- Continue to support DSH `0.2.0-rc.2`, with no new configuration or manual recovery steps.

## 0.2.0-rc.2.3

### 中文

- 增强标准 CodeBuddy CLI 的 ACP 接入：使用 `codebuddy --acp` 启动，并将 CLI 的 Host 工具授权请求与本连接注册的工具身份关联。通过 `codebuddy` 进入交互式 CLI 登录。此支持不代表跨平台验证，也不代表 WorkBuddy 桌面端使用相同接入方式；已有自定义配置不会因 `catalogId` 被静默改成 CodeBuddy runtime。
- 对显式 CodeBuddy runtime，确认收到取消终态后（包括原生工具请求被拒绝），下一条输入前会重新加载同一 ACP 会话，不重发已取消的 prompt；刷新可能增加等待时间，不需要为这一正常路径手动进入恢复流程。
- 规范化 ACP Agent 模式展示快照：保留当前模式，模式说明最多保存 1024 个字符，并继续遵守既有快照总长度预算，避免普通目录说明使已确认的远端结果无法完成本地结算。
- 继续仅支持 DSH `0.2.0-rc.2`。真实 CLI 验证仅适用于 E2E 指南明确记录的版本、平台和模型；协议夹具不等于真实 Agent 验收。

### English

- Improve standard CodeBuddy CLI ACP integration: start its ACP server with `codebuddy --acp`, and correlate its Host tool permission requests with the tool identity registered for that connection. Use `codebuddy` to open the interactive CLI for sign-in. This is not cross-platform verification and does not imply that the WorkBuddy desktop app uses the same integration. Existing custom profiles are not silently changed to the CodeBuddy runtime based on `catalogId`.
- For the explicit CodeBuddy runtime, after a confirmed cancelled terminal result (including rejection of a native tool request), the next input reloads the same ACP session without resubmitting the cancelled prompt. Refreshing may add startup wait time and does not require manual recovery on this normal path.
- Normalize ACP Agent mode display snapshots: retain the current mode, cap each mode description at 1,024 characters, and keep the existing total snapshot-length budget. Ordinary catalog descriptions can no longer prevent local settlement of a confirmed remote result.
- Continue to target DSH `0.2.0-rc.2` only. Real CLI evidence applies only to the version, platform, and model recorded in the E2E guide; protocol fixtures are not real-Agent sign-off.

## 0.2.0-rc.2.2

### 中文

- MCP TypeScript SDK v2 工具调用的取消通知会继续传到正在执行的 DSH 原生工具。
- ACP 对话继续复用 DSH 原生消息、过程分组、工具组件与布局设置；修复菜单焦点恢复和子菜单打开时的关闭行为，统一恢复操作并发控制，并在操作结果处给出提示。
- 修复首屏活动日志加载期间的误报；保留没有可见文字、但包含工具调用的连续助手回合。
- 同一 ACP 请求中存在已成功返回的 Host 工具结果时，允许无文字的 `end_turn` 正常结束；这只确认回合终止，不代表用户任务完成。纯思考、失败工具或尚未返回的调用仍不能作为可见答复。
- 为 ACP Host 指令、模型上下文与桥接生成提示添加明确文本边界；用户原始文本块内容及其相邻关系保持不变。
- 修复 Agent Teams mailbox 输入缺少重复 request header 时的实时活动关联；按当前执行步骤的输入规则选择锚点，不借用旧步骤输入。
- 外部子代理运行期间显示实时状态；工具结束而子代理尚无终态时标记为未完成，不把工具结束误作子代理完成。真实终态按宿主外部子代理投影入口保存；无法验证来源的活动不会制造子会话。
- 将已识别的 Devin 资源或用量配额耗尽归为独立错误，并提示查看 Agent 用量限制；不自动重试，未知 JSON-RPC 错误仍按协议错误处理。
- ACP 诊断新增单击安全摘要导出，使用有界分页和字段白名单；原生完整会话导出仍是独立且可能包含敏感信息的文件。
- 已确认远端终态后的普通本地结果补存会自动重试；后续请求等待结算，不重放已完成工具。暂时的恢复状态与团队名册读取故障自动恢复，稳定错误明确显示，不把失败读取显示为空状态。
- 工具桥遵循 Host 声明的互斥与并行执行模式，并将重复工具反馈即时写入 MCP 结果；普通工具未报告终态时显示为未完成，不冒充已完成。调用方已有待收 Teams 消息时，`wait_agent` 不再阻塞等待，并提示调用方让出响应。
- 活动日志在视图订阅期间持续重连暂时读取故障。真实 Devin 测试默认使用 SWE-2，并有测试专用的 16 次 Host 工具分发上限和有界脱敏 trace；这些限制不适用于生产。
- 继续仅支持 DSH `0.2.0-rc.2`。本版的协议夹具与真实 Agent 运行属于不同验证层级；详见 E2E 指南。

### English

- Forward MCP TypeScript SDK v2 cancellation notifications to active native DSH tool execution.
- Continue to render ACP conversations through DSH's native messages, process groups, tool components, and display settings. Fix menu focus restoration and dismissal around nested menus, serialize recovery actions, and report operation outcomes.
- Fix false errors while the activity journal is loading, and preserve consecutive assistant turns that contain tool calls but no visible text.
- Treat a text-free `end_turn` as a normal stop when that same ACP prompt received a successful Host tool result. This confirms turn termination, not completion of the user's broader task; reasoning-only output and pending or failed tools do not qualify.
- Delimit generated ACP Host instructions, model context, and bridge notices for clients that concatenate text blocks, while preserving original user text blocks and their adjacency.
- Associate live activity with Agent Teams mailbox inputs when a duplicate request header is omitted, using the current step's input rules without borrowing an input from an earlier step.
- Show external subagents while they run. If a tool ends before the child has a terminal result, mark the child unfinished instead of treating the tool result as child completion. Persist verified terminal results through the host external-subagent projection entry; unverified activity does not create a subagent session.
- Classify recognized Devin resource or usage-quota exhaustion separately and direct users to check Agent usage limits. Do not retry automatically; unknown JSON-RPC errors remain protocol errors.
- Add a one-click safe-summary export in ACP Diagnostics using bounded paging and an allowlist; the native full-session export remains a separate file that may contain sensitive data.
- Automatically retry ordinary local result persistence after a confirmed remote terminal result. Later requests wait for settlement without replaying completed tools. Transient recovery-status and Team-roster reads recover automatically; stable errors are shown explicitly instead of as empty state.
- Follow Host-declared exclusive and parallel execution modes in the tool bridge, and immediately include duplicate tool feedback in MCP results. Show ordinary tools without a reported terminal state as unfinished, not completed. When the caller already has a pending Teams message, `wait_agent` no longer blocks on the wait and prompts the caller to yield a response.
- Keep activity logs reconnecting to transient read failures while their view is subscribed. Real Devin tests default to SWE-2 and use a test-only 16-call Host tool-dispatch cap plus bounded redacted traces; these limits do not apply in production.
- This release still targets DSH `0.2.0-rc.2` only. Protocol fixtures and real-Agent runs are separate levels of evidence; see the E2E guide.

## 0.2.0-rc.2.1 (2026-10-03)

### 中文

- 区分插话发送前的本地错误与远端接收结果不明，避免本地校验失败误触恢复门禁；回收失败仍释放路由和监听器。
- 明确保留 Agent 拒绝回答或达到本轮请求次数上限的结束原因，并补齐非文本回复降级、活动游标读取失败与通知监听器异常的诊断。
- 对话展示复用原生 builder、分组状态和历史节点，减少流式更新的重复渲染；清理过期活动窗口，保留最终答复的原生导航锚点，共享窗口归属不明时使用活动回退。
- 非文本思考内容保留明确的推理降级提示与诊断，不冒充可见答复；Claude 外部子代理结果超过 4000 字符预览上限时释放临时内容并显示省略提示。
- 修复 npm 包中 README 指向未打包文档的链接，并将发布工作流的 Actions 固定到已核验的提交。

### English

- Distinguish local steering failures before dispatch from unconfirmed remote acceptance, preventing local validation errors from creating a recovery gate; failed cleanup still releases routes and listeners.
- Preserve explicit Agent refusal and turn-request-limit outcomes, and add diagnostics for non-text answer fallbacks, activity-cursor failures, and notification-listener errors.
- Reuse native conversation builders, group state, and historical nodes to reduce repeated streaming renders; release obsolete activity windows, preserve native navigation anchors on final answers, and retain the activity fallback when shared-window ownership is ambiguous.
- Retain explicit reasoning fallbacks and diagnostics for non-text thoughts without treating them as visible answers; release temporary Claude child-result content and show an omission notice when it exceeds the 4000-character preview limit.
- Fix README links to documents excluded from the npm package and pin release-workflow Actions to verified commits.

## 0.2.0-rc.2.0 (2026-09-30)

### 中文

- 适配 DSH `0.2.0-rc.2` 的精确宿主契约与依赖，并将 ACP SDK 从 `1.3.0` 升级到 `1.5.1`。
- 删除重复维护的自定义模型选择器与设置开关，模型搜索、键盘导航和中文输入法处理统一使用 DSH 原生选择器。旧 `searchableModelPicker` 设置会被忽略，无需手动清理。
- 将 DSH 当前有效的运行时上下文和 Skill 目录投影到 ACP 请求，并明确提示 Agent 使用 DSH 的 Skill 入口。
- 修复已开始工具的晚到状态通知在连续助手回复中产生额外分段或空行的问题。
- 定时提问超时后仍可回答；将迟到答复送入原 ACP 会话的当前执行步骤，定时模式保持可选。

### English

- Align the exact host contract and dependencies with DSH `0.2.0-rc.2`, and upgrade the ACP SDK from `1.3.0` to `1.5.1`.
- Remove the duplicated custom model picker and preference toggle. Model search, keyboard navigation, and Chinese IME handling now use DSH’s native selector. Existing `searchableModelPicker` settings are ignored; users do not need to clean up their configuration.
- Project DSH’s current effective runtime context and Skill catalog into ACP requests, and tell Agents to use DSH’s Skill entry point.
- Prevent late state notifications for started tools from adding unwanted segment breaks or blank lines to a continuous assistant reply.
- Keep timed questions answerable after their wait expires and deliver late answers into the original ACP session’s current execution step; timed mode remains opt-in.

## 0.2.0-rc.1.0

2026-09-28

### 中文

- 适配 DSH `0.2.0-rc.1` 的插件兼容检查，宿主和插件需一同升级。
- 可搜索模型选择器的输入框样式对齐 DSH 原生 Input，菜单定位复用原生锚点边界计算。
- Devin DSH 工具识别兼容完整 `Calling/Called <tool> from dsh` 标题与完全一致的裸工具名，并保留有效的结构化 MCP 身份识别；仅有裸工具名或身份信息冲突时不自动批准。
- 新增可选定时任务 bundle 的 ACP 宿主集成覆盖，检查工具发现与提醒生命周期。
- MCP 工具目录遵循宿主当前模型请求的工具展示策略，修复 PTC 模式列出无法直调工具的问题。
- 补齐已有历史但没有模型请求记录时的跨后端切换确认；活动日志首次连接采用有限退避重试；修复删除确认中旧请求覆盖绑定会话计数的问题。

### English

- Targets the DSH `0.2.0-rc.1` plugin compatibility check; upgrade the host and plugin together.
- Aligns the searchable model picker input with the native DSH Input and reuses native anchored boundary positioning.
- Recognizes Devin DSH tools when the complete `Calling/Called <tool> from dsh` title agrees exactly with the bare tool name, while retaining valid structured MCP identity checks; a bare tool name alone or conflicting identity evidence never auto-approves a call.
- Adds ACP host integration coverage for the optional Schedule bundle's tool discovery and reminder lifecycle.
- Makes the MCP tool directory follow the host’s current model-facing tool presentation, fixing tools advertised for direct calls that PTC mode rejects.
- Confirms backend changes for historical sessions without a recorded model request, bounds initial activity-journal retries with backoff, and prevents stale requests from overwriting the bound-session count in delete confirmations.

## 0.1.7-rc.2.4

2026-09-28

### 中文

- 可搜索模型选择器的字体、行高、行间距、勾选图标和展开箭头对齐 DSH 原生选择器；保留模型搜索、推理等级切换、选择行为，以及关闭后恢复原生选择器的设置。
- 新增 DSH 工具审批策略，可按会话选择自动批准或使用原生逐项审批；新会话默认自动批准，插件详情页可更改默认值。团队成员实时继承 Lead 策略，现有待审批请求继续手动处理。

### English

- Aligns the searchable model picker’s typography, row spacing, check icon, and expanded chevron with the native DSH picker while preserving model search, reasoning-effort tabs, selection behavior, and the setting that restores the native picker when disabled.
- Adds a per-session policy for DSH tool requests: auto approve or use native approval for each request. New sessions default to auto approve, with a configurable plugin default. Team members follow the Lead’s current policy; existing pending approvals stay manual.

## 0.1.7-rc.2.3

2026-09-27

### 中文

- ACP 团队成员通过 DSH Teams 向 Lead 成功发送非空消息后，即使不输出可见文本，也会正常结束当前响应；普通无回复、纯推理、失败、取消及后续新请求仍保留原有处理。此问题由 Windows 实际运行发现。

### English

- An ACP Team member that successfully sends a nonempty DSH Teams message to its Lead may finish without visible text. Ordinary empty replies, reasoning-only output, failures, cancellation, and later admitted requests keep their existing handling. Windows live runs exposed this issue.

## 0.1.7-rc.2.2

2026-09-27

### 中文

- 维护更新：集中定义 ACP Agent 五态词表，并补充健康状态 codec 与活动回放读取的回归覆盖；运行和 wire 行为保持不变。

### English

- Maintenance update: centralizes the five ACP agent states and adds regression coverage for health codecs and activity replay parsing. Runtime and wire behavior are unchanged.

## 0.1.7-rc.2.1

2026-09-27

### 中文

- 可搜索模型选择器默认关闭；开启后可按模型名称、ID 或提供商搜索，关闭后恢复 DSH 原生选择器。
- ACP 配置入口迁至原生插件详情页，保留已有配置与设置。
- 目录菜单根据按钮位置与可用空间调整宽度、展开方向和高度，便于添加 Agent。
- 采用「互联」插件图标，并补齐插件面板与模型选择器的中英文文案。

### English

- The searchable model picker is off by default. Turn it on to search by model name, ID, or provider; turn it off to restore the native DSH picker.
- Moved ACP configuration into the native plugin detail page while preserving existing configuration and settings.
- The Agent catalog menu adapts its width, opening direction, and height to the trigger button and available space.
- Added a “Link” plugin icon and completed the plugin panel and model picker copy in Chinese and English.

## 0.1.7-rc.2.0

2026-09-25

### 中文

- 适配 DSH `0.1.7-rc.2` 的插件兼容检查；宿主与插件需一同升级。
- 审批选项名称碰撞时仍能对应到正确选项；ACP 设置与恢复操作仅作用于本适配器管理的会话，首次使用仍可正常进入。
- 加强活动记录、子会话内容和诊断日志中的敏感值脱敏，并发审计保留不同审批结果、去重重复决定。修复用量统计和文本脱敏导致子会话崩溃恢复失效的问题；已丢失的历史内容不会自动重建。
- 终端退出会进行有界清理，已断开的 ACP 连接不再作为可复用连接。取消超时或执行结果未知时，需由用户显式处理恢复；不会自动重放命令。
- 恢复操作和团队成员模型设置失败时显示本地化提示。

### English

- Targets the DSH `0.1.7-rc.2` plugin compatibility check; upgrade the host and plugin together.
- Approval labels remain mapped to the exact option when names collide. ACP settings and recovery apply only to sessions managed by this adapter; first use remains available.
- Improves secret redaction in activity, subagent content, and diagnostic logs. Concurrent audit writes preserve distinct approval decisions and deduplicate repeated ones. Fixes usage accounting and text redaction that could prevent subagent crash recovery; lost historical content is not rebuilt automatically.
- Terminal shutdown uses bounded cleanup, and closed ACP connections are no longer treated as reusable. After a cancellation timeout or an unknown execution outcome, recovery requires explicit user handling; commands are not replayed automatically.
- Recovery and teammate model-setting failures use localized messages.

## 0.1.7-rc.1.0

2026-09-24

### 中文

- 适配 DSH `0.1.7-rc.1` 的插件兼容检查与原生工具展示契约，宿主与插件需一同升级。
- 团队成员与审批读取原生共享投影，保留成员自己的请求身份与一次性授权范围。
- 跟随原生紧凑、标准、详细、完全展开四档过程展示；旧展示偏好由宿主迁移。
- 修复长期活动流累积取消监听器的问题，关闭和失败时释放订阅。

### English

- Targets DSH `0.1.7-rc.1` plugin admission and native tool presentation contracts; upgrade the host and plugin together.
- Reads team membership and approvals through native shared projections while preserving member-owned requests and once-only permission scope.
- Follows native compact, standard, detailed and verbose work-detail modes; the host migrates existing preferences.
- Fixes cancellation-listener accumulation in long-lived activity streams and releases subscriptions on close or failure.

## 0.1.7-alpha.2.1

2026-09-23

### 中文

- DSH 工具桥保留原生工具名，修复 Agent 按原生指令调用工具时名称不匹配的问题。不同团队的同名成员仍按各自连接和团队隔离；普通工具审批范围不变。
- 修复无界面宿主第二轮 ACP 续聊被错误阻止的问题。
- 外部子会话的配置、模式和用量不再覆盖主会话；切换模式或选项后立即发送，会先完成已接纳的配置写入。关闭等待中的会话不会重新启动 Agent。
- 活动流首次加载失败时保留回退展示并提示不可用，避免把尚未加载的数据当成空记录。
- Devin 注册 MCP 后核验实际生效的入口，明确报告覆盖冲突，避免连接错误的工具桥。
- 继续支持 DSH `0.1.7-alpha.2`，无需清理会话数据。更新后重启宿主并刷新页面；桌面内置版本需随新的桌面安装包更新。

### English

- Preserves native DSH tool names so Agent calls match native instructions. Identically named members remain isolated by their connections and Teams; ordinary tool approval scope is unchanged.
- Fixes incorrectly blocked second-turn ACP continuations in headless hosts.
- Prevents external child configuration, mode and usage updates from overwriting the parent. Sending immediately after changing a setting waits for admitted writes; closing a waiting session does not restart the Agent.
- Retains fallback presentation and reports unavailable activity when the initial stream load fails, instead of treating unloaded data as empty records.
- Checks Devin's effective MCP entry after registration and reports conflicting overrides instead of connecting to the wrong tool bridge.
- Continues to support DSH `0.1.7-alpha.2`; no session-data cleanup is needed. Restart the host and refresh the page after updating. Bundled desktop versions require an updated desktop package.

## 0.1.7-alpha.2.0

2026-09-23

### 中文

- 适配 DSH `0.1.7-alpha.2`，宿主与插件需要同时升级；Read/Diff 继续使用新版原生代码卡和中英文工具栏。
- 团队成员创建后及时出现管理入口；读取成员或恢复状态失败时可重试。点击成员名在原生侧栏打开，保留主会话。
- 会话设置说明运行中只读的原因；成员待生效提示可换行并保持设置行对齐，批量模式操作可查看各成员结果。
- 普通审批直接展示操作事实，页面状态和按钮由原生界面本地化；工具桥权限判断新增脱敏诊断，可复制所选记录及版本。自动审批范围不变。

- 修复 Codex 成员的 DSH 工具授权表单被宿主取消的问题：已验证且提供“仅本次”的请求可转为成员原生审批，在主会话处理，不授予长期权限。
- Devin 对当前 DSH 连接发出不存在的工具名时，直接拒绝并记录诊断，避免无效调用卡在人工审批。不会修补或执行错误请求；Agent 可重新发出正确调用。

### English

- Targets DSH `0.1.7-alpha.2`; upgrade the host and plugin together. Read/Diff use the updated native code cards and bilingual toolbar labels.
- Member controls appear as teammates are created. Failed roster and recovery reads can be retried. Member names open the native sidebar while preserving the main conversation.
- Session controls explain why settings are read-only during execution. Pending member settings wrap without clipping and stay aligned; batch mode results identify each member's outcome.
- Ordinary approvals show operation facts, with native localized states and buttons. Redacted bridge permission checks and versioned diagnostic copying improve troubleshooting without broadening automatic approval.

- Fixes cancelled Codex member approvals for verified DSH tools. Scope-only forms offering once can use the member’s native approval, handled from the lead without granting persistent permission.
- Rejects and diagnoses invalid tool names belonging to the current Devin DSH connection instead of blocking on user approval. Malformed requests are never repaired or executed; the Agent can issue a corrected call.

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
