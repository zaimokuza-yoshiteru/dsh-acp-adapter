# 原生功能回归

这组 E2E 验证 DSH 与 ACP 的集成行为：测试启动目标版本的 Loader、真实 ACP 子进程和浏览器，并加载构建后的插件与 DSH UI。协议夹具提供可控 ACP 输入，覆盖 UI 与宿主集成；真实 Agent 行为另由 opt-in 检查验证。Web scaffold 或 Electron 窗口中的适配器检查不等于完整桌面产品的打包、preload、升级或跨平台验收。运行真实 Agent 会使用本机登录和模型额度。

较广的协议与 Teams 场景覆盖 Claude、Codex、Devin、Kimi 四种 ACP 配置。CodeBuddy 目前仅覆盖 Agent controls 与权限隔离；其目录读取由通用 catalog 测试覆盖，不包含 Teams、成员管理或其他矩阵。真实 Agent 的升级需独立检查。

CodeBuddy CLI 的真实运行检查属于本机 opt-in 验证，不纳入普通协议夹具或 CI 的通过声明。本次已完成 macOS CodeBuddy CLI `2.161.2`、模型 `minimax-m2.7` 的 Agent controls 三种场景，每种各运行两轮：Auto 自动批准并恰好执行一次工具；Ask 拒绝一次且工具执行为零；Stop 中止正在等待的工具，确认收到 abort 且无写入副作用。Ask 和 Stop 随后均以同一 ACP session 恢复，完成精确 follow-up；两种场景的 mode 与三个非模型配置值保持，workspace、模型和 MCP scope 匹配，刷新没有重新派发事件或 prompt。此结果仅覆盖记录的本机 CLI、平台、模型与 controls/权限隔离场景，不表示 CodeBuddy Teams、其他平台或 WorkBuddy 桌面应用已通过。已有配置也不会仅凭 `catalogId` 自动切换 runtime。本地 opt-in 检查不是稳定公共命令或 CI 门禁。

| 场景               | 必须保持的行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 目录         | 已验证／未验证分组、窗口内高度、手动入口及原生菜单键盘选择；添加入口不显示额外搜索框；自定义 ID 后目录身份与安装信息保留，中英文均可用                                                                                                                                                                                                                                                                                                                                                                                              |
| ACP 配置编辑       | 原生 Plugins bundle detail 中的 Input / Button；空名称禁止保存；取消不改变配置；保存后刷新保留                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 文件、消息与恢复   | 原生输入栏上传；ACP 收到文件文本句柄；主会话以 Session V4 保存 stream；刷新后消息、附件、原生 TerminalBlock 可见                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 消息分段           | 思考与回答交替、思考开头空行、不同 messageId 和工具边界；实时、停止及刷新后顺序一致；原生 Bash/工具调用及参数摘要、去重计数、折叠保留完整结尾回答、紧凑/详细/展开设置、浏览器查找展开                                                                                                                                                                                                                                                                                                                                               |
| 宿主扩展           | system prompt、动态上下文与 pre-step 插件输入真正到达 ACP；插件触发的后续步骤正常运行；旧用户输入不重复发送；卸载插件后不再携带其指令                                                                                                                                                                                                                                                                                                                                                                                               |
| 图片与文件活动     | assistant 图片经原生附件存储后可刷新显示；Read / Diff 使用原生组件，文件名支持键盘打开原生侧栏预览；活动不会制造 DSH 工具调用                                                                                                                                                                                                                                                                                                                                                                                                       |
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
| 子代理             | Claude / Devin 有完整证据时显示原生只读详情并可刷新；Codex / Kimi 的无证据活动不制造子会话                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 原生文件交付       | 四种协议无需工具配置，通过 MCP 自动发现并调用原生 `present`；执行 hooks、文件卡片与预览保持原生行为                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 插件生命周期       | 通过原生插件管理器在空闲与执行中禁用、重新启用；路由与客户端贡献回收并恢复，后续会话可用                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 后台任务           | ACP 创建真实进程并显示原生 jobs 列表；刷新和离线期间完成后的重连；会话隔离；成功、失败、原生 registry 取消和 ACP 取消；父轮次内提前完成也不追加模型请求；ACP 仍可读取输出                                                                                                                                                                                                                                                                                                                                                           |
| 诊断布局           | 注入 80 条真实审计记录并分页加载；可视高度与原生轨迹一致；底部滚动不移走工具栏；诊断页隐藏对话宽度拖动条；切换详情重置内部滚动；长 JSON 折叠与展开均换行；窄窗口详情可见                                                                                                                                                                                                                                                                                                                                                            |
| 诊断分类           | 默认排除正常检查点和未比较回放；超过首批原始记录的错误仍可见；原因可搜索；允许与拒绝文案明确；技术记录分页；当前恢复状态与历史错误独立展示；通过原生设置切换中文，在 Plugins detail 验证宿主版本标签及诊断分类和审批文案；旧终端缺少终止意图时保持未知原因                                                                                                                                                                                                                                                                          |
| 原生 provider 对照 | ACP 已注册时原生 provider 正常执行；原生工具经过 pre/post hooks，修改后的结果真正回到模型请求；不误发 ACP prompt                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Agent Teams        | 实际调用原生 Teams 工具；同 Agent 多模型、创建时继承模型、旧成员冷恢复保留原模型；原生名册、只读任务面板及刷新、输入框上方多成员待处理卡、折叠与新增请求展开、刷新恢复、中英文与窄屏；首轮及冷恢复审批策略；协调免额外审批、成员普通操作保留审批；成员消息和后续唤醒；成员独立模型下拉、当前／待生效模型、刷新与两次冷唤醒的实际请求头、Lead 与全局默认隔离；成员状态与真实模型、按 ACP 类型分组的模式菜单与批量入口、运行中只读、休眠成员保存模式、恢复前应用与刷新恢复；任务 CRUD、依赖与版本冲突；跨 Agent 新会话和直接 API 拒绝 |
| 主会话集中审批     | Devin 普通权限请求与 Codex 已验证工具授权表单：八个子会话的逐项与批量允许／拒绝；刷新后继续审批、批量后新审批保持待处理、中英文、窄屏；始终留在 Lead，决定写入各自子会话，新请求不被批量允许                                                                                                                                                                                                                                                                                                                                        |
| 模型目录恢复       | 四种协议检查失败保留原生失败项；断网重连后再次检查，已打开的模型菜单更新，无须切换模型；原会话历史不变且可继续对话                                                                                                                                                                                                                                                                                                                                                                                                                  |

`product-controls.e2e.ts` 验证无成员时隐藏入口、ACP 元数据读取失败时保留原生名册与重试、主会话仍运行时新增成员入口、键盘焦点和点击成员名打开原生侧栏；保留主会话地址。团队设置提示允许换行，不能以固定卡片高度断言要求截断文案。

Teams 专项：`pnpm test:e2e test/e2e/agent-teams.e2e.ts test/e2e/teams-boundaries.e2e.ts test/e2e/team-approvals.e2e.ts test/e2e/team-management.e2e.ts test/e2e/team-model-selection.e2e.ts`。真实 Teams 冒烟沿用已授权的 Agent 登录与便宜模型选择，额外设置 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_TEAMS=1`，运行 `test/e2e/live-agents.e2e.ts`；可以用 `DSH_E2E_LIVE_PROFILES=devin` 限定单个 Agent。真实断言必须观察到宿主创建成员、传递消息和完成有依赖的两项共享任务：成员领取并完成计算，Lead 领取并完成复核；任务负责人和原生面板也必须一致。模型口头声称成功不能通过。

真实双模型检查增加 `DSH_E2E_LIVE_TEAMS_MULTIMODEL=1 DSH_E2E_LIVE_PROFILES=devin`，分别使用 SWE-1.7 Medium 与 GPT-5.4 Mini Low 创建成员。`DSH_E2E_RETAIN=1 DSH_E2E_BROWSER_CHANNEL=chrome` 打开并保留随窗口大小自适应的本机 Chrome；该模式要求只选一个 Agent，完成断言后暂停测试退出，不能作为 CI 完成信号。实例地址、重新打开所需的 `authenticatedUrl` 与专属停止文件写入仅当前用户可读写的 `.local/e2e-live-teams/review-instance.json`；其中登录链接仅供本地查看，不要分享。需要关闭时创建其中的 `stopFile`，才会清理对应宿主和浏览器。

`DSH_E2E_LIVE_TEAMS_APPROVAL=1` 额外创建一个真实新成员，验证首次系统提示词为 `ask`、写文件前主会话出现待处理卡。测试直接在主会话的成员卡上点击“允许一次”，确认决定归属子会话，批准后才产生临时文件，且页面始终停留在主会话。建议限定 `DSH_E2E_LIVE_PROFILES=devin`；模型不可用时，通过 `DSH_E2E_LIVE_DEVIN_MODEL` 指定当前目录中的精确 ID。

RC 的原生 Teams 名单从成员的 `modelSelection.next` 显示下次选择；这与已经执行的模型不同。多模型执行以成员持久化的 `request/header` 为准，ACP 管理控件区分当前与待生效模型。本插件不复制原生面板或修改宿主展示数据。原生完成通知中的 reasoning 展示与成员详情分别验证。

集中审批调用宿主原有 pending approval 的一次性回答接口。通用提问／表单不参与批量操作；目标宿主的 `userQuestions.ask()` 会以 `DELEGATED_CALLER` 拒绝由另一个存活 Agent 管理的子会话。普通问题仍保留该限制。只有当前 DSH 工具身份核实、表单仅包含 persist 且提供 once 的 Codex 子会话请求，才转为子会话持有的原生一次性审批；需要用户明确允许，不授予 session/always，也不回答额外字段。

Teams 只在原生 profile 提供服务与九个成员工具时接入；调用仍经过 DSH ToolRuntime 的 hooks 和校验。HTTP/stdio 服务、临时能力地址随会话生命周期撤销。为兼容包括 `3000.3.27` 在内的 Devin 版本，适配器通过 `devin mcp add` 注册固定的用户级 `dsh` stdio 入口。每个进程通过环境变量绑定独立会话能力，退出后能力撤销，用户级入口保留；无需文件链接。Codex 通过关联工具调用的 MCP 审批表单选择仅本次允许；Kimi 只接受当前连接的完整工具标题。这些兼容处理均不放行普通表单或其他工具。

## 运行

宿主目标读取 `package.json` 的 `engines.dsh`。常规开发、构建和发布直接使用锁定的 npm 依赖；浏览器 E2E 单独复用准确源码标签的 Web scaffold，默认布局仍为同级 `dsh-acp-adapter/` 与 `reference/deepseek-harness/`。`DSH_UPSTREAM_CHECKOUT` 仅定位 scaffold，不会替换 npm 依赖或改写 node_modules。正式 npm 宿主安装检查使用开发依赖中的 CLI 和临时 DSH_HOME：`node scripts/install-gate.ts --tgz <本地插件包>`。

```sh
# reference/deepseek-harness 必须检出以下命令输出的标签
node --input-type=module -e 'import { DSH_SOURCE_TAG } from "./scripts/dsh-target.ts"; console.log(DSH_SOURCE_TAG)'
# 在各自目录使用 packageManager 指定的 pnpm（宿主 11.7.0，插件 10.7.0）
(cd ../reference/deepseek-harness && corepack pnpm install --frozen-lockfile && npm run build:native-system && npm run build:lib:host && npm run build:lib:client && npm --prefix apps/web run build)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm --dir ../reference/deepseek-harness/apps/web exec playwright install chromium
pnpm test:e2e
```

`pnpm typecheck` 检查产品源码、单元测试、开发/发布脚本和模拟 Agent；`pnpm typecheck:e2e` 单独检查浏览器测试，并从所选宿主源码提取测试接口声明。`pnpm test:e2e` 会先执行该检查，再启动 Web 或 Electron。开发脚本和模拟 Agent 使用 Node 原生运行可擦除类型的 TypeScript，无需预编译。

`DSH_UPSTREAM_CHECKOUT` 可指定其他源码目录。`pnpm test:e2e -t 'claude'` 可只运行一种协议夹具。默认使用 Playwright Chromium；`DSH_E2E_BROWSER_CHANNEL=chrome` 可使用本机已安装 Chrome。`DSH_E2E_NODE` 可指定宿主支持的另一份 Node 运行时，但原生依赖必须针对该 Node ABI 构建。插件构建与常规测试仍遵循 `.nvmrc`。

`DSH_E2E_ELECTRON=/绝对路径/Electron pnpm test:e2e` 将同一组场景运行在真实 Electron 窗口中，使用独立临时用户目录，以及与桌面端一致的 sandbox、contextIsolation 和禁用 nodeIntegration 设置。它覆盖适配器在 Electron 中的渲染、交互和宿主通信，不替代桌面仓库对打包、preload、专有协议、升级和跨平台成品的测试；不支持保留窗口模式。

测试使用临时工作区和独立 DSH_HOME，结束后销毁浏览器、Agent 进程与测试目录。失败截图写入 gitignored `.local/e2e-failures/`。断言使用原生组件的数据标记及可访问名称，不依赖 CSS 哈希、整页像素截图或真实模型措辞；默认不重试失败测试。浏览器回归期间不要并行运行 build、pack 或默认安装检查：prepack 会清理并重建共享的 `lib` 目录；应按顺序执行，或向安装检查传入已生成的 tarball。

当前验证版本的 `dsh-client-store` Node 入口仍引用 `zustand`、`immer`，但上游只将它们声明为开发依赖。本项目暂时精确声明这两项 devDependencies，供普通 Node 测试加载真实 Store；浏览器继续使用宿主模块表，插件运行时 dependencies 不增加。上游修复 Node 入口依赖闭包后可移除该补偿。

依赖声明通过一致性检查。发布时 `npm pack` 的 prepack 执行类型检查、测试和构建，再由安装门禁验证同一个 tarball。

CI 的产品命令以普通用户运行。Windows hosted runner 的管理员身份仅用于准备独立普通账号及目录权限；安装、类型检查、测试、构建和打包交给该账号执行。macOS / Windows 使用同版本真实 Devin 检查配置发现和固定 MCP 入口，无需登录；需要凭据的调用工具及创建 teammate 由独立 `Real Devin integration` 工作流验证。Linux/macOS 检查实际 UID 非 root；浏览器依赖和系统沙箱准备可使用 sudo。这些检查不替代 Windows 桌面安装包的完整验收。

模式菜单回归会采集浏览器 trace，成功时丢弃，失败时与截图、页面文字、执行阶段和控制台错误一起保存在 `.local/e2e-failures/`。CI 自动上传该目录，保留 7 天；可用 Playwright `show-trace <文件.trace.zip>` 查看。此采集仅用于无密钥协议夹具；trace 含临时宿主的页面和网络数据，分享前仍需检查。

## 真实 Agent 冒烟

`test/e2e/long-conversation.e2e.ts` 默认的 12 轮是确定性 scripted ACP/Native composer 负载与渲染回归，不代表真实模型长会话；100 轮 opt-in 分支本轮未执行、未签收。它们都不能替代下面的真实 Agent/Teams 验证。

以下浏览器真实连接测试默认跳过，不在普通 CI 中运行；带凭据的 Devin 专项见独立 `Real Devin integration` 工作流。明确授权使用现有 Agent 登录和模型额度后，可执行：

真实运行证据只适用于对应 Agent、模型、认证与当次宿主环境。协议夹具通过不代表真实 Agent 通过；普通 live smoke 也不构成 Agent Teams 的真实运行签收。仓库既有的短程真实 Devin CI 集成只覆盖其自身范围；本轮真实模型驱动的复杂 Teams 长会话对照尚未完成，不能由短程集成或协议夹具推定通过，也不能据此声称当前新 head 已通过。实验性本机审计不作为稳定公共命令或 CI 门禁。不要据此推断完整桌面安装包已经验证。

```sh
DSH_E2E_LIVE=1 pnpm test:e2e -t 'live ACP smoke'
```

测试从实际目录选择预设的小模型：Claude Haiku、Codex Mini / Spark、Devin SWE-1.7 Medium / Mini Low / Flash、Kimi Coding。没有匹配项就失败，不回退到默认模型；可用 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定精确 ID，例如 `DSH_E2E_LIVE_DEVIN_MODEL=swe-1-7-medium`。模型别名仍使用该 Agent 已配置的服务路由。

每个 Agent 在独立临时工作区的同一会话接收两条无工具请求；第二轮更新宿主指令中的随机标记，验证新指令到达模型、原生 stream 落盘，以及每轮刷新恢复。`DSH_E2E_LIVE_PROFILES=claude` 可限定 Agent；结果、实际模型目录和成功截图写入 gitignored `.local/e2e-live/`。测试会向配置的模型服务发送测试指令、宿主指令与临时工作区元数据，不把项目文件作为输入。登录或网络失败会使测试失败。这组真实连接冒烟不代替上面的工具、审批和 jobs 协议回归。

若 Agent 通过环境变量认证，需要显式指定要放入临时 ACP profile 的变量名，例如 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`。测试只读取列出的变量，值不写入测试结果；临时 profile 随宿主清理。生产环境同样需要在连接设置中显式配置凭据，父进程密钥不会自动继承。

独立的 `Real Devin integration` 工作流会使用真实 Devin 创建两个 Lead 和两个 teammate，并验证消息往返及后续响应。要在本机运行，先完成依赖安装与 `pnpm build`，再在当前 shell 临时提供 `WINDSURF_API_KEY`，执行：

```sh
DEVIN_TEST_MODEL=swe-2-high node scripts/check-devin-live.ts "$(command -v devin)"
```

`DEVIN_TEST_MODEL` 未设置时默认为 `swe-2-high`（SWE-2）；显式空值或当前 Devin 模型目录中不存在的 ID 会在发送 prompt 前失败，不会回退到任意目录项。可用它指定目录中另一确切模型。真实运行会产生 Devin 服务用量，费用与可用额度按运行时账户套餐和当前计费条件为准；运行前请自行核对。脚本有专用的 16 次 Host 工具分发准入上限，角色违规或超限调用会在 Host 工具函数执行前拒绝并取消该轮；此预算只保护该测试，不限制模型 token 生成或 Devin 原生工具使用，也不是生产限额。4 分钟模型交互计时从首个 Lead prompt 发出前开始，到期会请求取消本地 ACP turns；远端已经开始的请求仍可能继续结算。单阶段等待最多 90 秒。启动准备和关闭时间不计入模型交互计时。脚本将 HOME、XDG 目录与 DSH profile 指向临时目录，不改 Devin 的用户级配置。Actions 为 macOS 和 Windows 普通用户步骤固定同一模型；Windows 启动器会显式把该值传给凭据登录的普通用户进程。

每个 live 测试会尝试在 `DEVIN_LIVE_TRACE_DIR` 写入一个 `real-devin-live-<24位十六进制>.jsonl`。CI 只从专用 `devin-live-diagnostics` 目录上传这类文件，保留 7 天；文件包含每次运行独立密钥 HMAC 处理的关联 ID、固定枚举、布尔值和数字，不含原始消息、prompt、参数、凭据、stdout、stderr、profile、transcript 或 Devin CLI 原生日志。Windows 普通用户先写入审计临时目录，启动器在删除该目录前复制符合文件名的 trace 到 runner 专用目录。工作流级硬超时或 runner 被强制终止时，`always()` 上传步骤也可能没有机会执行，因此不能保证每次运行都有 artifact；缺少文件时 CI 会显示 warning。

查看 trace 时需区分事件层级：`run/start` 与 `run/summary` 描述一次检查，`phase/completed` 描述一个阶段完成，tool 事件描述单次工具分发或结果。`test/assertions-passed` 只表示脚本断言通过；终态还要求 trace 完成写入且进程输出 `LIVE_TEST_PASS`。ACP call、团队 message、step 和 prompt 是不同对象，不能把数量互相当作对方的数量。Host 的工具调用 ID 与成功 `send_message` 返回的 messageId 通过 trace 中显式记录的关联字段连接，不能靠相邻日志行推断。ACP provider 内部发出的模型请求数量及传输重试可能不可观察；`context used` 是上下文使用量，不是计费 token 数。

诊断日志只覆盖启用后的运行；离线检查不能替代真实端到端验证。之后生成的 trace 无法还原既有运行中调用数量的成因。脚本中的工具准入预算只约束该测试，不保护生产环境。

Claude 使用 DeepSeek 等第三方服务时，应同时核对 `ANTHROPIC_BASE_URL`、认证变量及模型映射，并通过 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS` 传入所需配置。模型目录可返回不代表生成已认证，模型别名也不能证明实际供应商。遇到意外 OAuth 报错时，先检查临时 profile 的有效路由和认证配置，再判断是否需要登录。

真实运行中插话使用 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_STEERING=1`，可用 `DSH_E2E_LIVE_PROFILES=codex,kimi,devin` 选择已登录的 Agent；模型仍通过对应的 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定。该专项先等待真实首段输出，再经原生 `agent.steer` 插话，验证一个 turn、两个 step、两条持久化输入与刷新后的追加回复。它不操作文件或工具。普通两轮宿主指令测试、Teams 测试与插话测试分别记录，不能互相替代。

## 版本迁移的补充验证

Persistence 替身使用真实 `SessionHandle` 类型，分别覆盖 `detached` 与 `shared-frozen` 读取结果。新投影的空 stream、内容或 usage 不匹配必须报冲突；不会因恢复接口放宽验证而放过损坏记录。进程测试通过宿主句柄确认托管范围退出；命令已结束或 provider 观察失败仍需清理。版本探针失败返回空版本，terminal 清理无法确认时允许重试；只有明确的启动 ENOENT 才可回退到 shell，取消后不再启动回退命令。

`test/unit/host/external-subagent-projector.spec.ts` 覆盖写句柄释放、flush 失败、前缀续写和重复投影。新投影直接写入 V3，stream 使用上游 accumulator；时间表示结果被观察到的时间，不补造外部 Agent 的 token 时间线。宿主拒绝的旧 V1/V2 投影不做专用迁移；夹具验证原日志与 sidecar 不被修改，也不阻塞新投影。写句柄使用原生异步释放，flush 或释放失败均不能发布完成状态。退出宽限为零时仍在下一次定时器触发后终止等待，不使用宿主 deadline 的零值（禁用超时）语义。

ACP v1 没有 system 角色；宿主指令通过带标注的请求上下文传递，无法强制它高于外部指令。活动归属使用稳定的 ACP 会话／轮次标识和原生 Step data，不再依赖迁移前的事件序号。系统指令覆盖从历史首条 system message 读取、A → B 更新和清空；ACP 不声明它无法原样支持的 in-history system 更新能力。

ACP 与 DSH 的桥接边界见[原生复用说明](../../docs/native-reuse.md)；工具桥回归验证其通过 ToolRuntime 和 hooks 执行 DSH 工具。

真实主信息流专项：`DSH_E2E_LIVE_STREAM=1 DSH_E2E_LIVE_CODEX_MODEL=<已选择的模型> pnpm test:e2e live-main-stream`。在隔离工作区让真实 Codex ACP 执行一次 `printf`，验证原生 Bash、调用计数、结果详情及刷新恢复；不读写用户文件。需要本机已有登录，会消耗该 Agent 的用量，默认跳过。
