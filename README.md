# ACP adapter

[English](README.en.md)

在 DSH 会话页面使用 **Claude · Codex · Devin · Kimi**。

## <img src="assets/readme/icon-preview.svg" width="24" height="24" alt="" /> 功能预览

以下截图在干净 DSH 实例中，通过 **Devin · SWE-1.7 Medium** 实际操作生成。

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

常规开发无需上游源码；浏览器回归的准备步骤见 [E2E 指南](test/e2e/README.md)。

## <img src="assets/readme/icon-start.svg" width="24" height="24" alt="" /> 三步接入

**1. 安装 Agent，并在终端登录。**

agent 目录来自 [ACP 官方 registry](https://agentclientprotocol.com)（CI 每日同步进插件，当前 41 个，均开箱即用）。常用四家：

| Agent | ACP 命令 | 终端登录 |
| --- | --- | --- |
| Claude | `claude-agent-acp` | `claude` |
| Codex | `codex-acp` | `codex login`¹ |
| Devin | `devin acp` | `devin auth login` |
| Kimi | `kimi acp` | `kimi login` |

¹ 使用 ChatGPT 登录需另装 Codex CLI。

其余 agent 的安装命令见设置面板「添加 agent」菜单（每条自带安装指引与 command/args 预填）。

**2. 安装插件。** 以下命令安装 npm 已发布的 `alpha` 版本。

```bash
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web add @zaimokuza/dsh-acp-adapter@alpha
```

**3. 打开「设置 → ACP adapter」**，从目录添加 agent（命令与参数已预填，可改），检查连接，再在新会话中选择 Agent 模型。

需要 API key 时，在 **连接设置 → 环境变量** 中显式配置；不会自动继承父进程的密钥。

## <img src="assets/readme/icon-connect.svg" width="24" height="24" alt="" /> 如何配合

![DSH 管理会话与界面；适配器传递上下文、归一化活动；Agent 负责模型、工具和权限。外部子代理投影只读，后台任务不跨 DSH 重启恢复。](assets/readme/acp-overview.zh-CN.svg)

**实验性 Agent Teams：** 跟随 DSH 的 Teams profile 启用，复用原生团队面板；成员从创建时的主会话继承 Agent、模型与推理配置。主会话切换模型后，新成员使用新模型，已有成员保持原模型；团队内使用同一 ACP Agent。仅支持新建上下文，共享任务使用原生任务板；主会话可直接处理成员审批，当前普通审批支持全部允许／拒绝，允许仅限本次。主会话右上角可查看成员状态与模型，单独或按 ACP 类型批量调整成员的 Agent 模式；休眠成员的设置在下次运行前应用。团队协调免额外审批，普通操作的审批保持原样；成员消息在 DSH 步骤边界送达。

**可选 DSH 插件工具：** 在 Agent 连接设置的「DSH 插件工具」中每行填入一个已安装的工具名，或配置 `hostTools: ["工具名"]`。仅选中的工具会通过 MCP 提供给 Agent，并经过 DSH 原生工具执行链；默认不增加工具。普通工具保留 Agent 审批，DSH 工具自身的执行规则仍生效。避免选入与 Agent 自带能力重复的工具；名单改变后请新建会话。工具桥不等于完整接管 Agent loop，具体边界见 [原生复用说明](docs/native-reuse.md)。

运行中按 Enter 会排队；使用队列的插话操作可发送到当前执行。插件优先使用 Agent 声明的安全原生注入能力，否则取消当前执行，等其收尾后在同一 Agent 会话续发。Kimi 无需新增 SDK。取消超时不会盲目重发，权限与上下文仍由 Agent 管理。详见[插话能力与限制](docs/agent-input-capabilities.md)。

## <img src="assets/readme/icon-update.svg" width="24" height="24" alt="" /> 更新与卸载

沿用启动 DSH 时的 `DSH_HOME` 和 profile。`npx` 可替换为 `pnpm dlx`，宿主版本保持固定。

```bash
# 更新
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web update @zaimokuza/dsh-acp-adapter
# 卸载
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

**升级时保留本地数据。** 主会话迁移由 DSH 负责；宿主不支持的旧子代理投影不额外迁移。当前轮次结束后重启 DSH、刷新页面，从设置标题旁确认加载版本。

## <img src="assets/readme/icon-help.svg" width="24" height="24" alt="" /> 遇到问题

| 现象 | 先检查 |
| --- | --- |
| 命令无法启动 | 核对可执行文件路径，尝试填写绝对路径。 |
| 登录或认证失败 | 在 Agent CLI 登录，检查已配置的环境变量。 |
| 升级后旧子代理无法打开 | 遵循 DSH 的历史格式支持范围；不额外迁移旧投影，原文件与 ACP 记录保留。 |
| 会话需要恢复 | 按输入栏提示与 **ACP 诊断** 处理，不要清空本地数据。 |

仍有问题时，在 [Issue](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues) 附上错误编号、插件/DSH 版本和相关宿主日志片段；分享前移除密钥。
