# 0.1.3-alpha.1 重构验收

验收日期：2026-09-05。宿主为 `dsh-v0.1.3-alpha.1`（`d347e70390`），上游跟踪文件未修改。此次完成源码适配；插件尚未发布新的 npm 兼容版本。

## 实现范围

- 外部子代理投影采用 SessionHandle，持有写句柄完成追加、flush 和关闭；重复投影、部分写入恢复及旧 sidecar 恢复均有验证。新记录用上游 AssistantStreamAccumulator 生成 v2 stream，删除旧 readRaw 可见性补丁。
- 当前 DSH 步骤中已落盘的插件消息、动态上下文和用户输入均传入 ACP，支持插件驱动的后续步骤；旧用户输入不会重发。宿主 system prompt 每次完整传递为标注清楚的当前指令。
- 会话流、输入栏、审批、模型选择及子代理只读详情继续使用原生组件；外部工具活动归一化为原生 Terminal、Read、Diff 展示，不制造 DSH 工具执行。
- 认证错误同时提示检查 Agent 登录和 ACP 连接设置，避免把仅依赖父进程令牌的认证失败误导为必须重新登录。

## 最终验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test --no-file-parallelism` | 55 个文件、579 项通过 |
| `pnpm build` | 通过；132 个打包文件、49 个运行时 JS 文件依赖闭包通过 |
| 完整浏览器回归 | 2 个文件、44 项通过，109.38 秒 |
| 本地 tarball 离线安装、真实 Web 启动和卸载 | 通过；原生组件装配、HTTP 200、客户端启动及卸载清理通过 |
| `git diff --check` | 通过 |

44 项浏览器测试包括四种协议夹具的 40 项产品行为回归和四种真实 Agent 的 4 项冒烟。固定夹具覆盖文件、消息、恢复、宿主上下文扩展、图片、Read/Diff、崩溃恢复、审批允许/拒绝、停止后继续、模型切换、子代理及原生 provider 工具扩展。真实冒烟只验证实际模型收到宿主指令、返回标记、原生 stream 落盘及浏览器刷新恢复；不把夹具中的全部工具与审批场景宣称为真实模型已验收。

| 真实 Agent | 实际选择 | 结果 |
| --- | --- | --- |
| Claude Agent | `haiku`，本机现有配置映射为 DeepSeek V4 Flash | 通过 |
| Codex | `gpt-5.4-mini` | 通过 |
| Devin | `gpt-5-4-mini-low` | 通过 |
| Kimi | `kimi-code/kimi-for-coding`（目录显示 K2.7 Coding） | 通过 |

本机类型检查、常规测试和构建使用 Node 24.19.0；实际 DSH Web、浏览器测试及安装启动使用 Node 22.19.0 和已安装的 Chrome。该 macOS 环境中的 fs-ext 原生构建使用 Node 22 ABI。CI 配置固定源码标签，在三平台验证源码；浏览器固定夹具在 Linux 运行。此处没有把 CI 配置等同于已经执行的跨平台验证。

## Claude 调查结果

最初目录查询成功，但生成返回 `ACP_AUTH_REQUIRED`。仅检查配置字段的存在性后确认：`ANTHROPIC_AUTH_TOKEN` 存在于父进程环境，Claude 用户设置没有配置对应凭据。DSH subprocess 按已有规则过滤父进程的密钥变量，因此模型别名与端点设置可见，认证令牌没有进入 ACP 子进程。

经用户授权，将同一现有令牌显式放入临时测试 profile 后，同一 `haiku` 模型通过验证；无需修改持久化、流协议或用户的正式 Agent 配置。测试使用 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`，只保存变量名和脱敏结果，临时 profile 在测试结束后清理。生产使用仍需显式配置该 Agent 的连接凭据。

## 接口与发布边界

ACP v1 没有 system 消息角色，因此宿主指令作为请求上下文传递，不能保证其拥有外部 Agent system prompt 的优先级。外部 Agent 的工具、技能加载和 MCP 执行仍由该 Agent 管理；ACP 没有通用宿主工具执行回调，工具通知不能当作 DSH 执行请求。原生 provider 的工具执行及其插件 hooks 已通过真实 ToolRuntime 对照验证。

当日再次查询 npm registry，`@deepseek-ai/dsh@0.1.3-alpha.1` 仍返回 404。安装回归使用已构建的准确标签源码和本地插件 tarball，不能替代尚不可执行的正式 npm 安装验收。开发锁文件保留工具引导依赖，运行时必须链接目标源码；发布检查会阻止以旧依赖元数据发布本次适配。

运行方式与测试边界见 [README](README.md)。实际模型目录与结果保存在 gitignored `.local/e2e-live/`；旧调试失败截图可能仍在 `.local/e2e-failures/`，不代表本次最终验证失败。
