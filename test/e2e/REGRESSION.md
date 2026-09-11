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

## 2026-09-08：0.1.3-alpha.1 发布验收

插件版本改为 `0.1.3-alpha.1`，兼容宿主仍精确限定 `0.1.3-alpha.2`；Git 标签与 npm `alpha` 渠道对应。所有源码开发链接已迁移为精确 npm 版本，删除源码链接替换脚本；常规开发无需上游 checkout。新增精确版本与实际安装路径检查，防止测试意外消费旧源码链接。DSH CLI 仅作为开发依赖加入，用于真实 npm 宿主的安装启动门禁。

DSH 发布包通过自己的必需 peers 引用部分宿主模块，因此开发工作区启用 peer 解析并将结果锁入 lockfile。该工作区设置不进入 tarball；插件自身的 DSH/Cordis/React peers 仍全部 optional，普通运行依赖仍只有 SDK 与 Zod。pnpm 工具版本固定为 `10.7.0`，与发布 CI 一致。初次离线冻结安装因本地缓存缺 SDK 产物失败，联网补齐后，未改动锁文件的冻结安装通过。

- npm 依赖环境类型检查通过；56 个文件、600 项常规测试通过（33.18 秒）。
- 构建、134 个打包文件及 50 个运行时 JS 文件依赖闭包通过。
- 52 项无密钥浏览器回归通过（76.51 秒）；本次依赖迁移未重复调用真实模型，前一节的四种实际模型验收仍属于当日源码适配回归。
- 真实 npm DSH CLI 在临时 DSH_HOME 安装本地 alpha tarball、装配原生 loop/UI、返回 HTTP 200 和客户端 bootstrap、卸载并清理均通过。本轮已补齐此前缺少的 npm 宿主安装验收，不再依赖源码 CLI。
- 发布门禁确认 `v0.1.3-alpha.1` → `alpha`，并继续拒绝分支引用和本地开发依赖；发布工作流对即将上传 npm 的同一个 tarball 再执行真实宿主安装门禁。
- 独立 npm / pnpm 用户安装均只产生插件、ACP SDK、Zod 三个包，没有额外安装 DSH、React 或开发工具。

本机仍使用 Node 24.19.0 进行开发检查和构建，Node 22.19.0 运行与本机 fs-ext ABI 匹配的 Web/安装回归。CI 分为三平台 npm 兼容性与 Linux 源码 scaffold 浏览器回归；源码只用于复用测试设施，不再代替发布依赖。

远端首轮 macOS npm CI 全部通过。Linux 发现 stdout 关闭早于 bootstrap 的启动错误，已将退出结果收集移到错误分类之前，并补充延迟 ENOENT 的确定性测试；终端“终止运行中进程”测试改为先观察 tick，避免把启动前取消误当作运行后终止。Windows 2025 runner 已使用 VS 18，而 pnpm 10 的 node-gyp 无法识别，改用 VS 2022 的 Windows 2022 runner，保留 Windows 验证。修复后的本机类型检查和 3 个相关套件的 99 项测试通过；跨平台结果以该修复提交的 CI 为准。

`23cea7d` 的 Linux、macOS、Windows npm CI 已全部通过。浏览器重连用例发现宿主 settlement 早于客户端最后一次渲染，消息数量断言改为等待 DOM 更新后检查；仍要求恰好两条消息且 ACP prompt 无重复。四种协议夹具的定向重连回归通过（15.49 秒），没有添加整例重试或删除原断言。

## 2026-09-08：ACP 终端接入原生后台任务

ACP `terminal/*` 创建的真实进程注册到宿主 `jobs`，由原生会话控制流和后台任务列表展示，未增加独立客户端状态或自定义任务列表。注册必须绑定现存的所属 Agent，并在启动进程前完成准入检查；宿主不提供 jobs 服务时保留原有终端路径。任务结束同时确认命令结果及 subprocess 托管范围退出，ACP 和宿主取消操作使用同一个终端句柄。结果发布前通过公开 `jobs.wait` 领取完成通知，避免原生 tool-jobs 再触发模型轮次；ACP 输出仍可读取。

`terminal-jobs.e2e.mjs` 在 Claude、Codex、Devin、Kimi 四种协议夹具下运行同一组断言，使用真实子进程与原生浏览器界面。覆盖运行状态、刷新、离线期间完成后的重连、跨会话不可见及取消拒绝、退出码 0 / 7、宿主 registry 取消、ACP 取消、输出保留，以及终端在父 prompt 结束前完成时没有额外模型步骤。退出由临时文件控制，不依赖模型速度或生成文案。宿主列表当前没有输出或停止按钮，原生取消测试调用真实 registry，并不声称验证了不存在的 UI 控件。

- 类型检查、构建、清单和打包闭包检查通过；新增的宿主开发依赖和可选 peers 精确固定为 `0.1.3-alpha.2`。
- 56 个单元 / 集成测试文件、605 项通过（14.43 秒），包括先准入后启动、等待托管范围退出、主命令已结束时仍可取消范围和取消后释放。
- 完整固定夹具浏览器回归 56 项通过（96.86 秒）；4 项真实模型冒烟显式跳过。
- 完成通知时序收紧后重新通过类型检查和构建，并定向重跑四项 jobs 浏览器测试，包含最后加入的离线完成及父轮次内提前完成场景，全部通过（27.06 秒）。

本轮使用 Node 24.19.0 进行常规检查与构建，Node 22.19.0 和已安装 Chrome 运行浏览器回归；未调用真实模型、未运行跨平台 CI，也未发布或替换用户正在运行的插件。任务记录随宿主进程存活，不跨 DSH 重启恢复；未通过 ACP 暴露的 Agent 内部后台进程仍无法列出。

## 2026-09-08：审计页布局与回放记录分析

审计视图补齐与原生 TrajectoryView 相同的 `data-conversation-composer-overlay` 接入标记，宿主负责固定视图高度、浮动输入栏位置及隐藏对话宽度拖动条。列表和详情各自滚动，外层不再按对话页滚动；切换审计记录时重新挂载详情内容，重置滚动位置和 JSON 展开状态。继续复用原生 JsonTree 的交互与复制能力；alpha.2 没有换行选项，因此仅在审计 payload 内覆盖宽度与换行样式，并让详情容器统一承担纵向滚动。

四种协议夹具新增同一审计布局用例：通过真实 sidecar 写入 80 条记录并分页读取，比较审计与原生轨迹的视口几何，验证滚动到底部时工具栏和详情标题可见、切换记录回到详情开头、长 JSON 折叠及展开后无横向溢出、窄窗口详情可见，以及回到 Chat 后宽度拖动条恢复。

回放策略按用户要求仅分析，未修改。当前 adapter 每轮校验持久化绑定并调用 `restore()`；runtime 已持有同一 ACP 会话时直接返回，不发恢复 RPC。只有没有活动会话时，才优先 `session/resume`，或使用 `session/load` 接收暂存回放。外层目前把这些成功路径都记成 `replay-assessment/not-compared`，所以审计行数不代表实际恢复请求数。用户 profile 中 21:34 的记录含 14 条暂存通知、167 个字符，21:37 与 21:39 均为零；零回放也可能来自无回放的 resume，现有记录无法逐条区分。DSH 历史仍为展示真源，不用外部 Agent 的不同投影覆盖或机械比较它；值得后续调整的是复用、恢复和真实回放的审计分类，而非直接移除绑定校验。

类型检查、构建与打包闭包通过；审计与客户端注册的 11 项相关单元测试通过。四种审计布局定向浏览器测试全部通过（17.24 秒），包含窄窗口和宽窗口切回 Chat 的检查。初次测试使用了与实际翻译不符的详情名称，以及窄窗口必须显示宽度手柄的错误假设；修正为语义区域定位并在宽窗口检查原生手柄，未削弱审计布局断言或添加整例重试。

完整回归曾出现所有 60 项业务断言通过、Devin 夹具收尾超时的情况；定向复测 14 项通过，并通过收尾阶段诊断定位到 Chrome `browser.close()` 偏慢，未进入宿主释放。测试改为独立清理浏览器和宿主，两个清理结果均检查，保持原有 120 秒 hook 上限。最终完整运行正常退出：60 项固定夹具浏览器测试通过（106.29 秒），4 项真实模型冒烟跳过。未调用真实模型、未发布或替换用户当前插件；未对 Chrome 偶发关闭缓慢的内部原因作进一步结论。

## 2026-09-08：Agent 审计精简为 ACP 诊断

保留原生会话 Tab，将中英文名称统一为“ACP 诊断 / ACP Diagnostics”。默认“异常”展示已记录的失败、恢复问题与展示限制；审批、文件和终端事实归入“操作记录”，正常会话连续性、复用或恢复记录归入“技术记录”。历史事实没有删除或重写，restore、审批及 Agent 执行策略未调整。会话连续性文案不再指向特定 Agent；旧 not-compared 记录明确不能区分连接复用与真实恢复，也不作为异常提示。

行标签按实际严重程度着色，审批显示原始选项对应的允许或拒绝；未记录选项语义的旧数据不推断授权。终止操作标为“已请求终止”，终端审计补记 cancellation intent，区分主动停止、非零退出和意外信号退出。详情从已记录的 reason/detail/cause/note 与内容限制原因中提取说明，无原因字段时明确提示；仍使用有界脱敏数据和原生 JsonTree。搜索仅匹配已加载记录中的摘要及原因，不宣称能查询 Agent 全部内部日志。

宿主先按视图筛选再返回页面，避免首批正常检查点遮住后续错误；每次扫描最多 1000 条原始记录，游标包含已扫描但被过滤的记录，达到上限时明确提示还有未检查记录。单元测试覆盖 1200 条正常记录后的错误和继续分页。当前恢复状态使用既有 recoverySnapshot 单独展示并标为上次刷新时的状态，沿用输入栏的恢复操作；不会伪造为历史错误或在恢复正常后删掉历史异常。

四种协议夹具各增加一项诊断分类浏览器用例：正常空状态、150 条技术记录之后的读文件错误、原因搜索、允许与拒绝文案、技术分页，以及当前恢复状态与历史事件的独立更新。原有布局和后台任务用例继续保留。

- 最终类型检查、构建与打包闭包通过：140 个打包文件，53 个运行时 JS 文件。
- 最终 57 个常规测试文件、616 项通过（16.43 秒）。
- 完整浏览器回归 64 项通过，4 项真实模型测试显式跳过（142.85 秒）；Kimi 的 Chrome 关闭触发了已有的慢清理提示，最终在原有 hook 时限内正常退出。
- 最后补齐 cause/note 原因提取和意外信号退出分类后，重新构建并定向复验四种夹具的诊断布局、分类与 jobs：12 项通过（48.35 秒）。

本轮未调用真实模型、未运行跨平台 CI、未发布或替换用户当前运行的插件。运行环境仍为 Node 24.19.0 常规检查、Node 22.19.0 与本机 Chrome 浏览器回归。

## 2026-09-08：双语、文档与旧数据兼容核查

核对中英文词典的全部 226 个键、非空内容、插值参数和英文词典中的中文残留。修正诊断加载提示中遗留的“审计”称谓、分页结束提示的分类范围，以及 Agent 布尔选项 On/Off 和缺省模式名称的硬编码。Agent 提供的标识符不再因为恰好等于 allow_once 等状态码而被误翻译；原始命令、模型名和技术原因仍保留原文。

中英文 README 删除了早期“升级后重建私有数据”的通用建议，改为说明本次更改仍使用 SQLite v2、按实际 DSH_HOME 读取、不需要重置，并区分现存恢复保护与诊断展示。明确极早期 JSONL 无自动迁移、绑定前错误需要检查健康错误编号/宿主日志，以及旧终端审计不会被恢复成运行中的 jobs。文档本地链接检查通过，回归文档中的历史结论保留为当时记录。

新增真实 SQLite 重新打开用例：读取缺少新字段的旧审批、终端、文件和回放记录，检查读前读后的原始 payload 相同，有效 binding 与 healthy 恢复状态保持不变。发现并修正旧终端退出记录的归因边界：缺少 terminationRequested 时无法区分主动终止和故障，因此非零/信号退出归为“退出原因待确认”的提示，不断言失败，也不改变恢复或执行状态。没有修改用户的实际数据目录。

类型检查、构建与打包闭包通过；18 个相关常规测试文件、251 项通过（1.80 秒），覆盖客户端、持久化、诊断投影及远程分页。双语浏览器检查通过原生设置将界面切换为中文，验证 ACP adapter 版本标签、诊断标题与分类、审批结果和旧终端说明，再恢复英文以保证其他用例不受影响。

四种协议夹具的双语诊断与模型选择共 8 项浏览器测试通过。布局用例初次仍等待旧的英文分页结束文案，4 项因此失败；同步为新的“当前分类全部记录”文案后，4 项布局测试全部通过（18.77 秒），保留原有几何、滚动和换行断言。合计 12 项相关浏览器场景已通过，没有调用真实模型。本次没有发布、推送或清理用户本地数据。

## 2026-09-09：0.1.5-alpha.1 原生路径适配

宿主为 `dsh-v0.1.5-alpha.1`（`5dda764ed3aa`），插件版本为 `0.1.5-alpha.1`，工作分支 `feature/0.1.5.alpha`。运行依赖保持 ACP SDK 与 Zod；DSH 的可选 peers、开发 npm 依赖、engines.dsh 和 CI 目标同步为精确版本。源码 scaffold 使用宿主的 pnpm 11.7.0，插件仍使用 pnpm 10.7.0。

- 宿主的系统指令已归一化到首条 system message，适配器从该位置读取；显式单次 system 参数仍优先。验证 A → B、清空、插件卸载和实际 ACP dispatch，保留 DSH 的动态上下文与后续步骤扩展。ACP 不声明无法等价执行的 in-history system 更新能力。
- 活动记录不再写入或依赖旧 request/header 序号，改用稳定 ACP 身份和原生 Step data。界面订阅宿主 Store，在最终记录出现后卸载临时活动视图；覆盖紧凑历史、旧序号偏移以及刷新、重连后不重复展示。
- 新子代理投影直接写入 V3：删除非法 trigger，先开始 step 再追加用户消息，继续用原生 AssistantStreamAccumulator。通过真实 SessionHandle 读回校验版本与事件顺序，再打开原生只读详情并刷新。
- 按用户决定删除旧投影的专用迁移路径。宿主拒绝的 V1/V2 投影不额外恢复、不重写、不删除；夹具验证不会打开或创建旧日志，也不会改动旧 sidecar。主会话迁移仍由 DSH 负责，SQLite 绑定无需清理。这取代本文件早期验收中保留专用迁移的决策。
- ACP Read / Diff 中有明确单一文件路径时，文件名调用宿主 openFile，在原生右侧栏预览。ToolRow 不是公开组件，因此仅保留文件链接的最小样式和键盘事件适配；文件读取、侧栏路由与预览状态均由宿主负责。未把 ACP 活动伪装成 DSH 工具执行。

验证结果：

| 检查 | 结果 |
| --- | --- |
| 类型检查、构建和打包闭包 | 通过；150 个打包文件、54 个运行时 JS 文件 |
| 常规测试 | 59 个文件、623 项通过 |
| 无密钥浏览器回归 | 64 个场景全部覆盖通过；完整运行 62 项通过后，修正新增子代理测试的 header 取值位置，定向复验 4 种夹具通过 |
| npm 宿主干净安装门禁 | 最终 tarball 安装、原生装配、HTTP 200 / 客户端启动和卸载均通过 |

浏览器用例覆盖原生输入、上传、消息/图片恢复、Read/Diff、文件侧栏、双语诊断、审批允许/拒绝、停止、模型切换、宿主插件扩展、断线重连、只读子代理和后台任务。jobs 用例的退出码信号改为临时文件写完后 rename，防止子进程把尚未写入的空内容当作退出码 0；保留非零退出必须失败及无额外模型轮次的断言。初轮新增文件链接用例也纠正了对普通 Markdown 链接的假设，最终验证的是实际 Read / Diff 文件名入口。

本轮使用 Node 24.19.0 与本机 Chrome。上游两个大型可选模型二进制下载失败后，由 pnpm 跳过；源码库和 Web 构建成功，无密钥夹具不使用这两个二进制。4 项真实 Agent 冒烟显式跳过，未调用真实模型、未运行远端跨平台 CI、未发布或改动用户实际 DSH_HOME。部分 Chrome 清理出现慢关闭提示，但均在既定 hook 时限内完成。

## 2026-09-09：死代码清理与真实 Agent 回归

从三个生产入口检查 TypeScript 导入图，70 个生产模块均可达，未发现可整文件删除的断开模块；同时检查导出符号、CSS 类名和测试引用。删除已无读写方的 `activityRequestHeaderSeq` 类型及校验、活动节点未使用的 `cwd` 属性要求，以及让零测试也通过的配置。旧日志夹具与 React / UI 替身仍有实际用途，予以保留；旧 payload 的额外字段被忽略，不需要清理本地数据。这些静态检查不等于证明所有分支都可达。

类型检查、构建及打包闭包通过（150 个打包文件、54 个运行时 JS）；59 个常规测试文件、623 项通过。真实冒烟改为每种 Agent 两轮无工具请求，宿主每轮提供不同随机标记，验证同一会话采用更新后的指令、原生 assistant stream 持久化、每轮刷新恢复及无浏览器页面错误。未找到预设小模型时直接失败，不回退到昂贵默认模型。

| Agent | 本次选择 | 两轮结果 | 场景耗时 |
| --- | --- | --- | --- |
| Claude | `haiku`，目录对应自定义 `deepseek-v4-flash` | 通过 | 22.0 秒 |
| Codex | `gpt-5.3-codex-spark`（目录无 Mini） | 通过 | 31.4 秒 |
| Devin | `swe-1-7-medium` | 通过 | 18.6 秒 |
| Kimi | `kimi-code/kimi-for-coding`，K2.7 Coding | 通过 | 23.3 秒 |

4 项真实冒烟全部通过，整次运行 147.85 秒；场景耗时含初始化与浏览器操作，不是纯模型延迟。使用 Node 24.19.0、本机 Chrome、独立 DSH_HOME 和临时工作区，结束后关闭浏览器与宿主并清理测试目录。经授权读取现有 Agent 登录，Claude 密钥仅显式注入临时 profile；用户运行中的 DSH_HOME 未改动。实际目录、两轮回答与截图保存在 gitignored `.local/e2e-live/`。

本次真实测试覆盖连接、宿主指令及消息恢复，不宣称真实模型的工具、审批、子代理与 jobs 已逐项验收；64 项无密钥协议浏览器回归本次未重跑，其 0.1.5 适配结果见上一节。未提交、推送或发布。

## 2026-09-10：0.1.5-alpha.2 与原生设置控件

插件与 DSH 目标同步为 `0.1.5-alpha.2`，reference 为 `b2e3b2a01258`；精确 npm 开发依赖、可选 peers、engines.dsh、锁文件、CI scaffold 标签及双语 README 一并更新。运行时 dependencies 仍只有 ACP SDK 和 Zod。

alpha.2 的 `dsh-client-store` Node 入口保留 zustand / immer 的 bare import，上游却将它们改为 devDependencies。插件暂时显式加入 `zustand@4.4.7`、`immer@10.2.0` 两项开发依赖，解决客户端 Node 测试无法加载真实 Store 的问题。直接导入已发布 Store 入口成功；浏览器仍使用宿主模块表，没有复制 Store 实现或将状态引擎改为插件私有实例。上游修复 Node 入口闭包后可移除这项开发补偿。

设置页标准按钮采用原生 Button 的 primary / outline / ghost 和紧凑尺寸，单行字段与诊断搜索采用原生 Input，CSS 净减少 103 行。危险操作颜色、单行字段错误/禁用状态、多行 textarea、添加卡片和诊断 JSON 换行保留必要适配。未改变配置校验、凭据处理、恢复、审批或 ACP runtime 语义。

四种协议夹具各新增一个设置编辑浏览器用例，验证空名称禁止保存、取消保留原值，以及保存并刷新后配置仍存在，再恢复原名称。编辑状态截图保存在 gitignored `.local/e2e-settings/`，已查看实际浏览器截图核对字段与控件布局。既有诊断搜索、窄窗口布局、文件预览、审批和 jobs 回归继续使用原生宿主组件。

- 类型检查、已发布开发依赖校验、构建和打包闭包检查通过：150 个打包文件、54 个运行时 JS 文件。
- 常规测试：59 个文件、623 项通过（14.74 秒）。
- 完整浏览器回归：68 项全部通过（209.33 秒），4 项真实模型冒烟显式跳过；新增设置编辑、既有审批/诊断/恢复/子代理以及 jobs 均通过，没有新增重试或放宽原有断言。
- alpha.2 npm 宿主干净安装门禁通过：临时 DSH_HOME 安装、叠加装配、HTTP 200/client bootstrap、卸载均正常。

运行环境为 Node 24.19.0、本机 Chrome；reference 的 alpha.2 原生模块、Host、Client 和 Web scaffold 已重新构建。首次依赖下载超时，保留冻结锁文件与供应链校验、延长超时后安装成功；两个大型可选 Agent 二进制最终被 pnpm 跳过，本轮协议夹具不使用它们。reference 工作区保持干净。未运行远端跨平台 CI、未调用真实模型、未修改用户实际 DSH_HOME，也未提交、推送或发布。

## 2026-09-10：alpha.2 发布前真实 Agent 冒烟

经授权，在独立临时 DSH_HOME 和工作区中运行全部 4 项真实 Agent 测试，4 项通过（73.39 秒）。每种 Agent 验证同一会话两轮采用新的宿主随机标记、原生 assistant stream 持久化、每轮浏览器刷新后恢复，且没有页面错误。

| Agent | 实际选择 | 两轮结果 | 场景耗时 |
| --- | --- | --- | --- |
| Claude | `haiku`（现有自定义服务路由） | 通过 | 20.5 秒 |
| Codex | `gpt-5.3-codex-spark` | 通过 | 19.0 秒 |
| Devin | `swe-1-7-medium` | 通过 | 11.7 秒 |
| Kimi | `kimi-code/kimi-for-coding` | 通过 | 19.9 秒 |

沿用现有 Agent 登录；Claude 仅向临时 profile 显式传递已有认证环境变量，未写入测试证据或修改用户配置。测试不读取项目文件，不调用工具；真实模型的工具、审批、子代理与 jobs 不在这 4 项冒烟结论内，相关产品行为由本版本已通过的 68 项协议浏览器回归覆盖。结果和截图保存在 gitignored `.local/e2e-live/`。

发布版本门禁确认 `v0.1.5-alpha.2` 对应 npm `alpha`。陈旧构建产物检查通过：临时源文件删除后，其 JS 和声明文件从构建目录及 tarball 清单同时消失；最终构建恢复为 150 个打包文件、54 个运行时 JS 文件。

## 2026-09-10：0.1.5-rc.1 适配与发布维护精简

插件及宿主目标为 `0.1.5-rc.1`，reference 为 `183f08e9c6`。DSH npm 开发依赖、可选 peers、锁文件、README 与 E2E 指南同步，保留 zustand / immer 的精确开发补偿；运行时依赖仍只有 ACP SDK 和 Zod。Agent、Session、subprocess、子代理与 jobs 没有新增执行适配。

宿主目标唯一来源改为 package.json 的 engines.dsh，scripts/dsh-target.mjs 校验精确版本并派生源码标签；CI checkout 读取该标签，版本断言引用 manifest。发布契约检查双语 README 和当前 E2E 指南版本，覆盖 alpha → alpha、rc → next、稳定版 → latest。发布工作流删除打包前重复的 typecheck/test/build，以 npm pack 的 prepack 执行完整验证一次，保留同一 tarball 的安装门禁及 OIDC 发布。修正 ACP 工具外层行与原生详情组件关系的过时注释；没有改变界面或权限行为。

- 实际运行 npm pack / prepack：类型检查、59 个文件 627 项常规测试、构建及包闭包全部通过。包包含 150 个文件、54 个运行时 JS。
- 发布包安装门禁：临时 DSH_HOME 安装、原生叠加装配、HTTP 200/client bootstrap、卸载通过。
- rc.1 原生模块、Host、Client 和 Web scaffold 重建成功。完整 E2E 初轮 71/72 通过（337.75 秒）：68 项协议浏览器回归全部通过，真实 Claude、Devin、Kimi 通过；Codex 当次目录没有匹配的 Mini/Spark，在发送请求前被小模型选择门禁拒绝。
- 保留选模失败时的模型目录证据后，定向重新查询 Codex 目录出现 Spark；使用同一小模型策略运行，1/1 通过（23.97 秒）。未放宽断言或增加自动重试；初次未保存的目录内容无法追溯，不能据此确定目录差异的来源。
- 四种真实 Agent 两轮验证结果：Claude `haiku` 12.4 秒、Codex `gpt-5.3-codex-spark` 22.8 秒、Devin `swe-1-7-medium` 85.1 秒、Kimi `kimi-code/kimi-for-coding` 20.7 秒。场景耗时包含连接与浏览器操作，不是纯模型推理时间。

真实冒烟仅验证宿主指令更新、消息及持久 stream、每轮刷新恢复和页面无错误；工具、审批、子代理与 jobs 使用确定性协议夹具回归。模型使用现有服务路由与登录，Claude 认证仅显式注入临时 profile。用户实际 DSH_HOME 未修改，reference 工作区保持干净。两份工作流 YAML 解析及 CI 标签派生命令验证通过；云端运行结果以本次标签触发的 Actions 为准。

## 2026-09-10：原生 Agent Teams 接入

宿主仍为 `dsh-v0.1.5-rc.1`。单包内新增可选 Teams 模块，不自动安装或启用宿主实验性 profile。九个协调工具通过会话专属 MCP 转发到原生 ToolRuntime，成员、任务、消息、继续运行与中断由 DSH 管理。成员使用创建时主会话的 ACP Agent、模型与推理配置，当前只接受 fresh context，共享 cwd。

复用原生团队面板和可继续的成员详情；主会话新增待处理请求入口，打开成员原有的审批/问题卡，不复制请求。协调权限只针对当前连接的具体 Teams 工具按次通过，普通命令、文件与表单保持原有审批。工具行使用原生名称，不展示内部 MCP 随机前缀。

真实回归发现并修复三种接入差异：Devin 需通过临时原生 MCP 配置使工具对模型可见；Codex 使用与工具调用关联的授权表单；Kimi 把完整工具名称放在标题字段。原生子代理完成通知携带的 reasoning 块不转成 ACP 用户文本，只转发关闭通知与可表示的回答内容。消息仍在 DSH 步骤边界送达，不模拟 ACP 内部实时消息注入。

| 验证 | 结果 |
| --- | --- |
| 类型检查、完整常规测试 | 61 个文件，637 项通过 |
| 完整无密钥浏览器回归 | 72 项通过，包含四种协议的 Teams 专项 |
| 打包与依赖闭包 | 159 个包文件、58 个运行时 JS，通过 |
| 精确 npm 宿主安装门禁 | 临时 DSH_HOME 安装、Web bootstrap、卸载通过 |
| Claude，`haiku`（本机现有服务路由） | 真实成员创建与消息回传通过，23.6 秒 |
| Codex，`gpt-5.3-codex-spark` | 真实成员创建与消息回传通过，45.7 秒 |
| Devin，`swe-1-7-medium` | 真实成员创建与消息回传通过，20.0 秒 |
| Kimi，`kimi-code/kimi-for-coding` | 真实成员创建与消息回传通过，48.8 秒 |

耗时包含连接、成员启动与浏览器操作，不能视为模型推理基准。真实测试验证同 Agent / 模型、共享工作区、宿主工具实际执行、成员发信、主会话收到结果和原生面板；九个工具、普通审批保留、后续唤醒、中断和完成通知由四种确定性协议 E2E 覆盖。失败后按具体协议证据修复并定向重跑，没有添加自动重试或手动批准团队协调请求。

运行环境为本机 macOS、Node 24.19.0 和 Chrome，未执行远端跨平台 CI。新功能不修改已有持久化格式，不要求清理本地数据；旧的只读外部投影不会转换为团队成员。实验服务撤销或成员释放后，连接能力立即失效；临时服务和 Devin 配置在清理时移除，原用户 MCP 配置与已有权限保留。真实证据位于 gitignored `.local/e2e-live-teams/`。本轮未提交、推送或发布，版本号未变。

最终 prepack 曾暴露已有 filesystem 用例的 10 ms 真实读取调度抖动。该用例改为受控触发请求的 timeout signal，继续断言超时审计、同一 handler 后续成功读取，以及审计故障不改变写入成功结果；生产超时设置未改。

## 2026-09-10：Teams 正反向与多模型复核

最终支持边界调整为**同一 ACP Agent、允许多个模型**，沿用原生继承规则：Lead 可以切换模型；新成员继承创建时的模型，已有成员和其冷恢复使用自己的原模型。成员详情沿用宿主不提供模型选择入口的行为。跨 Agent 切换继续走现有的新会话确认，直接 API 混用由既有 backend guard 拒绝，没有保留重复的 Teams 拦截层。

创建成员的 MCP schema 不提供 Agent/provider/model 覆盖字段；桥接层明确拒绝这些额外参数和 fork，不能用被忽略的参数伪装成成功的跨 Agent／指定成员模型操作。选择不同成员模型应先切换 Lead，再创建新成员。

- 四种 Agent 协议各运行允许、拒绝、Lead 中断等待审批成员三种流程，共 12 项。只有成员普通 bash 请求进入原生审批；拒绝和中断不会走成功分支。成员不能继续创建嵌套成员，错误工具调用不会获得额外的通用授权。
- 原生任务面板验证创建、编辑、指派、完成、重开和删除；并发写触发 CAS 冲突提示和刷新。MCP 路径验证过期版本、依赖未完成、目标成员不存在、fork 和 Agent/model 覆盖参数的拒绝。
- 边界 3 项：关闭原生 profile 时 UI 与服务都不存在；同 Agent 的 A/B 成员独立审批、A 在 Lead 切到 B 后冷恢复仍用 A、切换其他 Agent 创建无旧成员的新会话及直接 API 拒绝；原生 provider 的 A/B 继承与模型切换不受插件影响。
- 最终 prepack：61 个测试文件、637 项通过，类型检查、构建和模块闭包通过；只生成本地验证包，没有发布。
- 全量浏览器批次为 82 通过、1 失败、4 个真实连接默认跳过。失败来自新增反例等待 Teams 专用错误码，但既有 backend guard 已先行拒绝；删除重复防护、改为验证实际拒绝和没有跨 Agent request/header 后，边界文件 3/3 通过（15.75 秒）。因此 83 个唯一浏览器场景最终均有通过结果；没有把最初批次写成全绿。
- 真实 Teams：Claude Haiku 26.98 秒、Codex Spark 39.87 秒、Kimi Coding 59.20 秒均完成成员创建和消息回传。Devin 双模型流程 49.25 秒：先用 SWE-1.7 Medium 创建 calculator，再切 GPT-5.4 Mini Low 创建 checker；同一团队两轮都成功汇总。时间包括连接与 UI 操作，不是推理耗时基准。

**已知上游显示缺陷（未在插件中改写）：** `TeamRoster.list()` 的 Lead 模型来自初始 `root.options.model`，休眠成员也回退到该值。多模型团队的原生面板因此会把休眠的 checker 显示成 SWE。实际创建结果和解压后的成员持久化 request/header 明确记录 checker 使用 `gpt-5-4-mini-low`，calculator 使用 `swe-1-7-medium`。这影响标签准确性，不影响本次验证的实际模型执行和 A 成员冷恢复；不应通过复制原生面板或篡改执行配置来修饰标签。

本机 Chrome 的真实双模型窗口按要求保留，实例信息在 `.local/e2e-live-teams/review-instance.json`；查看其中的专属 stopFile 后才能关闭对应实例。该保留模式已完成业务断言和证据写入，但测试进程等待人工结束，不算一个已经退出的 Vitest 通过批次。真实结果见 `.local/e2e-live-teams/`，路由与持久化模型证据见 `.local/teams-review/`。本次未提交、推送或发布；用户原有运行实例未关闭。

## 2026-09-11：0.1.5-rc.2.1 / DSH rc.2 验收

宿主更新为 `dsh-v0.1.5-rc.2`（`fb2c4b9e69`），开发与兼容声明均使用精确 npm 版本 `0.1.5-rc.2`。新增审批卡使用 `conversation.input.dock`、原生 Button、状态色和 `uiSession.pendingInteractions`；只提供进入原生成员交互的入口，不复制审批，不批量放行。人数表示待处理成员数，宿主同一会话内部的后续请求仍由原生交互调度。主会话保持可交流，普通消息不构成批准。

首轮问题有两层：委派初始化写入 `never`，旧插件在模型 stream 阶段才写入 `ask`；原生 `subagent:delegation` 上下文又固定声明需要审批的操作会自动拒绝。现在在同步 `agent/created` 事件投影 ACP 权限，在公开 `system-prompt/assemble` waterfall 中只修正 ACP 的具名委派上下文。其余系统段落、工具、变量与其他插件上下文保留，原生成员仍使用原有策略。测试检查首轮实际落盘的 runtime-context snapshot 和收到的 ACP prompt，不能只检查 stream 开始后的策略事件。

| 原生交互 | ACP 实现与边界 | 验证 |
| --- | --- | --- |
| Teams 开关与入口 | 由原生 Teams profile 提供服务；插件不自行启用 | 关闭、原生 provider 与 ACP 正反例 |
| 成员与模型 | 复用原生创建和冷恢复；同 ACP Agent 可多模型，新成员继承创建时的模型，已有成员保持原配置 | 两成员、主会话切换、冷恢复请求头；跨 Agent 新会话及直接 API 拒绝 |
| 上下文 | ACP 仅 fresh；原生 fork 保留 | MCP schema 和执行端拒绝 fork / Agent、provider、model 参数覆盖 |
| 共享任务 | 原生任务板、Remote API、版本校验和九个协调工具；没有自建任务存储或任务 UI | 创建、读取、领取、编辑、分配、完成、重新打开、删除；依赖阻塞、解锁与陈旧版本拒绝 |
| 成员审批 | ACP 保留交互审批，原生成员默认 never；这是执行方差异 | 四协议 allow / deny / cancel；首轮上下文、冷恢复；协调工具不产生额外审批 |
| 主会话提醒 | 输入框上方持久卡片，按成员列出；新增请求展开，可折叠、刷新恢复 | 两成员并发、独立批准、中英文、窄屏和输入框位置 |
| 消息、等待、中断 | 使用原生邮箱和生命周期；ACP 内部一次响应结束后，宿主在步骤边界交付下一条消息 | 原生九工具执行、成员回信、唤醒、中断、取消和失效能力撤销 |

原生 Teams 的 67 项官方核心测试通过，覆盖任务、持久化、投影与不变量；它们是所复用宿主功能的补充证据，不能代替 ACP 桥接或真实模型验证。

保留的上游限制：休眠成员和 Lead 的名单模型标签可能使用初始模型；实际请求以 `request/header` 为准。原生完成通知复制 reasoning block，但 ContextBody 尚不能渲染它，可能出现 Unknown content；成员详情仍使用原生推理组件。本次没有复制原生组件或改写会话输出掩盖这两项限制。

清理审查覆盖生产导出、测试辅助入口、构建依赖闭包和中英文文案。移除了 9 个仅在文件内部使用的导出标记；相关函数和测试仍有真实调用，予以保留。旧顶部提醒入口被输入框卡片替换，没有保留两套通知。另修复旧 macOS CI 环境继承测试的启动/终止竞态：先等待一次性子进程自然完成，再执行清理，不放宽退出码与凭据隔离断言。

既有会话、Teams 日志和 sidecar 无须手动清理；本次未更改其格式或主键。旧会话下一次请求按当前上下文组装；不会重写历史说明。宿主不支持的旧专有子代理投影仍按既定策略拒绝迁移，不扩大为主会话阻断。

| 最终本地验收 | 结果 |
| --- | --- |
| npm pack / prepack | 类型检查、61 个文件 639 项测试、构建与闭包全部通过；161 个包文件、59 个运行时 JS、43 个精确发布依赖 |
| 完整确定性浏览器回归 | 同一批次 83 项全部通过，含 15 项 Teams、4 项 jobs；4 项真实连接默认跳过 |
| 四种真实 Agent 普通两轮与恢复 | Claude Haiku、Codex Spark、Devin SWE-1.7 Medium、Kimi Coding 均通过 |
| 四种真实 Agent 共享任务 | 四者均真实创建计算及依赖复核任务，成员领取并完成计算、发信，Lead 完成复核；检查实际任务所有者、状态及原生面板 |
| Devin 双模型及普通审批 | SWE-1.7 Medium → GPT-5.4 Mini Low，两轮任务通过；全新 permission-review 成员首轮请求普通命令审批，批准前文件不存在，原生 Allow once 后文件内容正确 |
| 首轮缺陷反向验证 | 分别移除早期策略投影、具名委派上下文修正，两种变体都被首轮断言检出；恢复最终构建 |
| 精确 tarball 安装门禁 | npm DSH rc.2，临时 profile 安装、原生叠加、HTTP 200 / client bootstrap、卸载通过 |

真实双模型演示初次被断言拦截：切换后的模型仅返回新 token 和结果，没有调用工具创建第二组任务。保留失败证据，将下一次请求明确为独立新任务后完整重跑通过；未增加自动重试或放宽任务断言，单次模型不执行工具不能算成功。最初多行测试指令曾被浏览器输入辅助函数按 Enter 提交，现统一为单行再输入，避免拆成多个用户回合。

最终 Chrome 演示完成业务断言并写入 passed 证据，保留实例等待用户查看，因此保留模式的 Vitest 进程尚未退出。共享任务四 Agent 证据在 gitignored `.local/rc2-real-teams/`；最终双模型、真实审批及截图在 `.local/e2e-live-teams/`，失败演示证据另存 `.local/rc2-review-first-attempt/`。云端 CI 和 npm 发布结果以同一提交及版本标签的 Actions 为准。

首次云端 CI 暴露两项测试基础设施问题：Linux / macOS 的离线安装门禁缺少 MCP SDK 间接依赖的缓存元数据；Windows 的 200 ms 超时测试在子进程来得及写启动日志前终止，导致日志计数为零。安装门禁已删除本地依赖覆盖，改为使用临时 pnpm store 按真实发布依赖联网安装，安装、启动、卸载在本地重新通过。超时用例改为观察真实宿主 spawn 调用次数，仍严格检查两次调用仅启动一个进程以及原有超时错误，保留真实 subprocess 服务和原有期限。

## 2026-09-12：Agent 选项实时同步

选项改用 DSH 原生快照流；首次会话响应和后续配置通知均能触发显示，运行中只读，重连获取最新状态，切换会话取消旧订阅。不改变本地存储格式。

- 类型检查、构建、严格消费方类型及打包检查通过；63 个文件、667 项常规测试通过。
- Chrome 完整固定夹具回归：90 项通过（含新增 8 项选项用例），1 项旧子代理测试读取早于日志写入完成；修正为等待完整日志后，四种协议的子代理详情复测全部通过。最终覆盖的 91 项固定夹具用例均通过；4 项真实模型测试未启用。
- 未直接验证桌面安装包；未提交或发布。本轮日志位于 `.local/agent-control-investigation/`。

## 2026-09-12：新会话权限隔离

ACP 权限投影从 Agent 创建时移到领取输入时，并在原生权限提示词组装前完成。模型归属读取会话待选配置、历史请求及宿主默认选择；Teams 成员保留自己的模型。空会话选择原生模型不再被 ACP 初始配置改成 Custom；原生模型切换继续保留用户权限，不强制回到默认值。委派说明使用组装完成后的实际 provider。

- 新增四种协议的宿主 E2E：ACP 默认下新建再选原生、显式 Full access / Custom 保留、原生历史禁止原地切换 ACP、首轮 ACP 审批、重复请求幂等、新会话默认值与空会话默认模型变化。
- 相关 E2E 同批 19 项通过（4 项权限隔离、15 项 Chrome Teams）；类型检查、63 个文件 667 项常规测试、构建及严格打包检查通过。使用本地协议夹具，未调用真实模型；未直接验证桌面安装包。
- 不修改存储格式，无须清理数据。历史已被写为 Custom 的会话不自动重置，因为无法与用户主动设置的同一组合可靠区分；需要时在原生权限选择器中重新选择所需权限。

本轮日志位于 `.local/permission-investigation/`；未提交或发布。
