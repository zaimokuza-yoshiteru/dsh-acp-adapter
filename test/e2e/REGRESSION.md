# 历史回归记录

当前版本的测试入口见 [E2E 指南](README.md)。过往结果对应当时的宿主、Agent 和模型，可在发行标签中查阅。

- [RC.3.1 及更早的验收原文](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/v0.2.2-rc.3.1/test/e2e/REGRESSION.md)涵盖各平台、Agent 与已知失败，包括当时对旧版 Devin 和已退役 Kimi 的检查。本地可用 `git show v0.2.2-rc.3.1:test/e2e/REGRESSION.md` 查阅。
- [旧版真实 Agent 专项记录](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/v0.2.2-rc.3.1/test/e2e/README.md#真实-agent-冒烟)保留 Devin CI 运行、CodeBuddy 长任务、Antigravity 与 Qwen 的实测配置和覆盖限制。

## 2026-11-18 — Devin Teams on DSH RC.4

在 macOS ARM64 的隔离浏览器和 Host 中，用生产代码 `4c21d61`、Devin CLI `3000.14.30821`（构建 `a09cd7f323ee`）运行三项真实验收。当前账户目录将 `swe-2-high` 标为 Free，Lead 与成员均使用此模型。会话通过 MCP 发现 DSH 工具，测试没有向提示注入工具 schema。

- 首张 `write` 审批卡完整展示了七个原选项。身份来自工具标题，未提供结构化身份。点击子会话 Stop 后，ACP 请求取消，没有选择任何选项，没有派发或写文件。
- 成员读取并完成计算任务，发送结果给 Lead。Lead 收到后领取并完成依赖它的复核任务，在原生页面回复本轮标识和数值 2。12 次一次性允许对应 12 次成功工具派发。双方的公开活动各记录一次目录发现；五次只读操作无法从公开活动逐项关联到特定目录条目。
- 同一子会话的三次独立写入请求中，允许一次精确写入一次，拒绝和 Stop 均没有派发或文件副作用。取消后的回复沿用同一 ACP session，刷新页面后仍可见。本项覆盖等待审批时取消。

运行入口见[真实 Agent 冒烟](README.md#真实-agent-冒烟)。本机原始选项、任务、决策与截图分别归档在 `.local/rc4-modern-teams/{inspect,shared,permissions}/`。
