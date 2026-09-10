# 原生功能回归

这组 E2E 的验收对象是 DSH 与 ACP 之间的产品行为：执行者可以不同，输入、消息、审批及详情仍应复用宿主公开能力。测试启动目标版本的完整 Loader 装配、真实 ACP 子进程和浏览器，浏览器加载构建后的插件与 DSH UI。它不使用现有单元测试的 React 或 UI primitive stub。

原有 68 项断言在 Claude、Codex、Devin、Kimi 四种协议夹具下运行；另有 15 项 Teams 专项：四种协议的允许／拒绝／中断共 12 项，加上开关关闭、ACP 多模型与跨 Agent 边界、原生对照 3 项。夹具只是可控的协议输入，不代表真实 Agent 或具体模型已经通过验收；真实 Agent 的升级仍需要少量单独冒烟。模型文案、推理质量和回答风格不作为固定夹具的通过条件。

| 场景 | 必须保持的行为 |
| --- | --- |
| 设置编辑 | 原生 Input / Button；空名称禁止保存；取消不改变配置；保存后刷新保留 |
| 文件、消息与恢复 | 原生输入栏上传；ACP 收到文件文本句柄；主会话以 Session V3 保存 stream；刷新后消息、附件、原生 TerminalBlock 可见 |
| 宿主扩展 | system prompt、动态上下文与 pre-step 插件输入真正到达 ACP；插件触发的后续步骤正常运行；旧用户输入不重复发送；卸载插件后不再携带其指令 |
| 图片与文件活动 | assistant 图片经原生附件存储后可刷新显示；Read / Diff 使用原生组件，文件名支持键盘打开原生侧栏预览；活动不会制造 DSH 工具调用 |
| 故障恢复 | Agent 崩溃后提示恢复，刷新保留历史；明确放弃远端上下文后才能建立新绑定并继续 |
| Web 重连 | 浏览器断网后恢复连接，无需手动刷新；历史仍在，不重复发送 ACP prompt，下一条消息可正常执行 |
| 滚动 | 长回答连续输出后、窗口缩小时，回答末尾保持在原生会话滚动区域内 |
| 排队消息 | 请求在途时显示 Sending，禁止编辑、删除和 Steer；服务端接收后才允许删除，删除后不会送到 ACP |
| 审批允许 / 拒绝 | 原生审批或问题卡显示操作；选择映射回原始 optionId；拒绝不产生文件副作用；不扩大授权范围 |
| 停止后继续 | 原生停止按钮发送 ACP cancel；当前轮次结束；下一轮仍能执行 |
| 模型切换 | 原生 picker 的选择传到 ACP session 配置；后续请求使用新模型 |
| 子代理 | Claude / Devin 有完整证据时显示原生只读详情并可刷新；Codex / Kimi 的无证据活动不制造子会话 |
| 后台任务 | ACP 创建真实进程并显示原生 jobs 列表；刷新和离线期间完成后的重连；会话隔离；成功、失败、原生 registry 取消和 ACP 取消；父轮次内提前完成也不追加模型请求；ACP 仍可读取输出 |
| 诊断布局 | 注入 80 条真实审计记录并分页加载；可视高度与原生轨迹一致；底部滚动不移走工具栏；诊断页隐藏对话宽度拖动条；切换详情重置内部滚动；长 JSON 折叠与展开均换行；窄窗口详情可见 |
| 诊断分类 | 默认排除正常检查点和未比较回放；超过首批原始记录的错误仍可见；原因可搜索；允许与拒绝文案明确；技术记录分页；当前恢复状态与历史错误独立展示；通过原生设置切换中文，验证设置版本、诊断分类和审批文案；旧终端缺少终止意图时保持未知原因 |
| 原生 provider 对照 | ACP 已注册时原生 provider 正常执行；原生工具经过 pre/post hooks，修改后的结果真正回到模型请求；不误发 ACP prompt |
| Agent Teams | 实际调用原生 Teams 工具；同 Agent 多模型、创建时继承模型、旧成员冷恢复保留原模型；原生名册、任务面板、输入框上方多成员待处理卡、折叠与新增请求展开、刷新恢复、中英文与窄屏；首轮及冷恢复审批策略；协调免额外审批、成员普通操作保留审批；成员消息和后续唤醒；任务 CRUD、依赖与版本冲突；跨 Agent 新会话和直接 API 拒绝 |

Teams 专项：`pnpm test:e2e test/e2e/agent-teams.e2e.mjs test/e2e/teams-boundaries.e2e.mjs`。真实 Teams 冒烟沿用已授权的 Agent 登录与便宜模型选择，额外设置 `DSH_E2E_LIVE=1 DSH_E2E_LIVE_TEAMS=1`，运行 `test/e2e/live-agents.e2e.mjs`；可以用 `DSH_E2E_LIVE_PROFILES=devin` 限定单个 Agent。真实断言必须观察到宿主创建成员、传递消息和完成有依赖的两项共享任务：成员领取并完成计算，Lead 领取并完成复核；任务负责人和原生面板也必须一致。模型口头声称成功不能通过。

真实双模型检查增加 `DSH_E2E_LIVE_TEAMS_MULTIMODEL=1 DSH_E2E_LIVE_PROFILES=devin`，分别使用 SWE-1.7 Medium 与 GPT-5.4 Mini Low 创建成员。`DSH_E2E_RETAIN=1 DSH_E2E_BROWSER_CHANNEL=chrome` 打开并保留随窗口大小自适应的本机 Chrome；该模式要求只选一个 Agent，完成断言后暂停测试退出，不能作为 CI 完成信号。实例地址、重新打开所需的 `authenticatedUrl` 与专属停止文件写入仅当前用户可读写的 `.local/e2e-live-teams/review-instance.json`；其中登录链接仅供本地查看，不要分享。需要关闭时创建其中的 `stopFile`，才会清理对应宿主和浏览器。

`DSH_E2E_LIVE_TEAMS_APPROVAL=1` 额外创建一个真实新成员，验证首次系统提示词为 `ask`、写文件前主会话出现待处理卡、原生允许一次之后才产生临时文件。建议限定 `DSH_E2E_LIVE_PROFILES=devin`，与双模型检查一起运行。

已知宿主显示限制：rc.2 的 Teams 名单对休眠成员回退使用 Lead 的初始 `Agent.options.model`，主会话标签也可能滞后。多模型执行应以成员持久化的 `request/header` 为准；不要为使断言通过而把名单标签当作实际调用模型。本插件不复制原生面板或修改宿主的展示数据。原生完成通知会复制子会话的 reasoning block，但 ContextBody 尚不能渲染它，因此该通知中可能出现 Unknown content；成员详情的原生推理展示不受影响。

Teams 只在原生 profile 提供服务与九个成员工具时接入；调用仍经过 DSH ToolRuntime 的 hooks 和校验。HTTP/stdio 服务、临时能力地址随会话生命周期撤销。Devin 当前不把 ACP `mcpServers` 暴露到模型工具目录，因此单独使用临时原生 MCP 配置，保留已有 MCP 服务以及原生设置、权限的保存路径，关闭后移除。Codex 通过关联工具调用的 MCP 审批表单选择仅本次允许；Kimi 只接受当前连接的完整工具标题。这些兼容处理均不放行普通表单或其他工具。

## 运行

宿主目标为 `0.1.5-rc.2`。常规开发、构建和发布直接使用锁定的 npm 依赖；浏览器 E2E 单独复用准确源码标签的 Web scaffold，默认布局仍为同级 `dsh-acp-adapter/` 与 `reference/deepseek-harness/`。`DSH_UPSTREAM_CHECKOUT` 仅定位 scaffold，不会替换 npm 依赖或改写 node_modules。正式 npm 宿主安装检查使用开发依赖中的 CLI 和临时 DSH_HOME：`node scripts/install-gate.mjs --tgz <本地插件包>`。

```sh
# reference/deepseek-harness 必须检出 dsh-v0.1.5-rc.2
# 在各自目录使用 packageManager 指定的 pnpm（宿主 11.7.0，插件 10.7.0）
(cd ../reference/deepseek-harness && corepack pnpm install --frozen-lockfile && npm run build:native-system && npm run build:lib:host && npm run build:lib:client && npm --prefix apps/web run build)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm --dir ../reference/deepseek-harness/apps/web exec playwright install chromium
pnpm test:e2e
```

`DSH_UPSTREAM_CHECKOUT` 可指定其他源码目录。`pnpm test:e2e -t 'claude'` 可只运行一种协议夹具。默认使用 Playwright Chromium；`DSH_E2E_BROWSER_CHANNEL=chrome` 可使用本机已安装 Chrome。`DSH_E2E_NODE` 可指定宿主支持的另一份 Node 运行时，但原生依赖必须针对该 Node ABI 构建。插件构建与常规测试仍遵循 `.nvmrc`。

测试使用临时工作区和独立 DSH_HOME，结束后销毁浏览器、Agent 进程与测试目录。失败截图写入 gitignored `.local/e2e-failures/`。断言使用原生组件的数据标记及可访问名称，不依赖 CSS 哈希、整页像素截图或真实模型措辞；默认不重试失败测试。浏览器回归期间不要并行运行 build、pack 或默认安装检查：prepack 会清理并重建共享的 `lib` 目录；应按顺序执行，或向安装检查传入已生成的 tarball。

rc.2 的 `dsh-client-store` Node 入口仍引用 `zustand`、`immer`，但上游只将它们声明为开发依赖。本项目暂时精确声明这两项 devDependencies，供普通 Node 测试加载真实 Store；浏览器继续使用宿主模块表，插件运行时 dependencies 不增加。上游修复 Node 入口依赖闭包后可移除该补偿。

宿主目标以 `package.json` 的 `engines.dsh` 为准，开发脚本和 CI 源码标签从这里读取；依赖声明、双语 README 与本指南通过一致性检查。发布时 `npm pack` 的 prepack 完整执行类型检查、测试和构建，再由安装门禁验证同一个 tarball。

## 真实 Agent 冒烟

真实连接默认跳过，不在 CI 中运行。明确授权使用现有 Agent 登录和模型额度后，可执行：

```sh
DSH_E2E_LIVE=1 pnpm test:e2e -t 'live ACP smoke'
```

测试从实际目录选择预设的小模型：Claude Haiku、Codex Mini / Spark、Devin SWE-1.7 Medium / Mini Low / Flash、Kimi Coding。没有匹配项就失败，不回退到默认模型；可用 `DSH_E2E_LIVE_<PROFILE>_MODEL` 指定精确 ID，例如 `DSH_E2E_LIVE_DEVIN_MODEL=swe-1-7-medium`。模型别名仍使用该 Agent 已配置的服务路由。

每个 Agent 在独立临时工作区的同一会话接收两条无工具请求；第二轮更新宿主指令中的随机标记，验证新指令到达模型、原生 stream 落盘，以及每轮刷新恢复。`DSH_E2E_LIVE_PROFILES=claude` 可限定 Agent；结果、实际模型目录和成功截图写入 gitignored `.local/e2e-live/`。测试会向配置的模型服务发送测试指令、宿主指令与临时工作区元数据，不把项目文件作为输入。登录或网络失败会使测试失败。这组真实连接冒烟不代替上面的工具、审批和 jobs 协议回归。

若 Agent 仅通过父进程环境中的密钥认证，需要显式指定要放入临时 ACP profile 的环境变量名，例如 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`。测试只读取列出的变量，值不写入测试结果；临时 profile 随宿主清理。生产环境仍需在该 Agent 的连接设置中显式配置凭据，不会自动继承父进程密钥。模型目录能够返回不等于生成请求已经完成认证。

## 版本迁移的补充验证

Persistence 替身使用真实 `SessionHandle` 类型，分别覆盖 `detached` 与 `shared-frozen` 读取结果。新投影的空 stream、内容或 usage 不匹配必须报冲突；不会因恢复接口放宽验证而放过损坏记录。进程测试通过宿主句柄确认托管范围退出；命令已结束或 provider 观察失败仍需清理。版本探针失败返回空版本，terminal 清理无法确认时允许重试；只有明确的启动 ENOENT 才可回退到 shell，取消后不再启动回退命令。

`test/unit/host/external-subagent-projector.spec.ts` 覆盖写句柄释放、flush 失败、前缀续写和重复投影。新投影直接写入 V3，stream 使用上游 accumulator；时间表示结果被观察到的时间，不补造外部 Agent 的 token 时间线。宿主拒绝的旧 V1/V2 投影不做专用迁移；夹具验证原日志与 sidecar 不被修改，也不阻塞新投影。写句柄使用原生异步释放，flush 或释放失败均不能发布完成状态。退出宽限为零时仍在下一次定时器触发后终止等待，不使用宿主 deadline 的零值（禁用超时）语义。

活动归属使用稳定的 ACP 会话/轮次标识和原生 Step data，不再依赖迁移前的事件序号。系统指令覆盖从历史首条 system message 读取、A → B 更新和清空；ACP 不声明它无法原样支持的 in-history system 更新能力。

ACP v1 没有 system 消息角色，宿主指令以有标注的请求上下文传递；无法强制改变外部 Agent 的指令优先级。外部 Agent 自己执行的工具、技能加载和 MCP 不会自动进入 DSH 的工具 hooks，工具活动通知也不是执行请求。Teams 是明确限定的执行桥：只暴露九个原生成员工具，通过真实 ToolRuntime 执行，不能据此推导其他 Agent 工具也经过宿主管线。
