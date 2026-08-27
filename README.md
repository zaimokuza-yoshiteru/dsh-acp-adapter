# @zaimokuza/dsh-acp-adapter

[English](README.en.md)

通过 DeepSeek Harness（DSH）会话页面使用智能体，包括 Devin、Codex、Kimi 和 Claude。智能体继续负责自己的模型、工具、skills、登录状态和运行时。

## 前置：安装 DSH

需要 Node.js `^22.19.0 || >=24.0.0` 和 DSH `>=0.1.1-rc.2`：

```bash
npx @deepseek-ai/dsh web
```

## 安装插件

在运行 DSH 的机器上执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
npx @deepseek-ai/dsh web
```

打开 DSH 的 ACP 面板，选择内置 Agent 模板、填写必要的可执行文件配置并运行健康检查。模型选择器显示 ACP 会话实际返回的模型与选项。

## 安装并登录 Agent

先在 Agent 自己的终端安装并登录，再在 ACP 面板执行检查。插件不会要求你把 token、cookie、credential 文件或密码复制到 DSH。

### Devin

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

### Codex

`codex-acp` 是 ACP 可执行文件，并已包含兼容的 Codex 运行时。使用 ChatGPT
账号登录时，需要另行安装 Codex CLI 并执行 `codex login`；也可以在启动 DSH
前通过 `CODEX_API_KEY` 或 `OPENAI_API_KEY` 提供 API key。插件不会代替 Agent
调用 ACP `authenticate`，也不会保存这些凭证。

```bash
codex-acp --version
codex-acp --help
# 仅在使用 ChatGPT 账号登录且已安装 Codex CLI 时：
codex login
```

### Kimi

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

### Claude

```bash
claude --version
claude-agent-acp --version
claude-agent-acp --help
```

未登录时运行 `claude`，按终端提示完成登录；不要在 DSH 中填写 Claude 凭证。

## 原生 Agent 访问与边界

ACP 会话自动使用“原生 Agent 访问”（DSH 权限标识为 `danger-full-access`）。它使 Agent 能使用自己的配置、登录状态、data home、skills 和 MCP 定义。Agent 自己的模式决定其行为；插件只展示 Agent 主动通过 ACP 发出的审批请求，无法限制绕过 ACP 审批的 Agent 工具。请只连接你信任的本地 Agent。

插件不会把 DSH 的 MCP 注入 Agent，也不会读取 DSH 私有配置或要求重复填写 MCP JSON。Agent 已配置的原生 MCP 和 skills 不受影响。切换到另一个 Agent 或原生模型会创建新会话，历史不会隐式迁移。

## 升级与卸载

升级已安装的插件：

```bash
npx @deepseek-ai/dsh plugin --profile web update @zaimokuza/dsh-acp-adapter
```

### 预发布版本的数据兼容

`0.1.0` 正式版之前不保证 ACP sidecar 数据跨版本兼容。如果升级后旧会话提示
“ACP 会话需要恢复”或 `profile-changed`，请先停止 DSH，再备份并重建插件私有数据：

macOS / Linux：

```bash
mv "$HOME/.dsh/dsh-acp" "$HOME/.dsh/dsh-acp.backup"
```

Windows PowerShell：

```powershell
Rename-Item "$env:USERPROFILE\.dsh\dsh-acp" "dsh-acp.backup"
```

重启 DSH 后请创建一个全新的 DSH 会话。该目录只包含插件的 ACP binding、恢复状态、
审计、选项快照和模型切换事务；不会删除 Agent 自己的登录、skills、MCP 或 data home。
旧 ACP 会话的 DSH 页面历史仍可查看，但清理 binding 后不能继续恢复。无需删除整个
`~/.dsh/profiles/web`。

卸载：

```bash
npx @deepseek-ai/dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

## 最短故障排查

在 DSH ACP 面板重新运行健康检查；确认对应 Agent 的 `--version`、`--help` 或健康命令成功，并确认 ACP 可执行文件位于 DSH 进程继承的 `PATH` 中。登录状态改变后先在 Agent CLI 完成登录，再点“重新检查”。
