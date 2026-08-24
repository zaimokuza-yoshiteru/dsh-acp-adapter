# Devin

## CLI 检查

插件使用 `devin acp`。先在 Devin 自己的终端完成登录，再检查 CLI：

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

`devin auth status` 的账户详情不要复制到日志或 issue。插件只保留认证路径的 opaque
引用，不打开 credentials 文件。

## DSH 配置

选择 Devin 内置模板，确认 workspace 权限与 Agent mode。Devin 的 ACP 会话状态可能
需要宿主临时目录；workspace-write 会话会经过状态目录和恢复对账门。审批被拒后，
恢复无法证明连续性时会进入 `reconciliation-required`，请回滚或新建会话，不要强行
继续旧历史。

Devin 不保证每个 `request_permission` 都带工具名称；审批面板会显示脱敏的 fallback
和有界目标信息，不会伪造工具名。
