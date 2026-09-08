# 0.1.3-alpha.1 重构验收

验收日期：2026-09-05。宿主为 `dsh-v0.1.3-alpha.1`（`d347e70390`），上游跟踪文件未修改。此次完成源码适配；插件尚未发布新的 npm 兼容版本。

## 实现范围

- 外部子代理投影采用 SessionHandle，持有写句柄完成追加、flush 和关闭；重复投影、部分写入恢复及旧 sidecar 恢复均有验证。新记录用上游 AssistantStreamAccumulator 生成 v2 stream，删除旧 readRaw 可见性补丁。
- 当前 DSH 步骤中已落盘的插件消息、动态上下文和用户输入均传入 ACP，支持插件驱动的后续步骤；旧用户输入不会重发。宿主 system prompt 每次完整传递为标注清楚的当前指令。
- 会话流、输入栏、审批、模型选择及子代理只读详情继续使用原生组件；外部工具活动归一化为原生 Terminal、Read、Diff 展示，不制造 DSH 工具执行。
- 认证错误同时提示检查 Agent 登录和 ACP 连接设置，避免把仅依赖父进程令牌的认证失败误导为必须重新登录。

## 原生能力复用与精简

后续精简删除了本地 `abortAfter` 和 `AcpDeadline`，退出等待与版本探针改用 `dsh-timeout.deadline()` 及同步资源释放；读写 SessionHandle 改用 `await using`，继续保证 flush 和写句柄释放均成功后才发布投影完成状态。生产源码净减少 55 行（含注释），新增一个直接宿主依赖；未新增迁移包或放宽发布范围。

退出宽限为零时，ACP 仍在下一次定时器触发后结束等待；上游 deadline 的零值会禁用超时，因此适配处保留最小的数值转换。新增真实子进程的零宽限和正宽限退出测试，补充写句柄释放失败不得发布完成状态的回归；删除已交由上游维护的两个 deadline 原语测试。

试接 `sessionFormatV1ToV2.migrate()` 时，既有 sidecar 夹具因 `turn/start 1 data has unexpected member "trigger"` 被上游拒绝。这些插件历史记录不能直接当作上游规范化的 v1 artifact 迁移。最终保留旧 sidecar 摘要校验后的专用恢复路径，断言恢复后所有事件（包括 trigger）与原 sidecar 均保持原有内容，仅补入预期的空 stream。

## 最终验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test --no-file-parallelism` | 55 个文件、580 项通过 |
| `pnpm build` | 通过；132 个打包文件、49 个运行时 JS 文件依赖闭包通过 |
| 完整浏览器回归 | 2 个文件、44 项通过，91.59 秒 |
| 本地 tarball 离线安装、真实 Web 启动和卸载 | 通过；原生组件装配、HTTP 200、客户端启动及卸载清理通过 |
| `git diff --check` | 通过 |

44 项浏览器测试包括四种协议夹具的 40 项产品行为回归和四种真实 Agent 的 4 项冒烟。固定夹具覆盖文件、消息、恢复、宿主上下文扩展、图片、Read/Diff、崩溃恢复、审批允许/拒绝、停止后继续、模型切换、子代理及原生 provider 工具扩展。真实冒烟只验证实际模型收到宿主指令、返回标记、原生 stream 落盘及浏览器刷新恢复；不把夹具中的全部工具与审批场景宣称为真实模型已验收。

| 真实 Agent | 实际选择 | 结果 |
| --- | --- | --- |
| Claude Agent | `haiku`，本机现有配置映射为 DeepSeek V4 Flash | 通过 |
| Codex | `gpt-5.4-mini` | 通过 |
| Devin | `gpt-5-4-mini-low` | 通过 |
| Kimi | `kimi-code/kimi-for-coding`（目录显示 K2.7 Coding） | 通过 |

本机类型检查、常规测试和构建使用 Node 24.19.0；实际 DSH Web、浏览器测试及安装启动使用 Node 22.19.0 和已安装的 Chrome。该 macOS 环境中的 fs-ext 原生构建使用 Node 22 ABI。CI 配置固定源码标签，在三平台验证源码；浏览器固定夹具在 Linux 运行。此处没有把 CI 配置等同于已经执行的跨平台验证。

## Claude 调查结果

最初目录查询成功，但生成返回 `ACP_AUTH_REQUIRED`。仅检查配置字段的存在性后确认：`ANTHROPIC_AUTH_TOKEN` 存在于父进程环境，Claude 用户设置没有配置对应凭据。DSH subprocess 按已有规则过滤父进程的密钥变量，因此模型别名与端点设置可见，认证令牌没有进入 ACP 子进程。

经用户授权，将同一现有令牌显式放入临时测试 profile 后，同一 `haiku` 模型通过验证；无需修改持久化、流协议或用户的正式 Agent 配置。测试使用 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`，只保存变量名和脱敏结果，临时 profile 在测试结束后清理。生产使用仍需显式配置该 Agent 的连接凭据。

## 接口与发布边界

ACP v1 没有 system 消息角色，因此宿主指令作为请求上下文传递，不能保证其拥有外部 Agent system prompt 的优先级。外部 Agent 的工具、技能加载和 MCP 执行仍由该 Agent 管理；ACP 没有通用宿主工具执行回调，工具通知不能当作 DSH 执行请求。原生 provider 的工具执行及其插件 hooks 已通过真实 ToolRuntime 对照验证。

当日再次查询 npm registry，`@deepseek-ai/dsh@0.1.3-alpha.1` 仍返回 404。安装回归使用已构建的准确标签源码和本地插件 tarball，不能替代尚不可执行的正式 npm 安装验收。开发锁文件保留工具引导依赖，运行时必须链接目标源码；发布检查会阻止以旧依赖元数据发布本次适配。

运行方式与测试边界见 [README](README.md)。实际模型目录与结果保存在 gitignored `.local/e2e-live/`；旧调试失败截图可能仍在 `.local/e2e-failures/`，不代表本次最终验证失败。


## 2026-09-06：死代码清理

核对测试入口、源码引用和夹具调用后，没有发现整份未被运行的 spec/E2E 文件或从 host/client 入口不可达的生产模块；本次清理集中在闲置测试支持代码和局部不可达分支。

- Mock Agent 删除 13 个没有测试调用的场景及其专用实现、环境开关和控制 RPC。场景数从 31 减至 18，剩余每个场景均有测试调用；实际历史记录回放和旧 sidecar 迁移夹具保留。
- 将原先闲置的 `load-fail`、`config-write-fail`、`cleanup-close-delete`、`delete-fail`、`no-delete` 接入 5 项真实子进程协议回归：验证 RPC 失败后连接仍可用，以及 probe 遵守清理能力、按 close→delete 顺序执行、清理失败不丢失探测结果。
- 删除 7 个未使用的图标 stub，补齐已被组件导入的 Tooltip stub，修正 React/UI stub 的过期说明；浏览器回归仍使用真实原生组件。
- 删除表单解析中不可达的 URL 分支及重复 mode 判断。公共入口仍拒绝非 form 请求，schema 和输入值校验保持原有行为。
- 删除 3 条绑定产品宣传文案的断言，保留安装说明、双语链接、打包内容和凭据隔离说明检查。

本轮 `pnpm typecheck`、55 个文件的 585 项常规测试（32.47 秒）、构建和打包依赖闭包检查通过。固定夹具浏览器回归 40 项通过（62.60 秒），4 项真实 Agent 冒烟按默认配置跳过。`git diff --check` 通过；代码净减少 760 行（含注释，不含本报告）。

本轮未重新运行真实模型冒烟和 tarball 安装启动；上文 44 项完整浏览器及安装结果属于前一轮原生能力精简验收，不能计作本轮新增验证。


## 2026-09-06：依赖面核查与修正

重新查询 npm registry，`@deepseek-ai/dsh`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session` 的 `0.1.3-alpha.1` 均返回 404。此前“开发依赖声明 rc.1，运行前替换为 alpha.1 源码”的方案会让清单与实际环境不一致，本轮已完整移除旧版引导依赖。

- 28 个宿主开发依赖改为显式 `link:../reference/deepseek-harness/...`，覆盖直接使用的 DSH 模块、Cordis、React 和生成/测试工具。运行 typecheck、test、build 前验证目标 tag、每个包的名称/版本、构建入口及实际链接；`setup:source-reference` 支持指定其他上游目录。
- 移除 31 个间接或未直接使用的开发依赖声明。上游源码自己的锁文件仍负责这些模块的传递依赖；插件锁文件从 3,825 行缩至 1,374 行，干净安装后的插件 pnpm store 没有 `@deepseek-ai/*` 包副本。
- 补齐实际运行时使用的 `dsh-client-store` 和 React 的可选 peer。所有 DSH peer 与 `engines.dsh` 一致；宿主模块不得进入普通/可选运行依赖。运行依赖仍只有精确版本的 ACP SDK 和 Zod。
- 五个开发工具固定到原锁文件已经使用的精确版本，未趁本轮升级工具。Typert 分析 facade 的版本改用共享目标常量。React、Playwright 及浏览器 scaffold 的宿主提供方式已核对，Playwright 继续由 E2E 配置显式解析到目标源码的 Web 工作区。
- 删除不再消费的旧原生包构建配置，将关闭 peer 自动安装的设置统一放入 `pnpm-workspace.yaml`，移除令 npm 报未知设置的 `.npmrc`。
- CI 使用与声明一致的同级目录布局，先构建目标源码再安装插件；发布工作流先检查资格，再安装依赖。发布检查拒绝所有本地开发链接和未统一到目标版本的 DSH 开发依赖，不能只改一个 llm 版本便绕过检查。

| 本轮验证 | 结果 |
| --- | --- |
| 全新 node_modules + frozen lockfile 安装 | 通过；初次离线缺少缓存，补齐锁定包后成功 |
| 源码链接检查、类型检查 | 通过 |
| 常规测试 | 55 个文件、585 项通过，33.22 秒 |
| 构建、打包闭包检查 | 132 个打包文件、49 个运行时 JS 文件通过 |
| 固定夹具浏览器回归 | 40 项通过，59.18 秒；4 项真实模型冒烟未重复运行 |
| 当前 tarball 的独立 npm / pnpm 用户安装 | 两者均只安装插件、ACP SDK、Zod；没有 DSH、React 或开发工具下载 |
| DSH 临时 profile 安装、Web 启动、卸载 | 通过；HTTP 200、客户端启动及卸载清理正常 |
| 插件锁文件 pnpm audit | 已知漏洞 0；上游扫描结果见下文 |

此次提交仍是源码适配，尚不能作为正式 npm 版本发布。开发环境需先构建准确标签的上游源码；待目标 npm 产物可用并通过安装验收后，才能把开发获取方式迁移到精确 npm 版本并开启发布。上游跟踪文件保持干净。CI 三平台配置已同步，但本轮实际执行环境仍是 macOS。


### 上游依赖的审计边界

本轮也对准确标签的上游整个工作区执行了只读审计。完整锁文件结果为 46 条（高 21、中 22、低 3）；`pnpm audit --prod` 为 31 条（高 16、中 14、低 1），没有 critical。这里是整个 DSH monorepo 的生产依赖集合，包含其他 provider、MCP、站点等包，不等同于 ACP 插件有 31 个可触发漏洞。该扫描没有执行漏洞利用或完整可达性分析。

已核对的路径包括 CLI / app-boot → `js-yaml@4.2.0`，以及 MCP client / pi-ai → MCP SDK → AJV → `fast-uri@3.1.3`。这些属于上游锁定版本，不是插件普通安装新增的包。修复需要上游升级，或另行维护并回归一个明确的 patched host；本轮未改写目标标签的源码或锁文件，也未用插件 overrides 替换宿主的模块实例。

| 上游生产依赖 | 扫描版本 | 公告及严重程度 |
| --- | --- | --- |
| `@hono/node-server` | 1.19.14 | [moderate](https://github.com/advisories/GHSA-frvp-7c67-39w9) |
| `brace-expansion` | 5.0.6 | [high](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)、[high](https://github.com/advisories/GHSA-mh99-v99m-4gvg)、[high](https://github.com/advisories/GHSA-rgw5-rvv9-x895) |
| `fast-uri` | 3.1.3 | [high](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx)、[high](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)、[high](https://github.com/advisories/GHSA-5jgf-p345-68v8)、[high](https://github.com/advisories/GHSA-f65p-4m7j-42xc)、[high](https://github.com/advisories/GHSA-fph4-wmhf-6fwf)、[high](https://github.com/advisories/GHSA-jqff-g426-hqxp) |
| `hono` | 4.12.29 | [moderate](https://github.com/advisories/GHSA-8j4g-w8fx-2239)、[moderate](https://github.com/advisories/GHSA-f23p-vx2j-j53r)、[low](https://github.com/advisories/GHSA-79qm-7rj5-m7r9)、[moderate](https://github.com/advisories/GHSA-54fx-42gc-7vw4) |
| `ip-address` | 10.2.0 | [high](https://github.com/advisories/GHSA-mwp4-54f8-5fhr)、[moderate](https://github.com/advisories/GHSA-4xrf-jv44-h6hh)、[moderate](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) |
| `js-yaml` | 4.2.0 | [high](https://github.com/advisories/GHSA-52cp-r559-cp3m)、[high](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) |
| `nanoid` | 3.3.12 | [high](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)、[high](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| `postcss` | 8.5.15 | [moderate](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)、[high](https://github.com/advisories/GHSA-r28c-9q8g-f849) |
| `protobufjs` | 7.6.4 | [moderate](https://github.com/advisories/GHSA-j3f2-48v5-ccww) |
| `qs` | 6.15.3 | [moderate](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)、[moderate](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) |
| `undici` | 7.28.0 | [moderate](https://github.com/advisories/GHSA-8xcm-r25x-g524)、[high](https://github.com/advisories/GHSA-4cwx-7wf7-3272)、[moderate](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5)、[moderate](https://github.com/advisories/GHSA-jr45-8vmc-qm54)、[moderate](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) |

## 2026-09-08：DSH 0.1.3-alpha.2 适配与回归

本轮目标为 `dsh-v0.1.3-alpha.2` / `82a5fd61a7`，reference 保持干净。`engines.dsh`、全部可选 DSH peers、开发目标和 CI 标签统一到精确版本 `0.1.3-alpha.2`，不隐式接纳后续 alpha。开发依赖继续链接准确标签源码，插件运行依赖仍只有 ACP SDK 和 Zod。

### 实现

- 外部子代理投影消费新的 `{ events, eventState }` 读取结果；自行构造的恢复事件显式声明 `detached`。持久化替身采用真实 `SessionHandle` 类型，分别覆盖独立与深冻结共享事件。当前投影必须逐项匹配预期 stream，损坏的空 stream、文本或 usage 被拒绝；旧 sidecar 的专用迁移仍可恢复。
- ACP 连接、版本探针和 terminal release 共用有界进程清理。移除普通句柄 PID 假设，命令结果与 provider 托管范围退出分别观察；即使命令已结束、provider 失败或首次观察抛错，仍尝试终止并确认范围退出。无法确认时不报告 terminal 已释放，允许重试。
- provider 故障会打断正在等待的 RPC，归为 crash 并清理。只有明确 OS 启动 ENOENT 才能触发无参数 shell 命令回退；读取 provider 文件失败不能重放命令，清理期间取消也不能再启动回退。
- 设置页的 Agent 状态和活动审计分类交给原生 `Tag`，删除 47 行自定义徽标/分类配色 CSS。布尔配置已经使用原生 `Menu`，本轮没有为了使用新 `Switch` 而改变交互结构。

### 用户体验与边界

| 宿主能力 | 用户可感知的变化 | 本轮证据或边界 |
| --- | --- | --- |
| 会话性能 | 长历史恢复、持续追加时减少重复事件复制、冻结和历史处理，降低宿主等待与内存压力 | ACP 主会话继续走原生 loop / persistence / projection；未运行长会话性能基准，不声明具体提速比例 |
| Web 重连 | 网络短断后自动重连并恢复会话订阅；宿主恢复较慢时持续重试，仍可手动立即重连 | 四种协议夹具均验证断网→联网后历史保留、不重复 prompt、可继续发送；Agent 进程真正崩溃仍走显式恢复流程 |
| 滚动 | 连续输出、布局变高或变矮时维持贴底阅读；上游还修正了真实向上滚动与布局引发滚动的归因 | 四种夹具均验证长回答末尾及缩小窗口后的可见性；不在插件增加第二套滚动控制 |
| 队列 Sending | 服务端尚未确认时明确显示正在发送，并禁止编辑、删除、Steer，避免对未确认消息重复操作 | 四种夹具均阻塞请求检查三个按钮禁用；确认后删除排队消息，证明它没有被发往 ACP |
| 原生 Tag / Switch | 状态与分类标签使用宿主统一尺寸、色彩和主题；未来真正的布尔表单可复用原生开关及其可访问语义 | Tag 已落地；Switch 是可复用组件能力，本次未新增开关或改变审批策略 |
| 可继续子代理 | 宿主管理的 continuable 子会话可追加任务、排队/编辑/删除、Steer 和停止当前轮次 | 外部投影仅保存已观察到的任务与结果，没有实际可路由的 continuation handle，因此继续提供原生只读详情。不能只把标记改成 continuable 就显示控制按钮 |

### 本轮最终结果

| 检查 | 结果 |
| --- | --- |
| 源码引用保护、类型检查 | 通过，28 个宿主开发包链接到目标源码 |
| 单元 / 集成 / 协议测试 | 56 个文件、599 项通过，32.60 秒 |
| 构建与打包闭包检查 | 通过；134 个打包文件、50 个运行时 JS 文件 |
| 固定夹具完整浏览器回归 | 52 项通过，78.33 秒；新增重连、滚动、Sending 共 12 项 |
| 真实 Agent 浏览器冒烟 | 4 项通过，80.35 秒；与固定夹具分开运行，合计 56 项不同浏览器用例 |
| 本地 tarball / 源码宿主安装启动卸载 | 通过；独立 DSH_HOME、原生装配、HTTP 200、客户端 bootstrap、卸载清理 |
| 独立 npm / pnpm 消费者安装 | 两者均只安装插件、ACP SDK、Zod，没有 DSH、React 或开发工具 |
| `git diff --check` | 通过 |

真实冒烟使用 `haiku`、`gpt-5.4-mini`、`gpt-5-4-mini-low`、`kimi-code/kimi-for-coding`。Claude 按此前授权向临时 profile 显式传递现有 `ANTHROPIC_AUTH_TOKEN`，本轮无认证或协议故障。四种真实 Agent 均确认宿主指令标记到达模型、回答保存为原生 stream、浏览器刷新后恢复；工具、审批、队列等完整行为由确定性夹具验收，不扩大真实冒烟结论。

实际验证平台是 macOS；类型检查、常规测试和插件构建使用 Node 24.19.0，Web / 浏览器 / 安装启动使用 Node 22.19.0 与已安装 Chrome，以匹配本地 fs-ext ABI。未实际运行 Linux / Windows CI 或长会话性能基准，也未重新做上游全依赖漏洞扫描。

这仍是源码适配提交，插件清单版本尚为 `0.1.2-rc.1.1`，未发布或推送。alpha.2 CLI 的 npm 版本存在，但本轮宿主验收使用准确标签的源码构建；独立 npm/pnpm 插件安装不等于已通过正式 npm 宿主装配。发布前仍需迁移开发获取方式、调整插件发布版本并通过现有发布门禁。
