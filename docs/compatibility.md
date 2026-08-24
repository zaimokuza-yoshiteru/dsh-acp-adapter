# 兼容性

[中文](compatibility.md) | [English](en/compatibility.md)

| 项目 | 接受范围 | 已验证 |
| --- | --- | --- |
| DSH | `>=0.1.1-rc.2` | `0.1.1-rc.2` |
| Node.js | `^22.19.0 || >=24.0.0` | 24.19.0 |
| 平台 | 以宿主和 Agent CLI 为准 | macOS |
| Agent | Devin / Codex / Kimi / Claude ACP | 各自的当前 descriptor 版本 |

“接受范围”是 package metadata 的版本约束，不等于每个版本或平台都经过真实 E2E。
Windows 尚未验收，不属于当前已验证平台；rc.8 不在兼容范围。远程 ACP transport、
跨 backend history handoff、通用 credential broker 和 DSH tools/skills/MCP 注入也不在
当前产品范围。

已知限制：被拒工具缺失导致的 Devin replay divergence 会被恢复对账拦截（fail closed）；
DSH 会话删除没有 sidecar 删除钩子，插件 retention/compact 只能按自身生命周期清理；
完整 controller 故障注入需要宿主公开 seam，自动化矩阵覆盖了该补偿逻辑，但不冒充真机
DSH rejection 证据。
