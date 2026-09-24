# ACP adapter

[English](README.en.md)

[更新记录](CHANGELOG.md) · [版本发布与安装信息](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases)

在 DSH 会话页面使用 **Claude · Codex · Devin · Kimi**。

本版本仅支持 DSH `0.1.7-rc.1`。点击 ACP 成员或子会话会在原生侧栏打开，保留主会话；Teams 成员的请求仍可直接在主会话审批。

升级后，已有 Agent 配置会从旧设置文件自动导入当前 DSH 配置；当前配置中已设置的 Agent 列表（包括空列表）会保留。主会话过程使用 DSH 原生的紧凑、标准、详细和完全展开模式，工具、思考和过程分组随宿主设置切换。

## <img src="assets/readme/icon-preview.svg" width="24" height="24" alt="" /> 功能预览

以下截图来自此前版本中 **Devin · SWE-1.7 Medium** 的真实操作；当前版本的布局以 DSH 原生界面为准。

添加 Agent、检查连接，并查看插件版本：

![ACP adapter 设置、插件版本与 Devin 连接](assets/readme/acp-settings.zh-CN.png)

在 DSH 会话中使用 Agent 模型、推理强度和原生工具展示组件：

![Devin 使用 SWE-1.7 Medium 实际修改文件](assets/readme/acp-session.zh-CN.png)

ACP 审批复用 DSH 原生审批卡，批准前可查看完整命令：

![ACP 命令在 DSH 原生审批卡中完整显示](assets/readme/acp-permission.zh-CN.png)

子代理的真实检查结果通过 DSH 原生只读详情展示：

![ACP 子代理的原生只读详情](assets/readme/acp-subagent.zh-CN.png)

“ACP 诊断”查看异常、操作与技术记录；点开详情查看已记录的原因，搜索范围为已加载记录。

![ACP 诊断的操作记录与详情](assets/readme/acp-diagnostics.zh-CN.png)

## <img src="assets/readme/icon-setup.svg" width="24" height="24" alt="" /> 前置：安装受支持的 DSH

版本与运行要求以 [package.json](package.json) 的 `version`、`engines` 为准。以下从 npm `alpha` 包读取兼容的 DSH 版本：

```bash
DSH_VERSION="$(npm view @zaimokuza/dsh-acp-adapter@alpha engines.dsh)"
npx "@deepseek-ai/dsh@$DSH_VERSION" web
```

插件开发直接安装锁定的 npm 依赖：

```bash
pnpm install --frozen-lockfile
```

`pnpm typecheck` 同时检查源码、测试和开发脚本。复杂脚本及测试使用 TypeScript；少量启动脚本和加载器夹具保留 JavaScript，`lib/` 中的 JavaScript 是构建产物。

常规开发无需上游源码；浏览器回归的准备步骤见 [E2E 指南](test/e2e/README.md)。

## <img src="assets/readme/icon-start.svg" width="24" height="24" alt="" /> 三步接入

**1. 安装 Agent，并在终端登录。**

Agent 目录来自随插件发布的 [ACP 官方 registry](https://agentclientprotocol.com) 快照，提供安装指引与配置预填。发布时自动尝试更新目录；同步或校验失败则沿用仓库中已验证的快照，不阻塞发布，详情记录在发布工作流摘要和 issue 中。运行时不联网刷新目录。列入目录不代表已经逐个验证。菜单区分「已验证适配」和「目录收录 · 未验证」；验证范围不覆盖每个目录版本或平台。常用四家：

| Agent | ACP 命令 | 终端登录 |
| --- | --- | --- |
| Claude | `claude-agent-acp` | `claude` |
| Codex | `codex-acp` | `codex login`¹ |
| Devin | `devin acp` | `devin auth login` |
| Kimi | `kimi acp` | `kimi login` |

¹ 使用 ChatGPT 登录需另装 Codex CLI。

在设置面板「添加 agent」中选择条目后可查看安装指引。npm/Python 条目预填已安装程序的命令、参数和环境变量；其他二进制条目需要按 Agent 所在主机的平台安装并填写命令路径，通用参数和环境变量仍会预填。插件不会自动下载或安装 Agent。

**2. 安装插件。** 以下命令安装 npm 已发布的 `alpha` 版本。

```bash
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web add @zaimokuza/dsh-acp-adapter@alpha
```

**3. 打开「设置 → ACP adapter」**，从目录添加 Agent，核对或补全连接设置，检查连接，再在新会话中选择 Agent 模型。

可执行文件路径可以包含空格，例如 `C:\Program Files\Agent Tools\agent.exe`。直接填写路径，不加外层引号；启动参数单独填写在「参数」中。

Devin 连接 DSH 工具时，会通过原生 `devin mcp add` 自动注册或刷新同一个名为 `dsh` 的用户级 MCP 入口，确保启动命令和 `ELECTRON_RUN_AS_NODE=1` 配置正确。多个会话共用这一条配置，各自通过进程环境连接自己的工具桥，不会把会话地址写入配置，也不再需要软链接或硬链接。独立启动 Devin 时，该入口不提供工具；已运行的 Devin 需要重新启动才能发现首次注册的入口。如果已有其他同名 MCP，适配器会报错，不会覆盖它。

需要 API key 时，在 Agent 编辑页的 **高级选项 → 环境变量** 中显式配置；不会自动继承父进程的密钥。高级选项默认收起，已配置项会显示数量。目录预填只影响新增配置，更新插件不会覆盖已有配置。登录指引自动展示，无需填写，也不会执行登录命令或更改 Agent 认证配置；已有自定义指引仍会保留。

目录版本仅用于参考，不同只表示与快照不一致，不代表过旧，也不阻断会话。目录配置保留独立的 `catalogId`，自定义配置 ID 后仍可关联版本与安装提示。升级后，旧绑定中已退役的版本参考字段不参与启动配置比较；命令、参数、环境、状态目录和工具配置的变化仍会触发恢复检查。

## <img src="assets/readme/icon-connect.svg" width="24" height="24" alt="" /> 如何配合

![DSH 管理会话与界面；适配器传递上下文、归一化活动；Agent 负责模型、工具和权限。外部子代理投影只读，后台任务不跨 DSH 重启恢复。](assets/readme/acp-overview.zh-CN.svg)

**实验性 Agent Teams：** 跟随 DSH 的 Teams profile 启用，复用原生团队面板；成员从创建时的主会话继承 Agent、模型与推理配置。主会话切换模型后，新成员使用新模型，已有成员保持原模型；团队内使用同一 ACP Agent。仅支持新建上下文，共享任务使用原生任务板；主会话可直接处理成员审批，当前普通审批支持全部允许／拒绝，允许仅限本次。主会话右上角可查看成员状态与模型，单独或按 ACP 类型批量调整成员的 Agent 模式；休眠成员的设置在下次运行前应用。团队协调免额外审批，普通操作的审批保持原样；成员消息在 DSH 步骤边界送达。

成员管理中点击成员名可在原生侧栏查看会话；运行中仍可查看设置，禁用原因显示在菜单中。批量调整后可展开各成员的结果。恢复状态读取失败时，输入栏提供重试入口。

**DSH 插件工具自动接入：** 当前会话可见的原生工具会自动通过 MCP 提供给 Agent，无需手填工具名，也不需要开启 Teams。例如，宿主提供 `present` 时可直接使用原生文件交付与预览。调用经过原生工具执行链，保留 Agent 审批和工具自身规则。旧 `hostTools` 配置不再生效，编辑保存后移除。工具桥的能力边界见 [原生复用说明](docs/native-reuse.md)。

运行中按 Enter 会排队；使用队列的插话操作可发送到当前执行。插件优先使用 Agent 声明的安全原生注入能力，否则取消当前执行，等其收尾后在同一 Agent 会话续发。Kimi 无需新增 SDK。取消超时不会盲目重发，权限与上下文仍由 Agent 管理。详见[插话能力与限制](docs/agent-input-capabilities.md)。

## <img src="assets/readme/icon-update.svg" width="24" height="24" alt="" /> 更新与卸载

沿用启动 DSH 时的 `DSH_HOME` 和 profile。`npx` 可替换为 `pnpm dlx`，宿主版本保持固定。

```bash
# 更新
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web update @zaimokuza/dsh-acp-adapter
# 卸载
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

**升级时保留本地数据。** 主会话迁移由 DSH 负责；可验证的 V3 子代理投影通过宿主迁移器恢复；不支持的格式和缺失的数据不会补造。当前轮次结束后重启 DSH、刷新页面，从设置标题旁确认加载版本。

不再使用适配器后，可执行 `devin mcp remove --scope user dsh` 移除其入口。

## <img src="assets/readme/icon-help.svg" width="24" height="24" alt="" /> 遇到问题

| 现象 | 先检查 |
| --- | --- |
| 命令无法启动 | 核对可执行文件路径，尝试填写绝对路径。 |
| 登录或认证失败 | 在 Agent CLI 登录，检查已配置的环境变量。 |
| 升级后旧子代理无法打开 | 遵循 DSH 的历史格式支持范围；不额外迁移旧投影，原文件与 ACP 记录保留。 |
| 会话需要恢复 | 按输入栏提示与 **ACP 诊断** 处理，不要清空本地数据。 |

仍有问题时，在 [Issue](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues) 附上错误编号、插件/DSH 版本和相关宿主日志片段；分享前移除密钥。

ACP 诊断的“操作记录”包含工具桥的自动审批判断及转交原因。选中记录后可复制脱敏记录与插件版本，用于远程排障；不会导出桥接凭证。普通审批卡的标题和按钮跟随页面语言，操作名称与参数保持 Agent 原文；通用问题卡和缺失命令提示使用宿主设置中的显式语言。
