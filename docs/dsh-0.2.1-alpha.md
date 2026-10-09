# DSH 0.2.1 alpha 兼容与采用评估

更新日期：2026-10-09。本分支是开发分支，不发布、不创建版本标签，也不合并 main；等下一个稳定桌面版本后，重新固定目标并验收桌面产物。

后续全业务源码核对、官方 skills 对照与优化结果见 [alpha.2 源码核对与优化](dsh-0.2.1-optimization.md)。

## 目标与范围

| 项目                    | 固定版本 / 提交                                             |
| ----------------------- | ----------------------------------------------------------- |
| adapter 分支 / 开发版本 | `0.2.1-alpha`                                               |
| 已发布 adapter 基线     | `0.2.0-rc.2.9`，`d9b9f0d7e4f6f43a4fff4cb34f39bbc9c22938e2`  |
| 原 DSH 目标             | `0.2.0-rc.2`，`639ed015397290b3745d163aafe02ffee4aa3f84`    |
| DSH alpha.1             | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`                  |
| 当前 DSH 目标           | `0.2.1-alpha.2`，`d743267388641bc76f17c45ce8b4c231aed1d32c` |
| 工具链                  | Node `24.19.0`；adapter pnpm `10.7.0`；DSH pnpm `11.28.5`   |

上游默认分支实际名为 `master`。本次获取时，其最新提交与 `dsh-v0.2.1-alpha.2` 标签相同；因此按用户选择的“最新开发代码”固定到 alpha.2，没有停在 alpha.1。rc.2 到目标共有 935 个提交，不能只靠修改版本号判断兼容。插件依赖使用已发布 npm 包，源码 checkout 仅为精确版本的 Host/UI 测试 scaffold。

## 本次必须兼容的变化

| 变化                                       | 旧代码的具体影响                                                                        | 本分支处理                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatView 拆出独立 `conversation.chat.flow` | 根组件覆盖的数据 hooks 不会传进新的 flow；ACP 合成节点可能无法读取或退回原始消息流      | 在公开 flow entry 接入每个 ChatView 独立的 React Context；节点、分组、process、bottom 使用同一投影，保留原生完整子树和 viewport hooks。两份同 session 视图不会共用可变投影 |
| 原生 ToolCallBlock 与 TerminalBlock 契约   | 缺少 `args`、结果 `name` 和命令行可访问名称                                             | 用官方 `PartialArguments` 表示参数，补全 started/result 数据及中英文命令行标签；继续使用原生 ToolCallBlock/TerminalBlock                                                   |
| 可变工作目录独立于 Session header          | `header.cwd` 只表示不可变的项目来源，直接用它启动 ACP 会在切换目录后运行到旧目录        | 执行、绑定及恢复检查读取 `workingDirectory` 服务；目录改变进入既有恢复门禁，setup 期间变化也拒绝静默绑定。子会话历史的父项目归属仍使用 header                              |
| Teams 从 mailbox 转成 Agent inbox relay    | 只识别 `team-message` 会漏掉新 `agent-message`，`wait_agent` 可能在消息已到达时继续等待 | 识别新 relay 来源，同时保留历史消息读取；不引入另一层队列、自动重发或伪造旧事件                                                                                            |
| 子 Agent descriptor helper 收窄            | 新 helper 不再接收旧 `one-shot` 输入，ACP 只读内部子任务不能伪装成可续聊 Agent          | 使用公开历史 descriptor 类型与 reader 校验只读 transcript，保留旧记录可读及不可续聊边界                                                                                    |
| 请求准入刷新 SystemPrompt provider         | 原有 waterfall 改写的委派权限说明会被 native provider 覆盖                              | 使用插件拥有的 context 名称保留 ACP 权限规则；验证 assemble、refresh 和下一轮不重复、不恢复 native 条目，遵从宿主 suppression                                              |
| 删除工具 `both` 模式                       | 旧测试 Host 配置无效；简单改 native 会丢失真实 PTC 覆盖                                 | 每个请求只用 native 或 PTC。12/100 轮原生与 ACP 对照在实际第 8 轮以公开 Agent scope 切换到 PTC，结束后恢复；两侧断言实际目录和嵌套 read/edit 副作用                        |
| npm 家族与 framework alpha 版本            | 自动 peer 解析可能混入仍位于 latest 的旧 scope/account/model 包                         | 显式固定 DSH alpha.2 依赖闭包与 Cordis/Schemastery alpha；移除上游已删除且本插件未使用的 in-process-driver 依赖                                                            |

## 可以采用什么

| 能力                                    | 建议与用户收益                                                                                             | 边界                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 官方按需 Codex / Claude 子 Agent bundle | 复用宿主发现、精确版本安装及动态 MCP 工具目录，减少插件自己维护安装器和启用状态                            | 用户显式启用后才可用；无人值守的一次委派不能替代交互式 ACP 主会话，也不能替代远端 Agent 内部子任务投影                |
| managed activation 与直接 inbox         | 继续由 DSH 管理完成通知、取消、成员身份及收件，减少双队列状态和等待延迟                                    | `sent` / accepted 表示收件接受，不等于模型处理完成；旧未投递 mailbox 消息不会凭升级自动补投                           |
| 共享 `~/.agents/AGENTS.md` 与 skills    | 继承宿主组装的上下文和当前工具路由，减少跨工具复制规范与每轮传输全文                                       | 不复制到外部 Agent 私有 skills 目录，不另建同步器；目录摘要不授予工具或执行权限，双运行时各自读取同一指令仍需注意重复 |
| 可选终端、搜索、workflow 工具           | 通过当前请求目录和作用域交集自动复用，避免不断增加硬编码工具清单                                           | 安装不等于挂载；实验能力与 loop 控制仍须专项验证，不默认替用户启用                                                    |
| 带检查的 artifact 构建                  | E2E 只构建其消费的 Host/Client 产物，减少三个 CI shard 重复检查上游仓库 tests/scripts 的 aggregate program | 保留各 package TS 诊断、Typert、bundle 检查及本插件自己的 typecheck/test/build；不使用 benchmark 的 `--noCheck`       |

暂不采用：把 pi-ai 的上下文更新能力当成 ACP 协议承诺；用通用 Session/KV 取代 ACP Sidecar 的绑定与 dispatch 事务；新增专用 memory 存储。上游 memory MCP 文档在 rc.2 到 alpha.2 没有变化，仍是默认关闭的第三方参考配置，不能列作本次新增记忆系统。

## UI/UX 判断

本次优先保证新原生聊天流的正确性，不重做一套聊天界面。新的 reasoning/body/content、分组动作与滚动视口继续跟随原生子树；ACP 只接入数据和活动展示。

alpha.2 将过程折叠时机（完成时 / 下一次输入时）与显示详细度分开，用户可以先读完结果再收起过程。应直接继承这个设置和浏览器查找展开行为，不另存 ACP 折叠偏好。新增思考内容扩展点也随完整原生子树保留；可选翻译插件仍由用户自行启用。

新版还分别提供正文、代码和侧栏终端字体设置，并修正模型列表将已不可用模型显示成可选项的问题。ACP 应继承字体 tokens 和原生模型选择，只把外部 Agent 自有的 mode/model/effort 放在 Agent session options 中。后续优先改善两类选择器的标签区别，以及自绘诊断正文中固定 `11px` 字号对用户字体设置的忽略。原生 Auto review 在 rc.2 已存在，本次主要是图标和实验标签调整，不能宣传为新增权限机制。

| 范围                     | 建议                                                | 解决的问题                                                                                  |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 聊天流、工具块、思考分段 | 本次完成 flow hook 兼容并保留原生组件               | 避免内容重复、节点空白、折叠计数和滚动位置不一致                                            |
| 两个窗口查看同一会话     | 按 ChatView 隔离投影                                | 避免一个视口改变另一视口的分页、展开和订阅状态                                              |
| 工具审批与问题卡         | 复用原生卡、权限来源、键盘行为和双语标签            | 保持 DSH 操作习惯，避免把 Agent 自带工具审批与 Host 工具权限混为一谈                        |
| 工作目录改变与恢复       | 展示既有明确恢复状态，拒绝静默在旧绑定继续          | 用户能判断当前执行位置及恢复动作，不以新建会话或清空历史掩盖问题                            |
| Agent 安装与认证引导     | 后续按具体 Agent 能力分离官网、安装、登录和连接检查 | 减少“有官网链接就能指导 ACP 配置”的误解。Antigravity 默认配置按用户要求暂缓，不计入本次修复 |

## 测试与发布流程

此前版本的 CI 已通过依赖缓存和三路 E2E 分片减少重复验证。本次继续采用上游带检查的 library 入口：`pnpm exec tsx scripts/compile-referenced-projects.ts libraries`，然后构建 Web；不会在每个 shard 额外执行上游整个仓库的 test/script aggregate typecheck。上游的编译器单次测量不能当成本项目总 CI 耗时承诺。

本机 macOS / Node 24.19.0 验证如下。证据保存在 gitignored `.local/dsh-0.2.1-alpha/`，不提交临时 profile、会话内容或凭据。

| 检查                                    | 结果与范围                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 精确源码 scaffold                       | alpha.2 frozen install、native-system、带 TS 检查的 libraries、Web 构建通过                                                                                                                             |
| `pnpm typecheck` / `pnpm typecheck:e2e` | 产品、单元与工具脚本、精确 Host E2E 接口通过                                                                                                                                                            |
| 单元 / 契约 / integration               | 首轮 130 文件中 128 通过、2 个旧夹具失败；修复后相关 4 文件的 26 项检查通过，复用未受影响记录。修复包括为精简 AgentLoop fixture 挂载真实文件系统和工作目录服务；未降低原取消与恢复断言                  |
| 核心 keyless 浏览器                     | 首轮 41 通过、6 失败、1 个长模式跳过；修复旧 mailbox 事件、中文原生按钮名及 present 路径文本假设后，剩余 6 项全部通过。重点覆盖 Devin 原生产品对照、四种协议配置的 Teams、流式分段和 12 轮原生/ACP 对照 |
| 100 轮 keyless 对照                     | 通过：100 轮原生与 ACP 对照、历史分页、刷新及第 101 轮续聊；实际目录验证 native → PTC → native，第 8 轮真实嵌套 read/edit。耗时 164.44 秒；12 轮快速场景在前一轮已通过，本轮按设计跳过                  |
| 构建与隔离 npm 安装                     | `pnpm build`、244 文件包审计及精确 npm DSH alpha.2 的安装/启用/移除、HTTP 200 与 client bootstrap 通过；开发 tgz 仅保留本地，未发布                                                                     |
| 视觉检查                                | 检查本轮生成的流式消息和 200% 缩放短窗口恢复截图；原生完整内容及操作按钮可达。截图检查不替代其他平台验收                                                                                                |

源码构建和协议夹具只能证明固定版本上的集成行为；不能把此前 rc.2 的真实 Agent 记录当作 alpha.2 的 live 通过。真实 Agent 认证和模型调用未重跑，完整跨平台矩阵与稳定桌面产物仍待验收。下一稳定桌面版本发布后，复核目标 SHA/npm 家族，再检查桌面打包/preload、升级恢复和平台矩阵，之后才决定发布与合并。

## 上游依据

- [alpha.2 固定源码](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)
- [工作目录迁移](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/upgrade-guide)
- [工具呈现模式](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/upgrade-guide/v0.2.1-alpha.1/tool-presentation-mode/guide.zh.md)
- [Teams 直接收件箱](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/upgrade-guide/v0.2.1-alpha.1/team-direct-inbox/guide.zh.md)
- [官方按需 bundles](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.zh.md)
- [共享 agents 指令](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/architecture/2026-10-05-shared-agents-root-instructions.zh.md)
- [artifact typecheck 决策](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/implemented/process/2026-10-05-pr-artifact-typechecks.zh.md)
