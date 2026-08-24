# @zaimokuza/dsh-acp-adapter

将外部 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) Agent 接入
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的插件。DSH
继续负责会话、工作区、审批和宿主审计；ACP Agent 负责自己的推理、工具和运行时状态。

当前包为发布候选版本，已针对 DSH `0.1.1-rc.2` 在 macOS 上验证。Windows、远程 ACP
transport、同一会话跨 backend 迁移和 DSH tools/skills/MCP 注入不在已验证范围内。

## 安装

先安装并启动 DSH `0.1.1-rc.2`，然后在目标 profile 中安装插件：

```bash
dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
dsh web
```

本地 tarball 验证时，从本仓库执行 `pnpm pack`，再把生成的 `.tgz` 的绝对路径传给
`dsh plugin --profile web add`。发布前请用干净 profile 验证安装和卸载；不要把本机
认证文件复制到插件目录或日志中。

最低宿主版本是 `0.1.1-rc.2`。peer 依赖接受该版本及更高版本，但结构兼容门和本项目
实际验收仍以 rc.2 为准；不支持 rc.8。Node.js 支持范围与 DSH `0.1.1-rc.2` 一致：
`^22.19.0 || >=24.0.0`；本仓库门禁使用 Node 24.19.0 与 pnpm 11.7.0。

## 第一步

1. 按 [入门指南](docs/getting-started.md) 检查 DSH 与插件状态。
2. 先在 Agent 自己的 CLI 中完成登录和健康检查，再在 DSH ACP 设置中选择内置模板。
3. 创建一个 ACP 会话，确认 health 状态为 `ready` 后再发送 prompt。
4. 在 [Agent 指南索引](docs/agents/README.md) 中查阅命令、模型/mode 和数据目录说明。

登录始终由 Agent 自己管理。插件只使用命令、环境变量名和 opaque 路径引用，不读取、
复制或记录 token、cookie、配置中的 secret value。

## 能力与安全边界

- DSH 会话的 execution backend 在创建后不变；跨 native/ACP 必须新建会话。
- ACP 模型、mode 和思考强度只在 Agent 真实暴露相应 config option 时显示。
- `allowed-once` 审批保持一次性语义，绝不会映射为 `allow_always`。
- 会话恢复先做 staging reconciliation；无法证明连续性就 fail closed，不静默新建
  ACP 会话接续旧 DSH 历史。
- sidecar 保存 ACP binding、恢复和审批审计；DSH session log 仍是用户可见历史真源。
- 外部 Agent 的 tools、skills、MCP、system prompt、原生 token 统计和重试策略不会
  自动变成 DSH 原生能力。

详细边界见 [架构说明](docs/architecture.md)、[兼容性](docs/compatibility.md) 和
[安全说明](SECURITY.md)。

## 文档

- [入门与安装](docs/getting-started.md)
- [Agent 指南索引](docs/agents/README.md)：[Devin](docs/agents/devin.md) · [Codex](docs/agents/codex.md) · [Kimi](docs/agents/kimi.md) · [Claude](docs/agents/claude.md)
- [操作与验收](docs/operations.md)
- [架构与生命周期](docs/architecture.md)
- [兼容性与已知限制](docs/compatibility.md)
- [故障排查](docs/troubleshooting.md)
- [安全报告](SECURITY.md) · [变更记录](CHANGELOG.md)

## 本地开发

合同测试需要 DSH `0.1.1-rc.2` 的只读源码基线；该目录已被 Git 忽略：

```bash
git clone --depth 1 --branch dsh-v0.1.1-rc.2 \
  https://github.com/deepseek-ai/deepseek-harness.git reference/deepseek-harness
export DSH_UPSTREAM_CHECKOUT="$PWD/reference/deepseek-harness"
```

然后串行运行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

测试和构建必须串行执行，因为它们共享 `lib/` 与 `.typert/`。发布前还应运行
`pnpm check:stale-build`、`pnpm check:picker-diff` 和不带真实凭证的 install gate。

## 许可证

MIT，见 [LICENSE](LICENSE)。
