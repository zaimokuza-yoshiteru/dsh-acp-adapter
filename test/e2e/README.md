# 原生功能回归

本目录验证 DSH 与 ACP 的集成行为。浏览器场景启动目标版本的 Loader、真实 ACP 子进程和浏览器，并加载构建后的插件与 DSH UI；源码／jsdom 场景和仅 Host 场景的范围在下文分别说明。协议夹具提供可控 ACP 输入，覆盖 UI 与宿主集成；真实 Agent 行为另由 opt-in 检查验证。Web scaffold 或 Electron 窗口中的适配器检查不等于完整桌面产品的打包、preload、升级或跨平台验收。运行真实 Agent 会使用本机登录和模型额度。

当前运行目标由 `package.json` 的 `engines.dsh` 决定。下文既有真实 Agent 记录只适用于各自记录的版本、平台和场景，不能直接作为当前目标版本的 live 验收。

文件能力分开验收：`native-parity` 的完整 Diff 场景检查 ACP 单次编辑工具卡中的原生 `DiffBlock`，不检查整轮 `ChangedFiles` 摘要；`present` 交付卡、标准 Markdown 文件链接及原生预览也是不同路径。会话流对照需另外观察首输出前、默认折叠、完成、下一次输入和恢复后的状态，不能用结束后统一展开的截图证明全过程一致。

`native-parity` 的 mixed generic / diff 两个场景使用合法 ACP 工具混合内容，检查 390px、运行中展开后完成、手动折叠与外层重置、刷新恢复。工具图片、音频和资源目前保留安全文本元信息及不能预览/打开的说明；这不是 assistant 图片附件的保存、播放或预览能力。Diff 补充正文共享原生工具折叠状态，普通工具和终端沿原生文本输出展示；危险 URI、查询凭据和媒体载荷不进入这些元信息。

较广的协议与 Teams 场景覆盖 Claude、Codex、Devin、Kimi 四种 ACP 配置。CodeBuddy 目前仅覆盖 Agent controls 与权限隔离；其目录读取由通用 catalog 测试覆盖，不包含 Teams、成员管理或其他矩阵。真实 Agent 的升级需独立检查。

CodeBuddy CLI 的真实运行检查属于本机 opt-in 验证，不纳入普通协议夹具或 CI 的通过声明。本次已完成 macOS CodeBuddy CLI `2.161.2`、模型 `minimax-m2.7` 的 Agent controls 三种场景，每种各运行两轮：Auto 自动批准并恰好执行一次工具；Ask 拒绝一次且工具执行为零；Stop 中止正在等待的工具，确认收到 abort 且无写入副作用。Ask 和 Stop 随后均以同一 ACP session 恢复，完成精确 follow-up；两种场景的 mode 与三个非模型配置值保持，workspace、模型和 MCP scope 匹配，刷新没有重新派发事件或 prompt。此结果仅覆盖记录的本机 CLI、平台、模型与 controls/权限隔离场景，不表示 CodeBuddy Teams、其他平台或 WorkBuddy 桌面应用已通过。已有配置也不会仅凭 `catalogId` 自动切换 runtime。本地 opt-in 检查不是稳定公共命令或 CI 门禁。

| 场景               | 必须保持的行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 目录         | 已验证／未验证分组、窗口内高度、手动入口及原生菜单键盘选择；添加入口不显示额外搜索框；自定义 ID 后目录身份与安装信息保留，中英文均可用                                                                                                                                                                                                                                                                                                                                                                                              |
| ACP 配置编辑       | 原生 Plugins bundle detail 中的 Input / Button；空名称禁止保存；取消不改变配置；保存后刷新保留                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 文件、消息与恢复   | 原生输入栏上传；ACP 收到文件文本句柄；主会话以 Session V4 保存 stream；刷新后消息、附件、原生 TerminalBlock 可见                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 消息分段           | 思考与回答交替、思考开头空行、不同 messageId 和工具边界；实时、停止及刷新后顺序一致；原生 Bash/工具调用及参数摘要、去重计数、折叠保留完整结尾回答、紧凑/详细/展开设置、浏览器查找展开                                                                                                                                                                                                                                                                                                                                               |
| 过程分组归属       | `activity-grouping.e2e.ts` 只驱动 scaffold 原生 assembler、Chat builder 与 ProcessState，不启动 Host 或浏览器；空 marker 不生成完成组，保留首段思考／正文／工具、真实分组结束、多 Step、恢复及路由切换语义                                                                                                                                                                                                                                                                                                                          |
| 已提交回答与通知   | `committed-replies.e2e.ts` 通过真实 inbox 排入后续通知，验证主报告在原生过程收起后仍可见，通知与正文不重复，复制归属、文件预览和刷新保持；覆盖四种展示模式、两种收起时机及 390 px 明暗布局。`DSH_E2E_REPLY_BASELINE=1` 配合 `DSH_E2E_ADAPTER_DIRECTORY` 只用于封存旧包的缺陷对照，不代表修复验收                                                                                                                                                                                                                                    |
| 原生 slot 语义锚点 | `native-slot-anchors.e2e.ts` 使用 scaffold 的真实 jsdom，不启动 Host 或浏览器；覆盖初始与晚到空 outlet、属性更新、多 owner 隔离、重挂载与卸载，保留私有注册身份及原有 DOM 层级                                                                                                                                                                                                                                                                                                                                                      |
| 工作步骤原生偏好   | `native-work-details.e2e.ts` 以构建插件和确定性 ACP 夹具验证四种展示模式 × 两种收起时机；覆盖多轮、刷新、详情重置、无伪完成组，以及原生语义锚点、空占位和实际行间距；不代表真实 Agent 或完整桌面产品验收                                                                                                                                                                                                                                                                                                                            |
| 宿主扩展           | system prompt、动态上下文与 pre-step 插件输入真正到达 ACP；插件触发的后续步骤正常运行；旧用户输入不重复发送；卸载插件后不再携带其指令                                                                                                                                                                                                                                                                                                                                                                                               |
| 图片与文件活动     | assistant 图片经原生附件存储后可刷新显示；文件读取使用原生工具输出，缺少精确总行数时保留原文；完整差异使用原生 Diff，文件名支持键盘打开原生侧栏预览；活动不会制造 DSH 工具调用                                                                                                                                                                                                                                                                                                                                                      |
| 运行中插话         | 原生队列入口；取消并排空旧执行或原子注入；pre-step 重写实际到达 Agent；输入仅记录一次，刷新保留前后输出                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 完整 Diff 与计划   | 大详情折叠时不请求正文；展开读取准确修订，失败可重试；文件尾部改动在原生 DiffBlock 可见，刷新后仍完整；未完成计划进入原生 TodoDock，完成 prompt 不伪造完成状态                                                                                                                                                                                                                                                                                                                                                                      |
| 插件工具桥         | 当前会话可见工具自动发现，经原生前后 hooks 执行；团队协调与普通工具的审批边界保留                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 故障恢复           | Agent 崩溃后提示恢复，刷新保留历史；暂时读取故障自动重连，稳定错误显示不可用并清除旧恢复操作；明确放弃远端上下文后才能建立新绑定并继续                                                                                                                                                                                                                                                                                                                                                                                              |
| 活动首次载入       | 绑定等待期间不把活动显示为空或失败；首份日志到达后展示；视图订阅期间持续重试暂时故障，稳定错误显示不可用状态                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 已知结果本地补存   | 注入一次隔离 sidecar 写入故障；已完成 Host 工具仅执行一次，当前轮保持可停止，后续输入等待补存；恢复后继续或停止均不重放工具，协议 prompt 数与模型 stream 数分别核对                                                                                                                                                                                                                                                                                                                                                                 |
| ACP 安全诊断导出   | 单击即可下载；审计和活动页遇到一次暂时读取故障后在固定快照头重试；仅产生一次下载，验证字段白名单、原始 ID 与敏感正文排除，切换会话取消旧导出                                                                                                                                                                                                                                                                                                                                                                                        |
| 团队名册恢复       | 名册读取暂时失败时不显示虚假空名册，自动重读后仍只对当前有效请求执行一次原审批动作；稳定权限或配置错误显示明确不可读状态，不自动批准或拒绝                                                                                                                                                                                                                                                                                                                                                                                          |
| 连续无文本工具回合 | 工具活动之后没有可见助手文字的回合不会丢失分段、游标或后续回合边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Agent 选项         | 创建响应或后续通知提供选项后立即显示；回答期间可查看但不能修改，停止后解锁；重连取最新状态，新会话不继承旧菜单                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web 重连           | 浏览器断网后恢复连接，无需手动刷新；历史仍在，不重复发送 ACP prompt，下一条消息可正常执行                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 原生插件详情配置   | ACP 在 Plugins inventory 的官方 bundle detail 中配置；宿主标题与版本只出现一次；自定义 SVG 正确加载；插件介绍与面板中英文切换正确；原生 Settings 不再列出 ACP；浅色、深色、窄屏、编辑表单和添加菜单均保存到 `.local/plugin-panel/`                                                                                                                                                                                                                                                                                                  |
| 原生模型选择       | ACP 动态目录使用 DSH 原生模型搜索、IME 与键盘选择；切换模型及推理等级后 ACP 后续请求使用新选择；旧设置字段不会覆盖原生控件；目录重检可恢复                                                                                                                                                                                                                                                                                                                                                                                          |
| 滚动               | 长回答连续输出后、窗口缩小时，回答末尾保持在原生会话滚动区域内                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 排队消息           | 请求在途时显示 Sending，禁止编辑、删除和 Steer；服务端接收后才允许删除，删除后不会送到 ACP                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 审批允许 / 拒绝    | 原生审批或问题卡显示操作；选择映射回原始 optionId；拒绝不产生文件副作用；不扩大授权范围                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 停止后继续         | 原生停止按钮发送 ACP cancel；当前轮次结束；下一轮仍能执行                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 模型切换           | 原生 picker 的选择传到 ACP session 配置；后续请求使用新模型                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 原生用户终端       | 原生用户终端独立于 Agent 权限；已打开终端时首次 ACP 执行正常，策略投影不关闭或替换终端，后续请求不重复修改策略                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 配置热更新         | 路由注册冲突保留原有目录、标签与可继续的 ACP 会话；修正配置后重新生效；移除 profile 后目录不残留路由                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 权限隔离           | 空会话保留原生默认权限；选模型不改写用户权限（含 Custom）；真正执行 ACP 前才应用审批策略；原生历史被拒绝切换到 ACP 时不改变权限；ACP 会话不污染新会话默认值                                                                                                                                                                                                                                                                                                                                                                         |
| subagent           | Claude / Devin 有完整证据时显示原生只读详情并可刷新；Codex / Kimi 的无证据活动不制造子会话                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 原生文件交付       | 四种协议无需工具配置，通过 MCP 自动发现并调用原生 `present`；执行 hooks、文件卡片与预览保持原生行为                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 插件生命周期       | 通过原生插件管理器在空闲与执行中禁用、重新启用；路由与客户端贡献回收并恢复，后续会话可用                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 后台任务           | ACP 创建真实进程并显示原生 jobs 列表；刷新和离线期间完成后的重连；会话隔离；成功、失败、原生 registry 取消和 ACP 取消；父轮次内提前完成也不追加模型请求；ACP 仍可读取输出                                                                                                                                                                                                                                                                                                                                                           |
| 诊断布局           | 注入 80 条真实审计记录并分页加载；可视高度与原生轨迹一致；底部滚动不移走工具栏；诊断页隐藏对话宽度拖动条；切换详情重置内部滚动；长 JSON 折叠与展开均换行；窄窗口详情可见                                                                                                                                                                                                                                                                                                                                                            |
| 诊断分类           | 默认排除正常检查点和未比较回放；超过首批原始记录的错误仍可见；原因可搜索；允许与拒绝文案明确；技术记录分页；当前恢复状态与历史错误独立展示；通过原生设置切换中文，在 Plugins detail 验证宿主版本标签及诊断分类和审批文案；旧终端缺少终止意图时保持未知原因                                                                                                                                                                                                                                                                          |
| 原生 provider 对照 | ACP 已注册时原生 provider 正常执行；原生工具经过 pre/post hooks，修改后的结果真正回到模型请求；不误发 ACP prompt                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Agent Teams        | 实际调用原生 Teams 工具；同 Agent 多模型、创建时继承模型、旧成员冷恢复保留原模型；原生名册、只读任务面板及刷新、输入框上方多成员待处理卡、折叠与新增请求展开、刷新恢复、中英文与窄屏；首轮及冷恢复审批策略；协调免额外审批、成员普通操作保留审批；成员消息和后续唤醒；成员独立模型下拉、当前／待生效模型、刷新与两次冷唤醒的实际请求头、Lead 与全局默认隔离；成员状态与真实模型、按 ACP 类型分组的模式菜单与批量入口、运行中只读、休眠成员保存模式、恢复前应用与刷新恢复；任务 CRUD、依赖与版本冲突；跨 Agent 新会话和直接 API 拒绝 |
| 主会话集中审批     | Devin 普通权限请求与 Codex 已验证工具授权表单：八个子会话的逐项与批量允许／拒绝；刷新后继续审批、批量后新审批保持待处理、中英文、窄屏；始终留在 Lead，决定写入各自子会话，新请求不被批量允许                                                                                                                                                                                                                                                                                                                                        |
| 模型目录恢复       | 四种协议检查失败保留原生失败项；断网重连后再次检查，已打开的模型菜单更新，无须切换模型；原会话历史不变且可继续对话                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 官方会话搜索       | `optional-host-tools.e2e.ts` 挂载精确官方 bundle；五工具经 ACP MCP 读取同 workspace 的真实历史，跨 workspace session ID 拒绝，当前 step 不进入搜索；此行是验收要求，实际结果以对应提交的测试输出或 CI 为准                                                                                                                                                                                                                                                                                                                          |
| 官方持久终端       | `optional-host-tools.e2e.ts` 验证六工具、跨调用 shell 状态、原生 Ask 拒绝无执行、跨 owner 读写/信号/关闭拒绝、MCP 取消后同 PTY 可继续；保留原生终端与权限所有权                                                                                                                                                                                                                                                                                                                                                                     |
| Worktree 与 cwd    | `worktree-tools.e2e.ts` 及相应单元测试验证 ACP 持久绑定的 cwd 保护、保留上下文的 session/fork；不支持 fork 时在副作用前拒绝，Stop 已知 pending 下次继续自动交接，RPC 未知结果保留门禁，不回退空白新会话                                                                                                                                                                                                                                                                                                                             |
| 官方思考翻译       | `optional-input-ui.e2e.ts` 使用 loopback 翻译 endpoint；ACP reasoning 原文保留、stream 完成后尾段翻译、原文切换、重载复用及折叠取消；沿用官方 renderer，明暗宽窄截图保存到 `.local/optional-input-ui/`                                                                                                                                                                                                                                                                                                                              |
| 官方语音输入       | `optional-input-ui.e2e.ts` 使用 Chromium 虚拟设备和模拟识别器，不下载 SenseVoice 或使用物理麦克风；真实 WAV/Remote 结果进入原生草稿，用户发送才进入 ACP prompt，覆盖取消、草稿保护和权限 composer 共存；该 Voice 用例明确跳过 Electron                                                                                                                                                                                                                                                                                              |
| 官方 Ralph         | `ralph.e2e.ts` 沿官方 workflow/spawn 创建 fresh ACP 子会话，核验无父历史、仅上轮有界 handoff、真实子会话 MCP 的 structured_output 与取消排空；父 Ralph 调用由测试直接经原生 tools.execute 发起，无真实模型                                                                                                                                                                                                                                                                                                                          |

`product-controls.e2e.ts` 验证无成员时隐藏入口、ACP 元数据读取失败时保留原生名册与重试、主会话仍运行时新增成员入口、键盘焦点和点击成员名打开原生侧栏；保留主会话地址。团队设置提示允许换行，不能以固定卡片高度断言要求截断文案。

Teams 专项：`pnpm test:e2e test/e2e/agent-teams.e2e.ts test/e2e/teams-boundaries.e2e.ts test/e2e/team-approvals.e2e.ts test/e2e/team-management.e2e.ts test/e2e/team-model-selection.e2e.ts`。真实 Teams 冒烟沿用已授权的 Agent 登录与便宜模型选择，额外设置 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_TEAMS=1`，运行 `test/e2e/live-agents.e2e.ts`；可以用 `DSH_E2E_LIVE_PROFILES=devin` 限定单个 Agent。真实断言必须观察到宿主创建成员、传递消息和完成有依赖的两项共享任务：成员领取并完成计算，Lead 领取并完成复核；任务负责人和原生面板也必须一致。模型口头声称成功不能通过。

真实双模型检查增加 `DSH_E2E_LIVE_TEAMS_MULTIMODEL=1 DSH_E2E_LIVE_PROFILES=devin`，分别使用 SWE-1.7 Medium 与 GPT-5.4 Mini Low 创建成员。`DSH_E2E_RETAIN=1 DSH_E2E_BROWSER_CHANNEL=chrome` 打开并保留随窗口大小自适应的本机 Chrome；该模式要求只选一个 Agent，完成断言后暂停测试退出，不能作为 CI 完成信号。实例地址、重新打开所需的 `authenticatedUrl` 与专属停止文件写入仅当前用户可读写的 `.local/e2e-live-teams/review-instance.json`；其中登录链接仅供本地查看，不要分享。需要关闭时创建其中的 `stopFile`，才会清理对应宿主和浏览器。

`DSH_E2E_LIVE_TEAMS_APPROVAL=1` 额外创建一个真实新成员，验证其初始 DSH 审批策略保留原生委派的 `never`。为了单独验证原生 DSH 工具的沙箱升权，测试夹具只在指定文件写入命令准入时显式设置原生 `ask` 与只读沙箱；这不是生产默认行为。测试直接在主会话的成员卡上点击“允许一次”，核对原生 `approval/asked` 与 `approval/decided` 均归属子会话，批准前无文件副作用、批准后产生临时文件，且页面始终停留在主会话。建议限定 `DSH_E2E_LIVE_PROFILES=devin`；模型不可用时，通过 `DSH_E2E_LIVE_DEVIN_MODEL` 指定当前目录中的精确 ID。

ACP 自有工具的审批另行验收：原生委派的 `never` 继续约束 DSH 工具，ACP 请求通过原生审批卡回答，并在 Sidecar 保留独立审计。对应回归核对实际问答、请求与决定的关联及后续执行，不要求这条路径生成原生 Session 的审批事件；不能用上述原生 DSH 升权专项替代 ACP 自有工具审批验收。

RC 的原生 Teams 名单从成员的 `modelSelection.next` 显示下次选择；这与已经执行的模型不同。多模型执行以成员持久化的 `request/header` 为准，ACP 管理控件区分当前与待生效模型。本插件不复制原生面板或修改宿主展示数据。原生完成通知中的 reasoning 展示与成员详情分别验证。

二元一次性集中审批调用子会话原有 pending approval 的回答接口；原生或 ACP 父会话均可使用，不依赖 Teams 开启。Host 核实存活 runtime 的逐层 ownership 与来源路径权限，排除普通独立分支和只读外部子任务投影，并保留原生委派的 `never` 策略。完整多作用域权限请求由原生 root 问题卡代呈，原始 option ID、执行身份和决定记录仍归属子会话；不会缩成一次性选项，也不参与批量允许。普通子会话提问和计划仍保留上游 `DELEGATED_CALLER` 边界。Codex 仅在已核实当前 DSH 工具身份、表单只包含 `persist` 时进入权限专用路径：唯一 `once` 选项使用原生一次性审批，多选项完整代呈。`team-approvals.e2e.ts` 显式设置 `MOCK_TEAM_APPROVAL_ONCE_ONLY=1` 验证原有批量路径；其通过不能替代完整选项专项验收。

Teams 只在原生 profile 提供服务与九个成员工具时接入；调用仍经过 DSH ToolRuntime 的 hooks 和校验。HTTP/stdio 服务、临时能力地址随会话生命周期撤销。为兼容包括 `3000.3.27` 在内的 Devin 版本，适配器通过 `devin mcp add` 注册固定的用户级 `dsh` stdio 入口。每个进程通过环境变量绑定独立会话能力，退出后能力撤销，用户级入口保留；无需文件链接。Codex 通过关联工具调用的 MCP 审批表单选择仅本次允许；Kimi 只接受当前连接的完整工具标题。这些兼容处理均不放行普通表单或其他工具。

## Fork 与通用子会话审批专项

`fork-approval-contracts.e2e.ts` 使用构建插件、目标 Loader、确定性 ACP 子进程与浏览器，不读取 Agent 登录或调用真实模型。普通分支场景核对继承历史、ACP dispatch 和错误：未声明 fork 时拒绝；声明 fork 但拒绝源会话时保留失败，两者均不得回退 `session/new`。这不表示原生菜单已经隐藏或 DSH 分支记录不会先创建；完整目标路由解析、菜单与创建前能力预检仍需上游接口支持。`subagent_fork` 的 guard 仅提前拒绝明确 ACP 目标且父会话已有完成历史并正在运行的调用，不根据父会话类型隐藏整项工具。显式原生目标、未知默认路由、scope 本地同名工具、PTC 调用与最终准入边界另由 `fork-tools.spec.ts`、`profile-adapter-fork.spec.ts` 覆盖。

同一专项通过原生 spawn 建立受管 ACP 子会话，分别使用原生与 ACP 父会话且关闭 Teams，核验父页面审批、刷新、390px 明暗布局、批准前无副作用、决定归属子会话、原始 carrier 只结算一次及原生 `never` 不变。root 选项场景在原生问题卡选择原始授权 ID；多作用域子请求场景核对父页面原生选项、原始授权 ID 与子会话审计归属。该专项不认证完整桌面产品或真实 Agent 的能力。

```sh
pnpm test:e2e test/e2e/fork-approval-contracts.e2e.ts
# 仅用于封存旧包的缺陷对照；不作为修复验收
DSH_E2E_FORK_APPROVAL_BASELINE=1 \
DSH_E2E_ADAPTER_DIRECTORY=/absolute/path/to/archived-plugin \
pnpm test:e2e test/e2e/fork-approval-contracts.e2e.ts
```

`live-managed-approval.e2e.ts` 默认跳过，需要明确启用本机真实 Devin。两项测试均使用隔离 Host/workspace 和精确模型 `swe-2-high`，不回退其他模型。子会话测试使用脚本化原生父模型和真实 `devin acp` 子会话，关闭 Teams，要求通过 DSH MCP write 写入临时 marker，核对真实请求、父页面一次允许、文件内容及子会话原生 `never`；父模型不参与真实推理。根会话测试核对原始授权选项全部出现在原生问题卡中，选择一次授权后精确返回其 option ID，并检查文件内容。子会话实际发出多范围授权时，在父页面原生问题卡选择一次授权，并核对展示选项数量与原始请求一致，不将取消或缩减选项记作通过。Devin 使用本机已有认证并消耗模型用量；可通过 `DSH_E2E_LIVE_DEVIN_ENV_KEYS` 传入逗号分隔的显式环境变量名。

```sh
DSH_E2E_LIVE_MANAGED_APPROVAL=1 \
pnpm test:e2e test/e2e/live-managed-approval.e2e.ts
```

上述专项证据写入 gitignored `.local/fork-approval-fix-20261021/`：协议对照分别使用 `before/` 与 `after/`，真实子会话使用 `live/<run-id>/`，真实根会话使用 `live-root/<run-id>/`。每次运行独立核验其结果；保留截图或文件不能代替请求、决定与实际副作用的断言。

`parent-permission-options.e2e.ts` 使用真实 Loader、浏览器和确定性 ACP 子进程，覆盖原生／ACP 父会话、完整七选项、刷新、父自身问题与两个子请求并发、取消后的迟到答复，以及嵌套受管子会话。宽屏截图与请求／副作用对照保存在 `.local/parent-approval-20261021/`；协议夹具不代表真实企业策略验收。

```sh
pnpm test:e2e test/e2e/parent-permission-options.e2e.ts
DSH_E2E_PARENT_APPROVAL_BASELINE=1 \
DSH_E2E_ADAPTER_DIRECTORY=/absolute/path/to/archived-plugin \
pnpm test:e2e test/e2e/parent-permission-options.e2e.ts
```

`live-parent-permission.e2e.ts` 默认跳过，显式启用后使用本机 Devin、精确模型 `swe-2-high` 与隔离 marker 文件。原生父使用脚本化控制，子会话是真实 Devin；验证 Ask／Auto 下完整选项、刷新与嵌套并发取消，并在临时项目配置中核验显式 Deny 不被转成批准或替代工具写入。项目 Deny 不是企业管理策略。旧包对照分别核对 Ask 子请求被取消、Auto 未经人工选择执行。测试不改变企业策略，也不能用非企业账号证明企业 Ask／Deny 已生效。

```sh
DSH_E2E_LIVE_PARENT_PERMISSION=1 \
pnpm test:e2e test/e2e/live-parent-permission.e2e.ts
# 同输入旧包对照；成功表示已复现旧行为
DSH_E2E_LIVE_PARENT_PERMISSION=1 \
DSH_E2E_PARENT_PERMISSION_BASELINE=1 \
DSH_E2E_ADAPTER_DIRECTORY=/absolute/path/to/archived-plugin \
pnpm test:e2e test/e2e/live-parent-permission.e2e.ts
```

## 运行

宿主目标读取 `package.json` 的 `engines.dsh`。常规开发、构建和发布直接使用锁定的 npm 依赖；浏览器 E2E 单独复用准确源码标签的 Web scaffold，默认目录为 `<工作区>/dsh-acp-adapter/` 与 `<工作区>/reference/deepseek-harness/`。以下命令从插件根目录执行，宿主路径因此是 `../reference/deepseek-harness/`。`DSH_UPSTREAM_CHECKOUT` 仅定位 scaffold，不会替换 npm 依赖或改写 node_modules。正式 npm 宿主安装检查使用开发依赖中的 CLI 和临时 DSH_HOME：`node scripts/install-gate.ts --tgz <本地插件包>`。

```sh
# reference/deepseek-harness 必须检出以下命令输出的标签
node --input-type=module -e 'import { DSH_SOURCE_TAG } from "./scripts/dsh-target.ts"; console.log(DSH_SOURCE_TAG)'
# 在各自目录使用 packageManager 指定的 pnpm（宿主 11.28.5，插件 10.7.0）
# 与 CI 一致，使用官方产物链；包项目经过类型检查，上游测试/脚本聚合程序不在此范围。
(
  cd ../reference/deepseek-harness &&
  corepack pnpm install --frozen-lockfile &&
  corepack pnpm run build:artifacts &&
  corepack pnpm --dir apps/web exec playwright install --with-deps chromium
)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm typecheck` 检查产品源码、单元测试、开发/发布脚本和模拟 Agent；`pnpm typecheck:e2e` 单独检查本目录中的测试，并从所选宿主源码提取测试接口声明。`pnpm test:e2e` 会先执行该检查，再运行所选场景。开发脚本和模拟 Agent 使用 Node 原生运行可擦除类型的 TypeScript，无需预编译。

目录重检与宿主指令交付可单独运行：`pnpm test:e2e test/e2e/probe-refresh-health.e2e.ts test/e2e/host-instruction-delivery.e2e.ts`。前者让真实 ACP 测试子进程在外部登录状态变化后拒绝新探测，核对模型保留、原会话续聊、设置页诊断和重新检查恢复；仅提前老化缓存时间戳，避免等待十分钟。后者从原生输入栏发送及插入消息，核对未变指令去重、运行中替换，以及旧轮次先结算、插话后被拒绝时的普通消息补发；协议文件门控和持久化结算状态决定顺序，不靠固定延时触发竞态。

比较修复前后时，使用相同的测试源码、DSH 目标与源码 scaffold，分别设置 `DSH_E2E_EVIDENCE_LABEL=before` 和 `after`。协议记录、界面截图、原生事件与浏览器 trace 只写入 gitignored `.local/probe-refresh-health/` 和 `.local/host-instruction-delivery/`。这些场景不读取用户认证或调用真实模型，不能据此声明某个真实 Agent 或 Windows 桌面产品已验收。

锁定宿主的 `build:artifacts` 生成 Host、client 与 Web 可运行产物，不能代替上游完整类型门禁；需要检查上游测试/脚本聚合程序时，在最新产物之后单独运行 `build:check`。后者不重建、不验证已有产物的新鲜度。只修改插件测试时，无需重复构建未变的官方 scaffold；共享本地 checkout 的构建、打包与 Host/browser 测试仍须串行。

普通 CI 将全部协议夹具分配给三个独立 runner，片内仍串行且不重试。`scripts/e2e-shards.ts` 从实际文件清单生成分组，新增 `.e2e.ts` 自动纳入；较大的 native parity 夹具按 Claude、Codex、Devin、Kimi 分配，各 profile 恰好运行一次。三个分片全部成功才通过原有 Native UI 必需检查，opt-in 真实 Agent 场景继续按原规则跳过。`node scripts/e2e-shards.ts` 可查看完整分配；`pnpm test:e2e --ci-shard 1/3` 可顺序复现某片，该模式不接受额外文件或名称过滤。默认 `pnpm test:e2e` 仍运行完整清单。依赖 store 与 Chromium 缓存只保存下载内容，Host 每片仍从准确源码标签构建，不复用用户 profile 或认证。

`DSH_UPSTREAM_CHECKOUT` 可指定其他源码目录。`pnpm test:e2e -t 'claude'` 可只运行一种协议夹具。默认使用 Playwright Chromium；`DSH_E2E_BROWSER_CHANNEL=chrome` 可使用本机已安装 Chrome。`DSH_E2E_NODE` 可指定宿主支持的另一份 Node 运行时，但原生依赖必须针对该 Node ABI 构建。插件构建与常规测试仍遵循 `.nvmrc`。

`DSH_E2E_ELECTRON=/绝对路径/Electron pnpm test:e2e` 将同一组场景运行在真实 Electron 窗口中，使用独立临时用户目录，以及与桌面端一致的 sandbox、contextIsolation 和禁用 nodeIntegration 设置。它覆盖适配器在 Electron 中的渲染、交互和宿主通信，不替代桌面仓库对打包、preload、专有协议、升级和跨平台成品的测试；不支持保留窗口模式。

测试使用临时工作区和独立 DSH_HOME，结束后销毁浏览器、Agent 进程与测试目录。失败截图写入 gitignored `.local/e2e-failures/`。断言使用原生组件的数据标记及可访问名称，不依赖 CSS 哈希、整页像素截图或真实模型措辞；默认不重试失败测试。浏览器回归期间不要并行运行 build、pack 或默认安装检查：prepack 会清理并重建共享的 `lib` 目录；应按顺序执行，或向安装检查传入已生成的 tarball。

当前验证版本的 `dsh-client-store` Node 入口仍引用 `zustand`、`immer`，但上游只将它们声明为开发依赖。本项目暂时精确声明这两项 devDependencies，供普通 Node 测试加载真实 Store；浏览器继续使用宿主模块表，插件运行时 dependencies 不增加。上游修复 Node 入口依赖闭包后可移除该补偿。

依赖声明通过一致性检查。发布时 `npm pack` 的 prepack 执行类型检查、测试和构建，再由安装门禁验证同一个 tarball。

CI 的产品命令以普通用户运行。Windows hosted runner 的管理员身份仅用于准备独立普通账号及目录权限；安装、类型检查、测试、构建和打包交给该账号执行。macOS / Windows 使用同版本真实 Devin 检查配置发现和固定 MCP 入口，无需登录；需要凭据的调用工具及创建 teammate 由独立 `Real Devin integration` 工作流验证。Linux/macOS 检查实际 UID 非 root；浏览器依赖和系统沙箱准备可使用 sudo。这些检查不替代 Windows 桌面安装包的完整验收。

模式菜单回归会采集浏览器 trace，成功时丢弃，失败时与截图、页面文字、执行阶段和控制台错误一起保存在 `.local/e2e-failures/`。CI 自动上传该目录，保留 7 天；可用 Playwright `show-trace <文件.trace.zip>` 查看。此采集仅用于无密钥协议夹具；trace 含临时宿主的页面和网络数据，分享前仍需检查。

## 真实 Agent 冒烟

`test/e2e/long-conversation.e2e.ts` 默认的 12 轮是确定性 scripted ACP/Native composer 负载与渲染回归，不代表真实模型长会话。100 轮 opt-in 分支会在同一会话重新加载后验证分页、历史渲染与续聊持久化。它们都不能替代下面的真实 Agent/Teams 验证。

以下浏览器真实连接测试默认跳过，不在普通 CI 中运行；带凭据的 Devin 专项见独立 `Real Devin integration` 工作流。明确授权使用现有 Agent 登录和模型额度后，可执行：

真实运行证据只适用于对应 Agent、模型、认证与当次宿主环境。协议夹具通过不代表真实 Agent 通过；普通 live smoke 也不构成 Agent Teams 的真实运行签收。仓库既有的短程真实 Devin CI 集成只覆盖其自身范围；复杂 Teams、长任务及原生对照的实际结果见[重大版本的真实长任务回归](#重大版本的真实长任务回归)，不能由短程集成或协议夹具推定通过，也不能据此声称当前新 head 已通过。实验性本机审计不作为稳定公共命令或 CI 门禁。不要据此推断完整桌面安装包已经验证。

```sh
DSH_E2E_LIVE=1 DSH_E2E_LIVE_PROFILES=codex pnpm test:e2e -t 'live ACP smoke'
```

测试从实际目录选择预设的小模型：Claude Haiku、Codex Mini / Spark、Devin SWE-1.7 Medium / Mini Low / Flash、Kimi Coding。没有匹配项就失败，不回退到默认模型；可用 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定精确 ID，例如 `DSH_E2E_LIVE_DEVIN_MODEL=swe-1-7-medium`。模型别名仍使用该 Agent 已配置的服务路由。

每个 Agent 在独立临时工作区的同一会话接收两条无工具请求；第二轮更新宿主指令中的随机标记，验证新指令到达模型、原生 stream 落盘，以及每轮刷新恢复。`DSH_E2E_LIVE_PROFILES=claude` 可限定 Agent；结果、实际模型目录和成功截图写入 gitignored `.local/e2e-live/`。测试会向配置的模型服务发送测试指令、宿主指令与临时工作区元数据，不把项目文件作为输入。登录或网络失败会使测试失败。这组真实连接冒烟不代替上面的工具、审批和 jobs 协议回归。

若 Agent 通过环境变量认证，需要显式指定要放入临时 ACP profile 的变量名，例如 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`。测试只读取列出的变量，值不写入测试结果；临时 profile 随宿主清理。生产环境同样需要在连接设置中显式配置凭据，父进程密钥不会自动继承。

独立的 `Real Devin integration` 工作流仅接受手动触发，并要求显式勾选 `allow_model_usage`；推送、合并和发布不会自动启动它。该专项会使用真实 Devin 创建两个 Lead 和两个 teammate，并验证消息往返及后续响应。普通 CI 中无凭据的 MCP 配置发现不调用模型，不属于这项带凭据验证。若本轮不使用 Devin 账号或额度，不触发该工作流，并显式设置其他 live 测试的 profile；未过滤的 `live ACP smoke` 会包含 Devin。要在本机运行 Devin 专项，先完成依赖安装与 `pnpm build`，再在当前 shell 临时提供 `WINDSURF_API_KEY`，执行：

```sh
DEVIN_TEST_MODEL=swe-2-high node scripts/check-devin-live.ts "$(command -v devin)"
```

`DEVIN_TEST_MODEL` 未设置时默认为 `swe-2-high`（SWE-2）；显式空值或当前 Devin 模型目录中不存在的 ID 会在发送 prompt 前失败，不会回退到任意目录项。可用它指定目录中另一确切模型。真实运行会产生 Devin 服务用量，费用与可用额度按运行时账户套餐和当前计费条件为准；运行前请自行核对。脚本有专用的 16 次 Host 工具分发准入上限，角色违规或超限调用会在 Host 工具函数执行前拒绝并取消该轮；此预算只保护该测试，不限制模型 token 生成或 Devin 原生工具使用，也不是生产限额。4 分钟模型交互计时从首个 Lead prompt 发出前开始，到期会请求取消本地 ACP turns；远端已经开始的请求仍可能继续结算。单阶段等待最多 90 秒。启动准备和关闭时间不计入模型交互计时。脚本将 HOME、XDG 目录与 DSH profile 指向临时目录，不改 Devin 的用户级配置。Actions 为 macOS 和 Windows 普通用户步骤固定同一模型；Windows 启动器会显式把该值传给凭据登录的普通用户进程。

2026-10-18 的[真实 Devin CI 运行](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/39097343182)在 `main@943e4d6`、DSH `0.2.1-rc.2`、Devin CLI `3000.11.3`、`swe-2-high` 下通过 `macos-15` 和 `windows-2022` 两个平台。Windows 使用普通账户 `dsh-acp-ci`，测试时关闭开发者模式，结束后恢复设置、撤销目录权限并删除账户与临时目录。两平台均验证两个并发 Lead 各创建一个真实 teammate、团队隔离、消息接收后回复和同会话显式续聊，输出 `LIVE_TEST_PASS`，且安全 trace 的最终结果及清理均通过；这是短程原生 Teams 验证，不代替 Windows 桌面安装／升级、审批拒绝、Qwen Code 或长任务 B 的验收。

同日的[旧版 Devin `3000.3.27` 补验](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/39097845881)保持相同 main、DSH 和模型，macOS 通过，Windows 未通过。Windows 的原生 MCP 发现与注册、两次成员创建和首次消息发送已通过，随后同成员再次发送相同消息，被测试专用 `LIVE_TEAMMATE_MESSAGE_BUDGET_EXCEEDED` 守卫在工具执行前拒绝，该次完整 Teams 与显式续聊未验收；普通账户的四项清理均成功。现有证据不能区分模型新请求与 CLI 重试，不能据此认定工具桥重放；保留本次失败。

随后在 `v0.2.1-rc.2.2@8756e13` 的[单次真实复测](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/39100744366)中，继续使用 Devin `3000.3.27`、DSH `0.2.1-rc.2` 和 `swe-2-high`：两平台的成员创建、各一次发送、Lead 接受与回复、显式续聊均通过，`scenarioResult: pass`、各四次工具准入且无拒绝，没有复现重复；Windows 四项清理成功。工作流仍失败，因为新增历史采集器在两平台均报 `unsupported/schema-unavailable`，未取得历史父子链。业务通过不替代采证成功，也不证明此前的间歇性重复已修复。

历史采集修复后的[真实运行 `39101252210`](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/actions/runs/39101252210)使用 `b5d6019`，生产输入与上述发布标签一致，只改测试采集和说明，CLI／DSH／模型保持相同。两平台的业务与采证均通过：各四个测试会话、两次发送和两条对应工具结果，发送参数／正文 HMAC 与 Host 准入、Lead 接受对齐；额外快照有明确计数。两成员对应工具结果节点后的新生成均未再次发送，原有续聊、预算、诊断与清理通过；没有复现此前间歇性重复，不能据此宣称其根因已消除。

每个 live 测试会尝试在 `DEVIN_LIVE_TRACE_DIR` 写入一个 `real-devin-live-<24位十六进制>.jsonl`。CI 只从专用 `devin-live-diagnostics` 目录上传这类文件，保留 7 天；文件包含每次运行独立密钥 HMAC 处理的关联 ID、固定枚举、布尔值和数字，不含原始消息、prompt、参数、凭据、stdout、stderr、profile、transcript 或 Devin CLI 原生日志。Windows 普通用户先写入审计临时目录，启动器在删除该目录前复制符合文件名的 trace 到 runner 专用目录。工作流级硬超时或 runner 被强制终止时，`always()` 上传步骤也可能没有机会执行，因此不能保证每次运行都有 artifact；缺少文件时 CI 会显示 warning。

后续诊断在 Agent 进程退出后、隔离目录删除前，通过本轮 sidecar binding 精确选取合成测试会话，从 Devin 本地 SQLite 提取发送调用、工具结果与后续生成的关联事实。读取在无环境变量的独立 worker 中执行，最多 5 秒，并限制数据库、节点与投影字节；仅现有安全 trace 中的 HMAC、枚举、计数和布尔值进入 artifact。`historyReceiptStatus: stored` 表示 CLI 历史保存了对应工具结果，不等同传输层实时确认；只有实际父节点、调用与不同生成请求 ID 都匹配时，才能认定某次重复来自后续生成。路径、schema 或关联不可用时单独记录诊断失败；`scenarioResult` 与 `historyCaptureComplete` 分别描述业务场景和采证结果，不用一项替代另一项。

同一工具调用可能有多个历史快照；仅当 call ID、生成请求、完整参数及父节点一致，并由唯一工具结果指向其中一个快照时，采集器才选择该父节点关联结果。全部节点的安全标识仍输出，额外快照数记为 `historyDuplicateSnapshotCount`。不同请求或参数等歧义记录明确原因，不合并为一次调用；不同 call ID 的后续生成仍逐条保留。这只处理测试证据，不改变生产调用或准入规则。

查看 trace 时需区分事件层级：`run/start` 与 `run/summary` 描述一次检查，`phase/completed` 描述一个阶段完成，tool 事件描述单次工具分发或结果。`test/assertions-passed` 只表示脚本断言通过；终态还要求 trace 完成写入且进程输出 `LIVE_TEST_PASS`。ACP call、团队 message、step 和 prompt 是不同对象，不能把数量互相当作对方的数量。Host 的工具调用 ID 与成功 `send_message` 返回的 messageId 通过 trace 中显式记录的关联字段连接，不能靠相邻日志行推断。ACP provider 内部发出的模型请求数量及传输重试可能不可观察；`context used` 是上下文使用量，不是计费 token 数。

诊断日志只覆盖启用后的运行；离线检查不能替代真实端到端验证。之后生成的 trace 无法还原既有运行中调用数量的成因。脚本中的工具准入预算只约束该测试，不保护生产环境。

Claude 使用 DeepSeek 等第三方服务时，应同时核对 `ANTHROPIC_BASE_URL`、认证变量及模型映射，并通过 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS` 传入所需配置。模型目录可返回不代表生成已认证，模型别名也不能证明实际供应商。遇到意外 OAuth 报错时，先检查临时 profile 的有效路由和认证配置，再判断是否需要登录。

真实运行中插话使用 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_STEERING=1`，可用 `DSH_E2E_LIVE_PROFILES=codex,kimi,devin` 选择已登录的 Agent；模型仍通过对应的 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定。该专项先等待真实首段输出，再经原生 `agent.steer` 插话，验证一个 turn、两个 step、两条持久化输入与刷新后的追加回复。它不操作文件或工具。普通两轮宿主指令测试、Teams 测试与插话测试分别记录，不能互相替代。

## 版本迁移的补充验证

Persistence 替身使用真实 `SessionHandle` 类型，分别覆盖 `detached` 与 `shared-frozen` 读取结果。新投影的空 stream、内容或 usage 不匹配必须报冲突；不会因恢复接口放宽验证而放过损坏记录。进程测试通过宿主句柄确认托管范围退出；命令已结束或 provider 观察失败仍需清理。版本探针失败返回空版本，terminal 清理无法确认时允许重试；只有明确的启动 ENOENT 才可回退到 shell，取消后不再启动回退命令。

`test/unit/host/external-subagent-projector.spec.ts` 覆盖写句柄释放、flush 失败、前缀续写和重复投影。新投影写入当前 Session V4，stream 使用上游 accumulator；已有 V3 投影先校验原始事务摘要，再经官方 V3 → V4 reader 迁移。时间表示结果被观察到的时间，不补造外部 Agent 的 token 时间线。不支持的历史格式保留原日志与 sidecar，不阻塞新投影。写句柄使用原生异步释放，flush 或释放失败均不能发布完成状态。退出宽限为零时仍在下一次定时器触发后终止等待，不使用宿主 deadline 的零值（禁用超时）语义。

ACP v1 没有 system 角色；宿主指令通过带标注的请求上下文传递，无法强制它高于外部指令。活动归属使用稳定的 ACP 会话／轮次标识和原生 Step data，不再依赖迁移前的事件序号。系统指令覆盖从历史首条 system message 读取、A → B 更新和清空；ACP 不声明它无法原样支持的 in-history system 更新能力。

ACP 与 DSH 的桥接边界见[原生复用说明](../../docs/native-reuse.md)；工具桥回归验证其通过 ToolRuntime 和 hooks 执行 DSH 工具。

真实主信息流专项：`DSH_E2E_LIVE_STREAM=1 DSH_E2E_LIVE_CODEX_MODEL=<已选择的模型> pnpm test:e2e live-main-stream`。在隔离工作区让真实 Codex ACP 执行一次 `printf`，验证原生 Bash、调用计数、结果详情及刷新恢复；不读写用户文件。需要本机已有登录，会消耗该 Agent 的用量，默认跳过。

### Qwen Code

真实 Qwen Code 专项需要官方 `@qwen-code/qwen-code`（命令 `qwen`）；千问桌面应用或 `@qianwenai/qianwen-cli` 的 `qianwen` 命令不提供此 ACP 接口。专项默认跳过：`DSH_E2E_LIVE_QWEN=1 DSH_E2E_LIVE_QWEN_COMMAND=/absolute/path/to/@qwen-code/qwen-code/cli-entry.js pnpm exec vitest run test/integration/process/qwen-live.spec.ts`。可用 `DSH_E2E_LIVE_QWEN_MODEL` 指定当前会话目录中的精确模型 ID；每个新会话在首个 prompt 前校验并选择，缺失或空值即失败，未设置时沿用原行为，不修改用户 CLI 默认配置。它不经过浏览器与 Host，直接驱动 `AcpSessionRuntime`，在临时工作区验证 `ask_user_question` 问答、后台 shell 任务完成后承接 `_qwencode/start_turn` 轮次，以及无整轮终态标记的 `cron` 输出进入结果未知、保留输入不派发的路径。未知／缺失原因和 hold 丢失的确定性负向场景由协议夹具覆盖；不能用模型自述或快照空闲替代终态。Agent 进程只继承系统基础变量和 `DSH_E2E_LIVE_QWEN_ENV_KEYS` 显式列出的变量；Qwen 使用本机已有的认证配置，会消耗所配置模型服务的用量。协议回归见 `test/unit/runtime/session-runtime-qwen.spec.ts` 与 `test/fixtures/fake-qwen-agent.mjs`。

2026-10-18 的 macOS arm64 实测使用官方 Qwen Code `0.25.2`：后台 shell 完成后承接已有轮次并返回 `end_turn` 通过；另一次精确参数的 `cron_create` 已确认创建、触发并承接 `CRONFIRED` 输出，随后因上游缺少整轮终态，以 `ACP_PROTOCOL_ERROR / missing-terminal` 保留结果未知，不能记为 cron 成功完成。该次 cron 运行记录了公开模型配置快照 `qwen3.6-plus(openai)`，并非每个内部请求的模型路由证明；后台测试没有独立模型快照。先前一次未观察到 cron 唤醒的失败仍保留，不能据后一次结果补猜其原因。真实问答本轮未运行，Qwen Code 的真实 Windows 验证仍待补充；这些结果不扩展到所有 Qwen 服务、平台或浏览器界面。

Qwen 的无密钥 Host 与界面回归独立于上述 live 检查：`pnpm test:e2e qwen-code` 通过真实 Loader 加载构建插件，验证原生问答卡的单选、多选、自定义、翻页、取消和 Host cancellation，以及模型切换后的推理目录和实际 ACP 配置值。它使用确定性 ACP 子进程，不读取认证或调用模型。后台 jobs 的原生注册、通知和 AgentLoop 接线另由 `test/integration/host/qwen-task-jobs.spec.ts` 验证；运行时协议夹具覆盖取消未确认、慢工具前置等待和混合消息的顺序发送。测试替身通过不能推定真实 Qwen CLI 或全部平台已验收。

`test/e2e/qwen-terminal-outcome.e2e.ts` 单独验证构建插件的原生 AgentLoop 与持久化：未知结束原因、匹配轮次的 `turnComplete:true, partial:true` 后接 `end_turn` 均保留部分输出并进入结果未知，阻止后续请求派发；普通 `end_turn` 和 `partial:false` 为正常结算对照。此无密钥协议夹具不经过浏览器，也不证明真实模型会产生这些异常；partial／未知原因的异常路径未做真实模型故障注入。上游错误若没有任何机器可读的不完整标记，适配器仍无法可靠识别。

缺结束通知的回归另覆盖已宣布的自动轮次：已经承接时缺少 end，以及 end 缺失导致连接关闭后宿主才承接。运行时按当前轮次的通知／工具活动判断缺报告，正在执行的 Host 工具与人类问答不会被固定总时限截断；已结束但尚未承接的输出与终态继续保留。超时沿原生 attempt、WAL 和结果未知门禁结算，不能初始化新连接后把唤醒或保留输入重新发送。整体关闭时尚未承接的失败保存 durable gate；没有原生轮次 owner 的前缀不伪造为成功历史，亦不承诺跨 Host 重启恢复。

## ACP live continuation opt-in

以下两个浏览器夹具默认跳过。测试使用隔离的 Host、workspace 与 DSH profile，不读取或改写用户的 DSH 配置；ACP 子进程仍按正常方式使用已有登录和用户配置，测试不迁移 CLI 与 ACP 账号的认证状态。均须提供绝对命令路径；模型缺失时停止，不回退到其他模型。原生 Antigravity 夹具默认使用 `gemini-3.8-flash-low`，可显式指定其他可用模型；MCP continuation 夹具必须提供精确模型 ID。只通过 `*_ENV_KEYS` 继承显式列出的、当前进程中已存在的环境变量。Antigravity 使用显式 `antigravity` runtime 和官方 raw ACP server 1.3.0，应用认证与 ACP 账号独立；文档不提供未经证实的 CLI 登录命令。可选的 Antigravity harness 路径会以 `ANTIGRAVITY_HARNESS_PATH` 传给 ACP server，不作为命令参数。

```sh
DSH_E2E_LIVE_ANTIGRAVITY=1 \
DSH_E2E_LIVE_ANTIGRAVITY_COMMAND=/absolute/path/to/agy_acp_server.par \
DSH_E2E_LIVE_ANTIGRAVITY_ENV_KEYS=NAME1,NAME2 \
pnpm test:e2e test/e2e/live-antigravity.e2e.ts
```

Antigravity 使用 `gemini-3.8-flash-low`，也可用 `DSH_E2E_LIVE_ANTIGRAVITY_MODEL` 指定目录中实际存在的精确模型；可用 `DSH_E2E_LIVE_ANTIGRAVITY_HARNESS=/absolute/path/to/localharness_external` 指定 harness。该五阶段检查覆盖原生固定选项问答、Allow once、Reject、Stop 与同 session 继续；Host 工具全部拒绝，交互请求最多 12 次，provider 工具活动超过 16 次会触发测试软停止。该保护不限制模型费用或 token 使用。

```sh
DSH_E2E_LIVE_MCP_CONTINUATION=1 \
DSH_E2E_LIVE_MCP_PROFILE=devin \
DSH_E2E_LIVE_MCP_MODEL=exact-model-id \
DSH_E2E_LIVE_MCP_COMMAND=/absolute/path/to/agent \
DSH_E2E_LIVE_MCP_ARGS='[]' \
DSH_E2E_LIVE_MCP_ENV_KEYS=NAME1,NAME2 \
pnpm test:e2e test/e2e/live-mcp-continuation.e2e.ts
```

`DSH_E2E_LIVE_MCP_PROFILE` 可选 `devin`、`codebuddy` 或 `antigravity`；Antigravity 可另设 `DSH_E2E_LIVE_MCP_ANTIGRAVITY_HARNESS=/absolute/path/to/localharness_external`。夹具严格检查实际 request 与 session 当前 provider/model、每轮已发布 `read` 和 `todo_write` schema、精确 Host 参数与结果；只允许一次 marker 文件读取和一项 todo 写入，Host 分发上限为 8，provider 工具活动超过 16 次会触发测试软停止。这是测试范围守卫，不是 token、费用或生产限额。

本机 macOS 的有限 live 结果如下；这些记录只证明表内场景与配置：

| Profile / 场景               | 环境与模型                                                                             | 脱敏证据                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Antigravity 原生 5 阶段      | 官方 raw ACP server 1.3.0、独立 sidecar binary、`gemini-3.8-flash-low`；未使用 wrapper | `.local/e2e-live-antigravity/ee295ce6-5d36-4055-91f2-715e8645a48f/`      |
| Devin MCP continuation       | Devin CLI `3000.11.3`、`swe-2-high`                                                    | `.local/e2e-live-mcp-continuation/3f4f66f5-042c-43a9-ad2b-3743684cc989/` |
| CodeBuddy MCP continuation   | CodeBuddy CLI `2.161.2`、`minimax-m2.7`                                                | `.local/e2e-live-mcp-continuation/48a0ed2d-cfaa-4265-9ccd-9f3f98404815/` |
| Antigravity MCP continuation | 官方 raw ACP server 1.3.0、`gemini-3.8-flash-low`                                      | `.local/e2e-live-mcp-continuation/fabba4ce-21aa-4d93-b837-a817893f0ebc/` |

这些有限检查不构成完整 wrapper／安装包认证、Teams 验收或 Windows 验证；工具和交互预算是测试守卫，不限制模型费用或 token 使用。

## 重大版本的真实长任务回归

这是重大版本手动 opt-in 的真实 Agent 专项，默认跳过且不属于 CI 门禁。A–D 使用官方 `devin acp` 或 `codebuddy --acp`，每次只选一个精确模型；模型缺失时停止、不回退。记录中的实测环境为 macOS Electron 44、DSH `0.2.0-rc.2`（公开源码 commit `639ed015397290b3745d163aafe02ffee4aa3f84`）、插件 `0.2.0-rc.2.6`、6 个只读源码文件共 61,463 bytes；Devin CLI `3000.11.3` / `swe-2-high`，CodeBuddy CLI `2.161.2` / `minimax-m2.7`。新版本的长任务回归只增加测试和指南。

上述旧环境结果不构成完整矩阵签收：Devin 的 A 六轮源码查阅通过，B 未证明两个成员任务均完成，C 仅有 Lead controls 证据，独立 D Host-job 场景通过。CodeBuddy 的 Lead Allow/Reject 有执行证据，但续聊摘要错误描述 Reject；Stop 后又出现相同命令的新 call ID 请求，触发严格的重复请求测试保护并使 D 失败。证据不能区分模型新请求与 CLI 内部重试，也不证明适配器重放。CodeBuddy A 没有足够 Host read 证据，B 使用 vendor 自有 Team，不是 DSH Teams 签收；成员审批及同任务原生对照均未完成。按 Agent 分别记录，不能互相代替；措辞或工具数量不同本身不判为 bug。详细记录保存在本机 `.local/live-long-task/<agent>/<run-id>/`。

2026-10-18 的后续 Devin 回归使用 DSH `0.2.1-rc.2`、插件 `0.2.1-rc.2.1`、CLI `3000.11.92` 和 `swe-2-high`，任务数据仍固定为上述公开 commit。B 独立专项通过：两个成员各自的实际 Host read 覆盖各自三个文件，完成任务并送达两份报告，Lead 在后续回合分别 get 两个任务并汇总，源码校验及 Host/browser 关闭均通过。另一次 `approvals` 专项完成 C 的四项审批与 D 的 Host job 停止/FIFO 恢复。A 的六轮通过记录来自先前因 C 夹具失败而退出的运行；这些分场景证据没有合写成一次 A–D 全程成功，也不扩展到其他 Agent 或 Windows。此前失败保留在本机报告。

较早记录中的 `LONG_TASK_NATIVE_EXECUTE_REPLAY` 是当时的测试错误码；现在改称 `LONG_TASK_NATIVE_EXECUTE_DUPLICATE_REQUEST`。该守卫会对同一注册命令的任意第二次请求 fail closed，不论新 call ID 或先前请求状态；它是严格的测试保护，不说明请求来自模型还是供应商重试。早期 fixture 的拒绝取消关联、marker 分隔符和 FIFO 失败优先问题已修复，但不改变真实运行记录。CodeBuddy 的两项真实异常尚未定位或修复。

| 场景          | 真实交互与验收                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：源码长任务 | 单 Agent 对固定公开 commit 连续 6–8 轮查阅模块、给出源码依据、接受追问并修订。核验本轮实际读取、路径和结论；不要求固定措辞或 token 数。                                                                  |
| B：Team 协作  | Lead 与两个成员分别查阅 session/runtime 和 Teams，真实创建和分配任务、成员发送结果、Lead 收件后汇总。以 DSH Host/Session 事实核验；vendor 自有 Team 不算 DSH Teams。                                     |
| C：Ask 审批   | 在测试 workspace 使用唯一操作 ID 执行小写入，Lead 与成员各做 Allow once 和 Reject。核验审批归属、允许恰好一次写入、拒绝零副作用和同一 ACP session 后续交互。绑定及事件历史可观察不代表模型语义记忆正确。 |
| D：中断与恢复 | 长任务中执行 Stop、刷新并排队输入；核验取消、会话状态、FIFO 及副作用。只有观测到 Host job settlement 才能签收该执行路径；provider-native 工具路径可能只能记为 partial。                                  |

运行示例：`DSH_E2E_LIVE_LONG_TASK=1 DSH_E2E_LIVE_LONG_TASK_PROFILE=devin pnpm test:e2e test/e2e/live-long-task.e2e.ts`；CodeBuddy 将 profile 改为 `codebuddy`。默认执行 A–D。`DSH_E2E_LIVE_LONG_TASK_SCENARIOS=teams` 跳过 A 并执行 B–D；`teams-only` 仅运行 B，独立核验两个成员各自读取、任务、收件和 Lead 汇总，不重复已验收的 C/D；`controls` 只运行 Lead 的 C controls 与完整 D，C 为 partial；`stop-only` 只运行 D。`approvals` 跳过 A/B，通过官方 Team service 建立一个 fresh 成员作为夹具前置，再运行原 C 的 Lead/member Allow/Reject 四格与 D；前置明确记录为 `setupRoute=host-service`，不认证 Agent 的 spawn 工具调用。跳过场景会明确记录为 `not-run`，不能将 partial 或跳过的结果当作全矩阵通过；未知选择在启动 Host 前失败。最多创建两个成员，场景串行执行。

runner 保存场景截图、Session 事件摘要、脱敏后的结构化 ACP trace 和本地私有的模型回答审查文件。公开源码测试证据可保存在本机；分享截图或事件摘要前先检查并脱敏，因为它们可能显示正文或其他敏感信息。测试 workspace 只是测试数据隔离，不是 OS 沙箱；Host guard 只在 DSH 工具 body 前生效，不能限制 CLI 自有工具，provider 活动计数是事后软停止信号。CLI 工具可能在取消前已执行；测试不限制模型 token/费用或远端已开始的请求。

测试 guard 对整个 run 限制 Host 工具准入最多 96 次、每场景最多 48 次、总时限 20 分钟；单场景最多 6 分钟，普通阶段最多 90 秒，B 初始化及成员结果等待最多 180 秒，最多两个成员。Ask 请求单独计数（总计 24、C 场景最多 16）；provider 工具活动最多 128 次是事后软停止。重复副作用限制仅作用于测试，不是生产限额或费用上限。

C 的成员审批 prompt 明确要求 `wait_agent` 仅传 `{"timeout_ms":30000}`，不传目标或其他参数；测试协调守卫最多接受 60 秒等待。这是为了配合本测试的阶段预算，不是官方工具的最大等待时长。Lead 空参 `list_agents` 可在消息转交前发现成员；等待仍要求当前精确转交已成功。

既有短程浏览器 helpers 不具备本专项的主动预算；本回归由独立 runner 和预算 guard 执行。
