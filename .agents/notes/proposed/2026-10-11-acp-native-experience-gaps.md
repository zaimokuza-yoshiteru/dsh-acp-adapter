# ACP 原生体验待处理事项

状态：待处理。范围：适配器 `0.2.1-alpha` 与精确 DSH `0.2.1-rc.2`（上游 `687f282e8625c6b8d11ff58211a90524be2e4317`），核对日期 2026-10-17。下列结论用于后续设计复核，不是当前版本的测试通过记录。升级 DSH 或修改相关入口后，须重新核对源码与实际交互。

长期职责边界见 [原生复用说明](../../../docs/native-reuse.md)。完整迁移库存与历史 CI 留在对应 Git/PR 记录；这里仅保留尚未解决、不能从功能清单看出的用户成本。

1. **恢复动作的可用性。** `AcpRecoveryDock` 对不同恢复原因仍呈现固定的重连、空白重绑定、新建会话选项；Host 的 `retryOriginal` 在当前目录或启动指纹不匹配时会拒绝。应由 Host 在操作前返回可用动作、前置条件和推荐顺序，条件变化后可重新评估。远端结果未知时不得自动重发，也不能以空白会话掩盖上下文丢失。
2. **原生权限 preset 与 Auto Review。** ACP 权限投影可与官方 Auto 的 `danger-full-access` + `ask` 组合匹配，原生选择器因而仍可能提供 Auto；其他 preset 又可能在下一次 ACP 准入后回到 Custom。Auto Review 的 reviewer 使用普通 LLM 辅助调用，缺少 ACP 会话准入身份；它不是适配器已有的 DSH 工具 Auto approval。需有按 Session 判断 preset 适用性及 reviewer 路由的官方入口，或另行审查明确的产品处理方式；不能修改全局 catalog、伪造调用身份或默认增加模型凭据。
3. **Teams 写入反馈的归属。** 批量中断、模式变更结果仍由管理弹层承载，成员模型控件卸载后还会忽略迟到结果。关闭弹层后，操作成功或失败可能不可见。可由长期存在的原生 Toast 承载最终结果，查询失败、重试和逐成员明细仍留在面板；需要检查关闭面板和切换会话后的迟到结果。
4. **原生 `/compact` 辅助调用。** 命令可在 ACP 会话中出现；没有可压缩区间时可能成功但不执行压缩，有区间时则通过当前 ACP 模型路由发起辅助调用，而适配器只接受正常交互请求，因此会拒绝。自动标题有相同的默认路由边界。应与按 Session 的命令可用性和独立辅助路由一起评估；另配模型只压缩 DSH 表面历史，不能当作 ACP 私有上下文压缩，也不应成为默认新增配置步骤。
5. **正常配置与工具变更说明。** 预填 Agent 模板可能仍要求展开 ID、命令、参数；登录指导位于高级项。工具目录或作用域变化会撤销旧 MCP lease，并可能使不支持 resume/load 的 Agent 进入恢复。应由实际状态所有者说明安装、认证或工具变化的原因和可执行下一步，不能靠试错、隐式空白重绑定或取消恢复门禁减少表面点击。

核对入口：`src/client/ui/AcpRecoveryDock.ts`、`src/host/composition/profile-adapter.ts`、`src/host/composition/native-agent-access.ts`、`src/client/ui/AcpTeamManagement.ts`、`src/client/ui/TeamMemberModelControl.ts`、`src/client/ui/AcpSection.ts` 与 `src/host/teams/bridge.ts`。这些路径帮助定位当前所有者；修复时仍要沿实际调用链重新验证。

固定上游复核入口（源码依据，不代表运行验收）：

- 可选加载：[profile 组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts)、[Loader](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/loader/src/config/entry.ts)。安装、导入与服务激活不能混作一项能力。
- 辅助模型与权限：[Auto Review](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review/src/index.ts)、[preset catalog](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/permission-presets/src/index.ts)、[自动标题](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-title-llm/src/index.ts)、[`/compact`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/command-compact/src/index.ts)、[summarizer 默认路由](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction-basic/src/summarizer.ts)。
- 数据写入：[Session plugin record 限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/README.zh.md)；它不提供 ACP Sidecar 所需的公开写入与事务边界。
