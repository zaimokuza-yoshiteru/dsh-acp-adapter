# 故障排查

[中文](troubleshooting.md) | [English](en/troubleshooting.md)

## health 不是 ready

确认 CLI 可执行、外部登录已完成、workspace 权限允许 Agent data home，并重新运行 Agent
自己的 doctor/help。插件不读取凭证；若认证失效，回到 Agent CLI 修复后重新检查。

## 审批没有通过

检查请求的 tool name/reason 是否为有界脱敏文本，并确认 UI 选择的是 `allowed-once`。
仅提供 `allow_always` 的 Agent 选项会被拒绝，插件不会把它降级成一次性允许。

## 会话变成 reconciliation-required

这是 fail-closed 保护：DSH 历史和 Agent 回放无法证明一致。不要删除或手改 sidecar。
按 UI 选择回滚、rebind blank 或新建 ACP 会话；需要报告时只提供 session id、状态和脱敏
错误类别。

## 模型切换失败

并发写入会显示 conflict，插件不会覆盖后来选择。补偿失败会同时说明新会话是否创建、
默认模型是否恢复；按提示人工检查 DSH 设置，再重试单次切换。
