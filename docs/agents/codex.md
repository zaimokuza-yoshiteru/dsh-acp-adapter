# Codex

## CLI 检查

插件使用 `codex-acp`：

```bash
codex-acp --version
codex login
```

登录和认证状态由 Codex 自己管理。插件只使用 `CODEX_HOME` 的 opaque 路径引用，绝不
读取或输出 auth 文件内容。若本机 CLI 不接受上述命令，请以当前 `codex-acp --help`
为准，并在 DSH 配置中填写实际可执行文件。

## 审批与子任务

Codex 可能通过 ACP 请求一次性权限；在 DSH 中选择 `allowed-once` 时，回传 option
必须仍是 `allow_once`。Codex collaboration/subagent 事件只作有界的工具过程和终态
摘要展示，不等价于 DSH 原生 child session。
