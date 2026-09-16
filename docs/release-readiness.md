# 0.1.6-alpha.1.4 部署准备

候选包适配 DSH `0.1.6-alpha.1`，发布通道为 `alpha`。本页记录发布前验证与操作流程。本地 tarball 已完成验证；正式发布由版本标签触发 GitHub Actions，实际状态以发布工作流和 npm 注册表为准。桌面内置清单在 npm 版本可用后更新。

## 交付内容

- 插话复用原生 inbox、pre-step、请求配置与消息持久化。安全能力协商成功时使用 Agent 原生注入；其他连接打断、等待收尾、在同一 Agent 会话续发。Kimi 不引入 SDK。
- 正常交接保留旧回复尾部，图片块保持完整，新旧工具分别保留正确的消息归属；原回复的错误或长度上限不会被续发成功掩盖。
- 完整 Diff 与计划使用归一化展示数据和原生 DiffBlock／TodoDock；未完成计划不因 prompt 结束而变成完成。
- 可选 `hostTools` 复用原有 MCP 桥和 DSH `tools.execute`，默认不暴露普通工具。Agent 的权限、模型循环与上下文管理保持独立。
- 合并 Host／Client 的 Diff 识别与工具名称校验；复用官方 todo 类型；删除没有调用者的测试故障分支。保留动态入口、旧数据兼容和有实际覆盖价值的夹具。
- 中英文 README、连接设置、展示提示和能力说明同步；详细代价见 [原生复用边界](native-reuse.md) 与 [插话说明](agent-input-capabilities.md)。

## 候选产物

产物目录为仓库内 gitignored `.local/release-0.1.6-alpha.1.4/`。

| 项目 | 值 |
| --- | --- |
| tarball | `zaimokuza-dsh-acp-adapter-0.1.6-alpha.1.4.tgz` |
| 大小 | 1,702,116 bytes |
| SHA-256 | `ca57d8d4665092660b2f312775b2a54ab29a3d9ebfafcc749d7609d840475fb6` |
| 完整校验值 | `checksums.json` |
| 桌面内置版本补丁 | `desktop-pin.patch`，已通过 `git apply --check` |

该 tarball 已通过干净安装、增量插件装配、HTTP 200、客户端 bootstrap 和移除验证。安装门禁的成功临时目录会自动清理，持久证据是 `install-final.log`，不是日志中已删除的临时路径。

## 验证范围

类型检查、构建、严格公共类型消费、运行时依赖闭包和 188 个打包文件检查通过；76 个常规测试文件、749 项通过。最终完整 Chrome 回归 14 个文件、134 项通过，默认跳过 4 项需要真实登录的测试，运行 557 秒。逐项范围见 [回归记录](../test/e2e/REGRESSION.md)。

真实 macOS arm64 Electron `0.1.6-alpha.1.2` 在全新隔离配置中加载最终候选，22 项产品回归通过；使用四种可控 Agent 协议夹具。桌面源码的 41 个测试文件中 232 项通过、1 项平台条件跳过。没有生成或验证包含新内置版本的新版桌面 ZIP，也没有将本机结果扩展为 Windows、Intel Mac 或 SSH 工作区验收。

真实 Codex GPT-5.5、Kimi Coding、Devin Gemini 3.8 Flash Medium 各通过两轮宿主指令、同会话对话与刷新；另各通过开始生成后的插话、两个原生 step 和刷新验证。Claude ACP 经本机 DeepSeek 路由也通过上述两轮与运行中插话验证；`haiku` 别名映射到 `deepseek-v4-flash`。先前的 `ACP_AUTH_REQUIRED` 来自隔离测试遗漏 `ANTHROPIC_AUTH_TOKEN`：DSH 子进程保留地址和模型映射，但过滤了父环境 token，才触发未使用的旧 OAuth。显式传入现有路由环境后，两项分别在 18.30 秒和 20.22 秒内通过；不需要重新登录 Claude。

## 发布顺序

1. 审阅并提交适配器改动，确认提交包含本页记录的代码与双语文档。不要把 `.local/` 的配置、日志或测试会话提交到仓库。
2. 核对各 Agent 的实际服务路由与显式认证配置。Claude 的 DeepSeek 路由已补验通过；下面保留复测命令，不需要切回 OAuth 登录。
3. 推送与 package.json 一致的 `v0.1.6-alpha.1.4` 标签，触发 `publish npm` 工作流。CI 执行测试、`npm pack`、干净安装门禁，并通过 OIDC 发布同一份 CI tarball 到 `alpha`。发布后核对注册表版本、CI 产物与 `dist.integrity`。
4. 若同时发布桌面端，在适配器版本可从 npm 获取后，将 `desktop-pin.patch` 的 integrity 更新为注册表的实际值，再应用补丁，使用桌面项目锁定的工具链重新打包和验收。CI 的 npm 打包与本地 pnpm 打包可能产生不同的 manifest 元数据，不能直接把本地 tarball 的 hash 当成注册表 hash。

```sh
# 在 dsh-acp-adapter 中，使用本机已配置的 DeepSeek 环境；这里只声明变量名，不复制密钥
export DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_MODEL,ANTHROPIC_DEFAULT_HAIKU_MODEL,ANTHROPIC_DEFAULT_SONNET_MODEL,ANTHROPIC_DEFAULT_OPUS_MODEL,CLAUDE_CODE_SUBAGENT_MODEL,CLAUDE_CODE_EFFORT_LEVEL,CLAUDE_CODE_AUTO_COMPACT_WINDOW
DSH_E2E_BROWSER_CHANNEL=chrome DSH_E2E_LIVE=1 DSH_E2E_LIVE_PROFILES=claude pnpm test:e2e test/e2e/live-agents.e2e.mjs
DSH_E2E_BROWSER_CHANNEL=chrome DSH_E2E_LIVE=1 DSH_E2E_LIVE_STEERING=1 DSH_E2E_LIVE_PROFILES=claude pnpm test:e2e test/e2e/live-agents.e2e.mjs

# 提交代码后，通过仓库现有工作流发布
git tag -a v0.1.6-alpha.1.4 -m "Release 0.1.6-alpha.1.4"
git push --atomic origin HEAD:refs/heads/feature/0.1.6.alpha refs/tags/v0.1.6-alpha.1.4
npm view @zaimokuza/dsh-acp-adapter@0.1.6-alpha.1.4 version dist.integrity

# 在 deepseek-harness-desktop 中；先确认 npm 版本可用，并更新补丁的 registry integrity
git apply ../dsh-acp-adapter/.local/release-0.1.6-alpha.1.4/desktop-pin.patch
pnpm package:desktop:mac:arm64
```

Web 安装可使用 DSH 原生插件管理安装精确版本 `@zaimokuza/dsh-acp-adapter@0.1.6-alpha.1.4`。需要回退时，通过同一管理入口安装此前的 `0.1.6-alpha.1.3`，保留本地会话数据；新增展示字段为可空列，不需要删除数据库。桌面则回退版本／integrity 清单并重新生成安装产物，不能只给旧 ZIP 改名。

## English summary

This document records the tested local candidate and the tag-driven release procedure; GitHub Actions and the npm registry determine the actual publication status. It preserves native DSH admission and rendering, uses negotiated atomic steering or cancellation followed by continuation in the same Agent session, and adds no Kimi SDK. Standard tests, real Electron fixture regression, clean installation, and real Codex/Kimi/Devin conversation and steering checks passed. Claude ACP also passed conversation and live steering through the existing DeepSeek route. The earlier OAuth error was caused by a missing explicit authentication environment variable in the isolated test, not by an invalid DeepSeek configuration; no Claude login is required for this route. The CI npm tarball may differ from the local pnpm tarball in manifest metadata. Update the desktop pin patch to the published registry integrity and apply it only after the npm version is available; a newly bundled desktop installer still needs packaging and artifact acceptance. Full diffs increase storage and transfer cost, selected host tools add MCP overhead, and external Agents continue to own permissions and their internal loops.
