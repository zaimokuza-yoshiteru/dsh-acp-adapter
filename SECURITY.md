# 安全策略

[中文](SECURITY.md) | [English](SECURITY.en.md)

本插件采用 external-login-only：认证由 Devin、Codex、Kimi 或 Claude 自己的 CLI 管理。
插件不会读取、复制、解析或回传 token、cookie、私钥、credential 文件内容；日志和
sidecar 只保存 opaque 路径引用、键名、哈希或脱敏摘要。

请不要在 issue、日志或测试夹具中提交凭证、完整环境变量、私有工作区内容或未脱敏的
ACP payload。若发现疑似泄漏，请不要公开创建 issue，发送最小化复现、受影响版本和
文件路径到仓库维护者，并在可能时先撤销/轮换凭证。报告中只保留类别和脱敏片段。

安全边界包括 host structure gate、进程终止梯子、审批语义保持、staging reconciliation
和模型切换 CAS；外部 Agent 自身的工具策略不等于 DSH sandbox 保证。
