# DSH RC.4 开放问题评估

2026-11-18 核对 GitHub 后，仍开放的有 #75、#80、#86、#87、#88、#89。#74 和 #78 已随对应宿主的插件发行版解决并关闭。

| Issue                                                                                                    | 优先级与判断                    | 依据与可落地方案                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#87 工具消费排队消息后仍要求结束本轮](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/87) | **已修，待发布**                | 工具消费最后一条排队消息后，桥接层会在本次 ACP 请求内撤回先前的结束提示。队列里还有输入时继续提醒，原生工具明确结束本轮时以它为准。真实 RC.4 AgentLoop 经 HTTP MCP 验证了消息消费路径，测试模型为脚本驱动。[工具桥](../../src/host/tools/bridge.ts) · [集成回归](../../test/unit/runtime/bridge-agent-loop-feedback.spec.ts)                                                                              |
| [#86 二选一审批是否执行外部策略](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/86)       | **已实现，待发布**              | 策略提供方可单独注册二选一审批。未命中时使用原生审批，拒绝保留 Agent 的原始选项 ID。普通问答、合成权限表单和 Devin 专用流程保留各自的入口。[策略契约](../permission-policy.md) · [回归](../../test/unit/host/external-permission-options.spec.ts)                                                                                                                                                         |
| [#89 展示策略决策理由](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/89)                 | **已实现，交付时机受 ACP 限制** | 旧字符串结果继续有效。策略可附理由，人工审批卡显示策略说明。机器拒绝或策略取消后，理由随同一连接、同一执行者下一条已准入的 ACP 请求送出一次。协议内正在运行的 Agent 可能先自行继续推理。停止、断连或更换执行者会丢弃待送理由。[策略结果](../permission-policy.md) · [ACP 子进程回归](../../test/unit/runtime/session-runtime-permission-snapshot.spec.ts)                                                 |
| [#88 已有 ACP 会话原地切模](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/88)            | **未解决，阻塞发布**            | 标准模式在首轮后仍无法保留原会话切换模型。开发版支持在原模式另开空白会话。真实 Agent、宿主压缩与专用预设的对照见[下方实测](#同一-acp-会话切模)。                                                                                                                                                                                                                                                          |
| [#75 OpenCode 可选 Other 多出一页](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/75)     | **已修，待发布**                | 官方 `@opencode/cli` 2.3.2 的 question 工具将候选和自填答案编码为两个字段。验证 Agent 握手、工具调用和完整表单后，在同一页选择、自填或跳过。真实 CLI 接本地脚本模型，在独立 Electron 的 390px 原生卡片上验证了选择、自填、跳过及多选附自填，四轮均按原协议解码。独立字段和授权问题仍使用原有语义。[识别规则](../../src/agents/opencode.ts) · [原生问答回归](../../test/e2e/acp-elicitation-detail.e2e.ts) |
| [#80 CodeBuddy 本地适配反馈](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/80)           | **按子项处理**                  | MCP 批调用已修；CodeBuddy 已按模型探测思考档。切模归 #88；权限模式在空闲时可改，运行时保留锁。父会话代审可由单独策略插件核实当前执行者与父会话关系后接入。评论建议的模型显隐需要通用和第三方模型菜单共同支持视图过滤；从底层目录移除模型会伤及已有路由，建议暂缓。[CodeBuddy 探测回归](../../test/unit/protocol/codebuddy-model-probe.spec.ts) · [策略接入契约](../permission-policy.md)                  |
| [#78 任意工具调用报批执行失败](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/78)         | **已发布并关闭**                | 匹配 RC.1 的插件已改用单元素 `calls` 批次、JSON 参数和唯一匹配的 `callId`，并处理批次反馈及结束本轮信号。RC.4 保留该工具协议。原报告组合使用了针对更旧宿主构建的插件。[当前工具桥](../../src/host/tools/bridge.ts) · [RC.1 插件发行版](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases/tag/v0.2.2-rc.1.2)                                                                                 |
| [#74 支持 DSH RC.1](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/74)                    | **已发布并关闭**                | 标题点名的 DSH `0.2.2-rc.1` 有对应的插件 `0.2.2-rc.1.2`，其 manifest 精确声明该宿主版本。后续宿主版本各自做兼容评估。[已发布 manifest](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/v0.2.2-rc.1.2/package.json#L27)                                                                                                                                                                        |

## 同一 ACP 会话切模

在 macOS 上用独立 RC.4 Host、原生模型选择器和隔离的 Agent 工作目录验证。两轮验证使用新生成的标记，第二条消息仅要求复述，未再次提供标记。以下对照均使用原版 DSH。

| 路径                                              | 结果                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeBuddy 2.161.2，直接走 ACP                     | 同一会话从 `hy4flash-free` 切到 `glm-5.3-flash`，两次配置回执均确认目标模型，两轮正常结束，第二轮准确复述标记。                                                               |
| OpenCode 1.19.4，直接走 ACP                       | 本机 llama.cpp 加载两份经官方摘要校验的 Qwen2.5 权重（0.5B → 1.5B）。第二个模型准确复述首轮标记。OpenCode 的会话数据库和 llama.cpp 的推理记录分别确认两次模型调用。           |
| RC.4 标准模式，CodeBuddy 和 OpenCode              | 两个 Agent 均完成首轮回复。原生菜单改选后弹出另开会话提示，草稿保留。直接通过会话 API 提交改选后的请求，均收到 `ACP_MODEL_SWITCH_UNAVAILABLE`，最后一次已提交请求仍是原模型。 |
| RC.4 标准模式，仅移除隔离插件副本的服务端切模保护 | 两组模型在第二轮均收到宿主原始错误 `MODEL_SWITCH_COMPACTION_FAILED`，请求头保留原模型。                                                                                       |
| RC.4 专用 ACP 预设，同一隔离副本                  | 该预设没有宿主压缩。两个 Agent 的请求头均从 A 改为 B，各自的 ACP session ID 保持一致，B 均准确复述首轮标记。                                                                  |

OpenCode 公共服务在本次测试中拒绝了已列入目录但已退役的 GLM Free，DeepSeek Free 报免费额度已用尽。表中的 OpenCode 双轮验收使用本机模型。

标准模式在写入新请求头前，先按目标模型的容量判断旧历史是否需要压缩。该检查早于历史长度判断，因此一轮短对话也会失败。ACP 的运行时用量描述当前模型，无法回答切换前目标模型的容量。即使容量恰好已知，DSH 能压缩的也只有宿主自己的历史，外部 Agent 持有另一份会话上下文。[RC.4 请求门禁](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.4/packages/compaction/compaction-basic/src/index.ts#L183) · [目标容量检查](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.4/packages/compaction/compaction-basic/src/index.ts#L333)

专用 ACP 预设仍处于隔离验证阶段。切换失败或配置确认前连接中断时，仅放开保护会导致宿主已记录 B，远端可能仍在 A。要开放正式入口，应在提交新请求头前验证目标配置，并覆盖断连后的远端状态核对、取消、重试和原模型恢复。标准及创造模式还需要宿主按会话识别由外部 Agent 管理的上下文。[拒绝、失联与恢复的隔离用例](dsh-0.2.2-rc.3.md#专用-acp-预设能否原地切模)

## PR #79 的贡献与合入情况

NateScarlet 于 11 月 7 日向当时的 `main` 提交了完整的 RC.1 迁移，包含工具批调用、逐步工具准入、PTC 的 `run_code`、投影和成员模型恢复。开发分支在 10 月 29 日已迁入其中多项原生 API，11 月 11 日对齐 RC.1。PR 的五个原始提交均未合入。11 月 11 日，主线针对 #77 采用了 PR 提出的按工具处理变更的思路，在提交中明确注明来源，并将 NateScarlet 列为共同作者。报告者后来确认开发分支已修复断连。[PR #79](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/pull/79) · [早期迁移](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/commit/9a53467) · [共同署名提交](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/commit/76d8fbd1f7d07fee18ac8047fd2d5133d5bbaaa0) · [报告者确认](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues/77#issuecomment-6913245108)

作者于 11 月 16–17 日补上四个提交，并请求复核投影生命周期、分叉保护和工具热重载。11 月 18 日作者自行关闭 PR。公开讨论没有记录维护者对这些修订的最终反馈，也没有逐提交放弃 cherry-pick 的同期说明。#74、#77 和 #78 均早于该 PR。[作者的复核请求](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/pull/79#issuecomment-6937855420)

热重载仍有一处行为差异。PR 允许在原连接上为同名、同 schema 的新注册重新向宿主取得工具集。主线借用 DSH 对当前步骤已经解析的工具集，并记录本连接公布的注册。替换时，在途调用可完成，其他工具可继续使用。新实现要由新连接重新准入。工具被撤销时，会取消该工具的在途工作。这样旧请求或尚待回答的审批只对应原先的工具实现，代价是同一连接不能立即调用热替换后的工具。[迁移时记录的审批与撤权边界](dsh-0.2.2-rc.1.md#六处修复及保留边界) · [工具替换回归](../../test/unit/runtime/team-bridge.spec.ts) · [投影回归](../../test/unit/host/session-facts-projection.spec.ts)

#87 中 lukstei 提交了[独立的参考修复和回归](https://github.com/lukstei/dsh-acp-adapter/commit/78e4d0ce696db34a70c3c9a7bec9a6163edd360e)。#88 由 #79 的作者后续提出，涉及在同一 ACP 会话保留私有上下文的切模；#79 的成员模型初始化没有提供这项能力。
