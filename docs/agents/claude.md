# Claude

[中文](claude.md) | [English](../en/agents/claude.md)

## CLI 检查

插件使用 `claude-agent-acp`。请先按 Claude CLI 的官方流程完成登录，并在不暴露账户
详情的前提下确认可执行：

```bash
claude-agent-acp --version
claude-agent-acp --help
```

Claude 的认证由下游 CLI 管理；插件不读取认证目录，也不替用户 login/logout。若使用
自定义可执行文件，可在 DSH profile 中指定 `CLAUDE_CODE_EXECUTABLE`。

## 模型与配置

Claude session 返回的 model/config options 才是可选目录。切换通过 DSH 的模型事务和
Agent 的 config option 写入口完成；CAS 冲突不会覆盖并发用户选择。重启恢复时，插件
先恢复 binding 和已提交选择，再允许 prompt。
