# 原生功能回归

浏览器用例启动目标 DSH Loader、构建后的 UI 和可控的 ACP 子进程。它们验证宿主与插件的集成。真实服务的模型行为需要单独运行[真实 Agent 冒烟](#真实-agent-冒烟)。过往版本的通过结果与已知失败见[历史回归记录](REGRESSION.md)。

## 选择场景

按改动选择测试文件。命令示例为 `pnpm test:e2e test/e2e/acp-model-switch.e2e.ts`。要验证同一个已解包候选，将 `DSH_E2E_ADAPTER_DIRECTORY` 指向包含其 `package.json` 与构建产物的目录。

| 改动               | 首选场景与观察点                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接、目录与配置   | [插件详情与配置](plugin-panel.e2e.ts)、[目录与键盘](registry-catalog.e2e.ts)、[认证状态改变后重检](probe-refresh-health.e2e.ts)、[缺少模型目录的 Agent 完成首轮](generic-agent.e2e.ts)                                                   |
| 会话与切模         | [原生选择器](native-model-picker.e2e.ts)、[原 ACP 会话的确认、断线、取消与重发](acp-model-switch.e2e.ts)、[专用预设](acp-preset.e2e.ts)、[继承默认路由的成员与预设](managed-default.e2e.ts)、[中英文模型菜单](managed-model-menu.e2e.ts) |
| 创造与插件停启     | [原生创造入口、技能读取、安装审批及工具热加载](creator-flow.e2e.ts)、[启停与卸载](plugin-lifecycle.e2e.ts)                                                                                                                               |
| 输入与恢复         | [宿主指令与运行中输入](host-instruction-delivery.e2e.ts)、[待发输入与恢复](recovery-queue.e2e.ts)、[工具完成后的补存](settlement.e2e.ts)、[既有历史](imported-history.e2e.ts)                                                            |
| 消息与活动         | [已提交回复与通知](committed-replies.e2e.ts)、[消息分段](stream-segments.e2e.ts)、[首次载入](activity-journal-startup.e2e.ts)、[原生终端、单次编辑 Diff 与计划](native-parity.e2e.ts)                                                    |
| 审批、分叉与 Teams | [权限隔离](permission-isolation.e2e.ts)、[外部审批策略](external-permission-policy.e2e.ts)、[分叉与子会话审批](fork-approval-contracts.e2e.ts)、[成员模型](team-model-selection.e2e.ts)、[任务与消息](agent-teams.e2e.ts)                |
| 桌面与触屏交互     | [工作步骤显示偏好](native-work-details.e2e.ts)、[成员设置与导航](product-controls.e2e.ts)、[触屏添加 Agent](catalog-menu-touch.e2e.ts)、[悬停与触屏布局](hover-responsive.e2e.ts)                                                        |
| 可选工具           | [官方会话搜索与持久终端](optional-host-tools.e2e.ts)、[语音与思考翻译](optional-input-ui.e2e.ts)、[定时任务](schedule-tools.e2e.ts)、[工作目录与 worktree](worktree-tools.e2e.ts)、[Ralph](ralph.e2e.ts)                                 |

`activity-grouping.e2e.ts` 和 `native-slot-anchors.e2e.ts` 直接使用宿主 assembler 或 jsdom。要检查桌面或触屏呈现，请运行相应浏览器场景。ACP 编辑卡的 Diff、原生整轮文件摘要与文件交付各自有独立的数据来源，核对时须看具体卡片。

`DSH_E2E_NATIVE_CATALOG_DIAGNOSTICS=1` 在成员设置用例中额外记录原生目录接口。截图和日志写入 gitignored `.local/`。

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

普通 CI 将全部协议夹具分配给三个独立 runner，片内仍串行且不重试。`scripts/e2e-shards.ts` 从实际文件清单生成分组，新增 `.e2e.ts` 自动纳入；较大的 native parity 夹具按 Claude、Codex、Devin 分配，各 profile 恰好运行一次。三个分片全部成功才通过原有 Native UI 必需检查，opt-in 真实 Agent 场景继续按原规则跳过。`node scripts/e2e-shards.ts` 可查看完整分配；`pnpm test:e2e --ci-shard 1/3` 可顺序复现某片，该模式不接受额外文件或名称过滤。默认 `pnpm test:e2e` 仍运行完整清单。依赖 store 与 Chromium 缓存只保存下载内容，Host 每片仍从准确源码标签构建，不复用用户 profile 或认证。

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

Claude 与 Codex 在未显式指定模型时分别从实际目录匹配 Haiku、Mini / Spark；也可用 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定精确 ID。Devin 必须明确设置 `DSH_E2E_LIVE_DEVIN_MODEL`，并在运行前核对认证目录、当前价格与授权额度；缺失、空值或目录中没有该模型均失败，不自动回退。模型名、代码中的默认常量或 Free 标签都不能证明本次请求免费或低价，别名仍使用该 Agent 已配置的服务路由。

使用已授权的本机 Devin 登录时，设置 `DEVIN_LIVE_AUTH=existing`。检查仅将官方 `credentials.toml` 复制到受限权限的临时数据目录，HOME、XDG 与 MCP 注册全部隔离；不复制用户配置和历史，也不改写原认证。若选择环境变量认证，则通过 `DSH_E2E_LIVE_DEVIN_ENV_KEYS=WINDSURF_API_KEY` 显式转发。此隔离适用于 `live-agents.e2e.ts` 的普通、Teams 与插话检查，其他专项各自保留文中描述的认证范围。

```sh
DEVIN_LIVE_AUTH=existing \
DSH_E2E_LIVE=1 DSH_E2E_LIVE_PROFILES=devin \
DSH_E2E_LIVE_DEVIN_MODEL="<已核对价格且获授权的精确模型 ID>" \
pnpm test:e2e -t 'live ACP smoke'
```

每个 Agent 在独立临时工作区的同一会话接收两条无工具请求；第二轮更新宿主指令中的随机标记，验证新指令到达模型、原生 stream 落盘，以及每轮刷新恢复。`DSH_E2E_LIVE_PROFILES=claude` 可限定 Agent；结果、实际模型目录和成功截图写入 gitignored `.local/e2e-live/`。测试会向配置的模型服务发送测试指令、宿主指令与临时工作区元数据，不把项目文件作为输入。登录或网络失败会使测试失败。这组真实连接冒烟不代替上面的工具、审批和 jobs 协议回归。

若 Agent 通过环境变量认证，需要显式指定要放入临时 ACP profile 的变量名，例如 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`。测试只读取列出的变量，值不写入测试结果；临时 profile 随宿主清理。生产环境同样需要在连接设置中显式配置凭据，父进程密钥不会自动继承。

独立的 `Real Devin integration` 工作流仅接受手动触发，并要求显式勾选 `allow_model_usage`；推送、合并和发布不会自动启动它。该专项会使用真实 Devin 创建两个 Lead 和两个 teammate，并验证消息往返及后续响应。普通 CI 中无凭据的 MCP 配置发现不调用模型，不属于这项带凭据验证。若本轮不使用 Devin 账号或额度，不触发该工作流，并显式设置其他 live 测试的 profile；未过滤的 `live ACP smoke` 会包含 Devin。要在本机运行 Devin 专项，先完成依赖安装与 `pnpm build`，再明确选择认证方式和模型；使用已授权现有登录的示例：

```sh
DEVIN_LIVE_AUTH=existing DEVIN_TEST_MODEL="<已核对价格且获授权的精确模型 ID>" \
node scripts/check-devin-live.ts "$(command -v devin)"
```

未使用 `existing` 时，脚本要求当前 shell 临时提供 `WINDSURF_API_KEY`。`DEVIN_TEST_MODEL` 未设置时仍保留历史默认 `swe-2-high`（SWE-2），新运行应显式选择；此默认值不代表已获授权、免费或低价。显式空值或当前 Devin 模型目录中不存在的 ID 会在发送 prompt 前失败，不会回退到任意目录项。可用它指定目录中另一确切模型。真实运行会产生 Devin 服务用量，费用与可用额度按运行时账户套餐和当前计费条件为准；运行前请自行核对。脚本有专用的 16 次 Host 工具分发准入上限，角色违规或超限调用会在 Host 工具函数执行前拒绝并取消该轮；此预算只保护该测试，不限制模型 token 生成或 Devin 原生工具使用，也不是生产限额。4 分钟模型交互计时从首个 Lead prompt 发出前开始，到期会请求取消本地 ACP turns；远端已经开始的请求仍可能继续结算。单阶段等待最多 90 秒。启动准备和关闭时间不计入模型交互计时。脚本将 HOME、XDG 目录与 DSH profile 指向临时目录；`existing` 仅复制官方凭据文件，不复制原配置或历史，不改 Devin 的用户级配置。Actions 为 macOS 和 Windows 普通用户步骤固定同一模型；Windows 启动器会显式把该值传给凭据登录的普通用户进程。

真实双模型检查增加 `DSH_E2E_LIVE_TEAMS_MULTIMODEL=1 DSH_E2E_LIVE_PROFILES=devin`，必须同时显式提供两个不同的精确 ID：`DSH_E2E_LIVE_DEVIN_MODEL` 与 `DSH_E2E_LIVE_TEAMS_SECOND_MODEL`，首次 prompt 前均须在当前目录中找到。隔离 Host 的原生子代理模型设置只授权这两条路由；Lead 保持首模型，第二次为新的成员选择第二模型，不在已建立的 ACP 会话原地切模。须事先确认两种模型均在授权与额度范围内，名字不保证免费或低价。`DSH_E2E_RETAIN=1 DSH_E2E_BROWSER_CHANNEL=chrome` 打开并保留随窗口大小自适应的本机 Chrome；该模式要求只选一个 Agent，完成断言后暂停测试退出，不能作为 CI 完成信号。实例地址、重新打开所需的 `authenticatedUrl` 与专属停止文件写入仅当前用户可读写的 `.local/e2e-live-teams/review-instance.json`；其中登录链接仅供本地查看，不要分享。需要关闭时创建其中的 `stopFile`，才会清理对应宿主和浏览器。

`DSH_E2E_LIVE_TEAMS_APPROVAL=1` 额外创建一个真实新成员，验证其初始 DSH 审批策略保留原生委派的 `never`。为了单独验证原生 DSH 工具的沙箱升权，测试夹具只在指定文件写入命令准入时显式设置原生 `ask` 与只读沙箱；这不是生产默认行为。测试直接在主会话的成员卡上点击“允许一次”，核对原生 `approval/asked` 与 `approval/decided` 均归属子会话，批准前无文件副作用、批准后产生临时文件，且页面始终停留在主会话。该夹具目前没有处理 Devin 在此之前提出的独立 ACP Ask，因此对 Devin 在启动 Host/模型前明确拒绝，不能将一直等待目标卡片算作产品失败。Devin 的 `DSH_E2E_LIVE_DEVIN_PERMISSIONS` 是另一条 ACP 权限专项，不覆盖本段原生沙箱升权；两项 flag 不能混用。

每个 live 测试会尝试在 `DEVIN_LIVE_TRACE_DIR` 写入一个 `real-devin-live-<24位十六进制>.jsonl`。CI 只从专用 `devin-live-diagnostics` 目录上传这类文件，保留 7 天；文件包含每次运行独立密钥 HMAC 处理的关联 ID、固定枚举、布尔值和数字，不含原始消息、prompt、参数、凭据、stdout、stderr、profile、transcript 或 Devin CLI 原生日志。Windows 普通用户先写入审计临时目录，启动器在删除该目录前复制符合文件名的 trace 到 runner 专用目录。工作流级硬超时或 runner 被强制终止时，`always()` 上传步骤也可能没有机会执行，因此不能保证每次运行都有 artifact；缺少文件时 CI 会显示 warning。

后续诊断在 Agent 进程退出后、隔离目录删除前，通过本轮 sidecar binding 精确选取合成测试会话，从 Devin 本地 SQLite 提取发送调用、工具结果与后续生成的关联事实。读取在无环境变量的独立 worker 中执行，最多 5 秒，并限制数据库、节点与投影字节；仅现有安全 trace 中的 HMAC、枚举、计数和布尔值进入 artifact。`historyReceiptStatus: stored` 表示 CLI 历史保存了对应工具结果，不等同传输层实时确认；只有实际父节点、调用与不同生成请求 ID 都匹配时，才能认定某次重复来自后续生成。路径、schema 或关联不可用时单独记录诊断失败；`scenarioResult` 与 `historyCaptureComplete` 分别描述业务场景和采证结果，不用一项替代另一项。

同一工具调用可能有多个历史快照；仅当 call ID、生成请求、完整参数及父节点一致，并由唯一工具结果指向其中一个快照时，采集器才选择该父节点关联结果。全部节点的安全标识仍输出，额外快照数记为 `historyDuplicateSnapshotCount`。不同请求或参数等歧义记录明确原因，不合并为一次调用；不同 call ID 的后续生成仍逐条保留。这只处理测试证据，不改变生产调用或准入规则。

查看 trace 时需区分事件层级：`run/start` 与 `run/summary` 描述一次检查，`phase/completed` 描述一个阶段完成，tool 事件描述单次工具分发或结果。`test/assertions-passed` 只表示脚本断言通过；终态还要求 trace 完成写入且进程输出 `LIVE_TEST_PASS`。ACP call、团队 message、step 和 prompt 是不同对象，不能把数量互相当作对方的数量。Host 的工具调用 ID 与成功 `send_message` 返回的 messageId 通过 trace 中显式记录的关联字段连接，不能靠相邻日志行推断。ACP provider 内部发出的模型请求数量及传输重试可能不可观察；`context used` 是上下文使用量，不是计费 token 数。

Devin 真实浏览器共享任务验收使用 `live-agents.e2e.ts`，显式设置 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_PROFILES=devin DSH_E2E_LIVE_TEAMS=1 DEVIN_LIVE_AUTH=existing DSH_E2E_LIVE_DEVIN_MODEL=<精确模型>`。它通过原生界面逐项回答本次两个任务和一个成员的原始一次授权，验证依赖任务、成员消息及收到消息后的主会话回复。对于仅含标题的请求，测试驱动仅在 CLI 与 CI 固定版本一致、隔离会话的工具及参数匹配且原生选项逐项匹配时，才代为点击一次授权。选项变化时驱动停止，诊断保留对应阶段。历史审批样本不能作为新版本的真实 Teams 验收。CLI 发布版本由同一可执行文件的有界 `--version` 取得；ACP 握手版本单独记录，不能混用。

更新 Devin CLI 后，可先在以上设置中加 `DSH_E2E_LIVE_DEVIN_PERMISSIONS=inspect`，观察首张真实子会话审批卡。驱动逐项核对原始选项与原生界面后，在子会话点击 Stop，并检查请求取消、没有派发和文件未创建。

设为 `DSH_E2E_LIVE_DEVIN_PERMISSIONS=1`，则单独验收真实子会话的 Allow、Reject、待审批时 Stop 和继续，避免重复执行共享任务。该专项明确使用隔离 Ask 配置，只有各阶段精确的临时 marker 写入属于授权范围；成员创建由测试调用公开原生接口控制，不能据此声称模型自己创建成员。它与旧 `DSH_E2E_LIVE_TEAMS_APPROVAL` 的 native bash sandbox escalation 是不同场景，不互相替代。两项入口均使用临时认证副本、HOME/XDG 和 profile，结束后清理，不修改用户日常配置。

Claude 使用 DeepSeek 等第三方服务时，应同时核对 `ANTHROPIC_BASE_URL`、认证变量及模型映射，并通过 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS` 传入所需配置。模型目录可返回不代表生成已认证，模型别名也不能证明实际供应商。遇到意外 OAuth 报错时，先检查临时 profile 的有效路由和认证配置，再判断是否需要登录。

真实运行中插话使用 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_STEERING=1`，可用 `DSH_E2E_LIVE_PROFILES=codex,devin` 选择已登录的 Agent；模型仍通过对应的 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定。该专项先等待真实首段输出，再经原生 `agent.steer` 插话，验证一个 turn、两个 step、两条持久化输入与刷新后的追加回复。它不操作文件或工具。普通两轮宿主指令测试、Teams 测试与插话测试分别记录，不能互相替代。

## 版本迁移的补充验证

ACP 与 DSH 的桥接边界见[原生复用说明](../../docs/native-reuse.md)；工具桥回归验证其通过 ToolRuntime 和 hooks 执行 DSH 工具。

真实主信息流专项：`DSH_E2E_LIVE_STREAM=1 DSH_E2E_LIVE_CODEX_MODEL=<已选择的模型> pnpm test:e2e live-main-stream`。在隔离工作区让真实 Codex ACP 执行一次 `printf`，验证原生 Bash、调用计数、结果详情及刷新恢复；不读写用户文件。需要本机已有登录，会消耗该 Agent 的用量，默认跳过。

### Qwen Code

真实 Qwen Code 专项需要官方 `@qwen-code/qwen-code`（命令 `qwen`）；千问桌面应用或 `@qianwenai/qianwen-cli` 的 `qianwen` 命令不提供此 ACP 接口。专项默认跳过：`DSH_E2E_LIVE_QWEN=1 DSH_E2E_LIVE_QWEN_COMMAND=/absolute/path/to/@qwen-code/qwen-code/cli-entry.js pnpm exec vitest run test/integration/process/qwen-live.spec.ts`。可用 `DSH_E2E_LIVE_QWEN_MODEL` 指定当前会话目录中的精确模型 ID；每个新会话在首个 prompt 前校验并选择，缺失或空值即失败，未设置时沿用原行为，不修改用户 CLI 默认配置。它不经过浏览器与 Host，直接驱动 `AcpSessionRuntime`，在临时工作区验证 `ask_user_question` 问答、后台 shell 任务完成后承接 `_qwencode/start_turn` 轮次，以及无整轮终态标记的 `cron` 输出进入结果未知、保留输入不派发的路径。未知／缺失原因和 hold 丢失的确定性负向场景由协议夹具覆盖；不能用模型自述或快照空闲替代终态。Agent 进程只继承系统基础变量和 `DSH_E2E_LIVE_QWEN_ENV_KEYS` 显式列出的变量；Qwen 使用本机已有的认证配置，会消耗所配置模型服务的用量。协议回归见 `test/unit/runtime/session-runtime-qwen.spec.ts` 与 `test/fixtures/fake-qwen-agent.mjs`。

Qwen 的无密钥 Host 与界面回归独立于上述 live 检查：`pnpm test:e2e qwen-code` 通过真实 Loader 加载构建插件，验证原生问答卡的单选、多选、自定义、翻页、取消和 Host cancellation，以及模型与推理目录和实际 ACP 配置值。它使用确定性 ACP 子进程，不读取认证或调用模型。后台 jobs 的原生注册、通知和 AgentLoop 接线另由 `test/integration/host/qwen-task-jobs.spec.ts` 验证；运行时协议夹具覆盖取消未确认、慢工具前置等待和混合消息的顺序发送。测试替身通过不能推定真实 Qwen CLI 或全部平台已验收。

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

## 重大版本的真实长任务回归

重大版本可按需运行 [live-long-task.e2e.ts](live-long-task.e2e.ts)。A–D 通过官方 Devin 或 CodeBuddy CLI 使用一个已选定的精确模型。未启用时在 CI 中跳过。

| 场景          | 真实交互与验收                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：源码长任务 | 单 Agent 对固定公开 commit 连续 6–8 轮查阅模块、给出源码依据、接受追问并修订。核验本轮实际读取、路径和结论；不要求固定措辞或 token 数。                                                                  |
| B：Team 协作  | Lead 与两个成员分别查阅 session/runtime 和 Teams，真实创建和分配任务、成员发送结果、Lead 收件后汇总。以 DSH Host/Session 事实核验；vendor 自有 Team 不算 DSH Teams。                                     |
| C：Ask 审批   | 在测试 workspace 使用唯一操作 ID 执行小写入，Lead 与成员各做 Allow once 和 Reject。核验审批归属、允许恰好一次写入、拒绝零副作用和同一 ACP session 后续交互。绑定及事件历史可观察不代表模型语义记忆正确。 |
| D：中断与恢复 | 长任务中执行 Stop、刷新并排队输入；核验取消、会话状态、FIFO 及副作用。只有观测到 Host job settlement 才能签收该执行路径；provider-native 工具路径可能只能记为 partial。                                  |

运行示例：`DSH_E2E_LIVE_LONG_TASK=1 DSH_E2E_LIVE_LONG_TASK_PROFILE=devin pnpm test:e2e test/e2e/live-long-task.e2e.ts`；CodeBuddy 将 profile 改为 `codebuddy`。默认执行 A–D。`DSH_E2E_LIVE_LONG_TASK_SCENARIOS=teams` 跳过 A 并执行 B–D；`teams-only` 仅运行 B，独立核验两个成员各自读取、任务、收件和 Lead 汇总，不重复已验收的 C/D；`controls` 只运行 Lead 的 C controls 与完整 D，C 为 partial；`stop-only` 只运行 D。`approvals` 跳过 A/B，通过官方 `subagents.startActivation` 建立一个 fresh 成员作为夹具前置，再运行原 C 的 Lead/member Allow/Reject 四格与 D；前置明确记录为 `setupRoute=host-service`，不认证 Agent 的 spawn 工具调用。跳过场景会明确记录为 `not-run`，不能将 partial 或跳过的结果当作全矩阵通过；未知选择在启动 Host 前失败。最多创建两个成员，场景串行执行。

runner 保存场景截图、Session 事件摘要、脱敏后的结构化 ACP trace 和本地私有的模型回答审查文件。公开源码测试证据可保存在本机；分享截图或事件摘要前先检查并脱敏，因为它们可能显示正文或其他敏感信息。测试 workspace 只是测试数据隔离，不是 OS 沙箱；Host guard 只在 DSH 工具 body 前生效，不能限制 CLI 自有工具，provider 活动计数是事后软停止信号。CLI 工具可能在取消前已执行；测试不限制模型 token/费用或远端已开始的请求。

测试 guard 对整个 run 限制 Host 工具准入最多 96 次、每场景最多 48 次、总时限 20 分钟；单场景最多 6 分钟，普通阶段最多 90 秒，B 初始化及成员结果等待最多 180 秒，最多两个成员。Ask 请求按 owner/request 单独计数，包含完整选项问答。除 B 外每场最多 16 次；B 的两成员流程和 Lead 复核至少需要 21 次独立工具操作，因此 B 单独允许最多 32 次审批，仍低于原有的 48 次分发上限。总审批基数仍为 24，只加上 B 实际超过旧 16 次的部分（最多增加 16 次），这部分额度不能供其他场景使用。B 只通过原生 UI 选择已核对 scope、完整选项和归属的 `allow_once`，不更改 Auto、Agent mode 或用户权限；这些数值是测试任务预算，不改变产品的执行限制。provider 工具活动最多 128 次是事后软停止。重复副作用限制仅作用于测试，不是生产限额或费用上限。

C 的成员审批 prompt 明确要求 `wait_agent` 仅传 `{"timeout_ms":30000}`，不传目标或其他参数；测试协调守卫最多接受 60 秒等待。这是为了配合本测试的阶段预算，不是官方工具的最大等待时长。Lead 空参 `list_agents` 可在消息转交前发现成员；等待仍要求当前精确转交已成功。
