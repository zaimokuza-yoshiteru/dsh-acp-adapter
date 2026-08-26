# @zaimokuza/dsh-acp-adapter

[English](README.en.md)

通过 DeepSeek Harness（DSH）会话页面使用智能体的插件。目前支持 Devin、Codex、Kimi
和 Claude 的 ACP 连接。智能体继续负责自己的模型、工具、skills、登录状态和运行时；DSH
提供统一的会话页面、进程管理、通知和审计展示。

## 安装 DSH

需要 Node.js `^22.19.0 || >=24.0.0`，以及 DSH `>=0.1.1-rc.2`。最简单的本地启动方式是：

```bash
npx @deepseek-ai/dsh web
```

DSH 默认在 `http://127.0.0.1:3080` 启动 Web 页面。也可以按照
[DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)的说明从源码安装和启动。

## 安装插件

在 DSH 运行的机器上执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
npx @deepseek-ai/dsh web
```

打开 DSH 后进入 ACP 设置。插件只在 ACP 面板管理 Agent 配置；模型选择器会显示 Agent
在 ACP session 中实际返回的模型和配置选项。卸载：

```bash
npx @deepseek-ai/dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

## 配置支持的 Agent

先在 Agent 自己的终端安装并登录，再在 DSH 的 ACP 设置中选择对应的内置模板并执行检查。
插件不会要求你把 token、cookie、credential 文件内容或密码复制到 DSH。

### Devin

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

在 DSH ACP 设置中选择 Devin 模板，确认检查结果为可用后创建会话。

### Codex

`codex-acp` 是 ACP 可执行文件。可直接使用它的 CLI 登录；如果同时安装了
Codex CLI，也可以使用 `codex login`：

```bash
codex-acp --version
codex-acp cli login
codex-acp --help
```

或者：

```bash
codex --version
codex login
```

完成任一登录流程后，在 DSH ACP 设置中选择 Codex 模板。

### Kimi

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

在 DSH ACP 设置中选择 Kimi 模板，等待健康检查完成后创建会话。

### Claude

Claude Code 与 Claude 的 ACP 适配器由下游 CLI 管理。先确保 Claude CLI 已安装并完成
自己的登录流程，再检查 ACP 可执行文件：

```bash
claude --version
claude-agent-acp --version
claude-agent-acp --help
```

如果尚未登录，运行 `claude` 并按其终端提示完成登录；不要在 DSH 中填写 Claude 的
凭证。然后在 DSH ACP 设置中选择 Claude 模板。Claude 使用 DeepSeek 等兼容后端时，
DSH 仍按 ACP Agent 身份展示，不在插件中重新解释下游模型提供方。

## 原生 Agent 访问

ACP 会话默认使用“原生 Agent 访问”（DSH 内部权限标识为 `danger-full-access`），以便
Agent 使用它自己的配置、登录状态、data home、skills 和 MCP 定义。这意味着 Agent 的
文件和命令权限由 Agent 自己的原生模式以及 ACP 审批决定；DSH 的审批交互不是一个能够
限制不合作 Agent 的安全边界。请只对你信任的本地 Agent 使用此模式，并在 Agent 自己的
CLI 中设置合适的权限模式。

DSH 的工作区、会话历史和 Agent 的运行时状态仍是不同的责任边界；切换到另一个 Agent
或原生模型会创建新的会话，不会把历史隐式迁移给另一个执行后端。

## 验证安装

1. 在 DSH ACP 设置中选择 Agent 模板并执行健康检查。
2. 确认状态为可用后创建 ACP 会话。
3. 发送一个不会修改文件的简单问题，确认消息、工具过程和通知能在会话页面显示。
4. 如需更换 Agent，创建新会话；不要把已有会话的执行后端直接当作可迁移上下文。

如果检查失败，先在对应 Agent 的 CLI 中运行其 `--version`、`--help` 或健康检查命令，
确认 ACP 可执行文件在 DSH 进程的 `PATH` 中，再回到 ACP 设置重新检查。

## 许可证

MIT，见 [LICENSE](LICENSE)。
