# 外部 ACP 非交互授权策略

[English](permission-policy.en.md)

策略插件可以把同一条规则注册到两个 Host 事件。`dsh-acp/permission-policy` 处理含多种范围的授权请求，`dsh-acp/binary-permission-policy` 处理原生二选一审批卡能够表达的请求。每个请求只进入一条策略链。现有策略显式注册第二个事件后，即可覆盖二选一审批。

这不是旧 `approval/request` 插件的自动迁移接口。旧事件混合自动答复和原生人工二选一，不能作为只查询机器规则的接口；`unavailable` 也不只表示没有规则。策略提供方需要明确接入本事件。

## 安装与公开入口

开发者从 `@zaimokuza/dsh-acp-adapter/permission-policy` 导入公开类型。该 Host ESM 入口导出 `AcpExternalPolicyRequest`、`AcpExternalPolicyDecision`、`AcpPermissionFacts<T>`，并包含 Cordis 服务和事件声明。默认导出是可显式挂载的策略服务类。适配器主插件默认不安装它；只注册事件监听器而不挂载服务，也不会触发机器策略。授权调用仍由适配器发起，策略提供方不应自行调用 `evaluate()` 替代该流程。

策略插件须依赖包含此入口的适配器版本，并通过 DSH 原有插件机制加载在同一 Host。由部署组合插件负责挂载一次策略服务，多个规则插件共享该实例；各规则插件声明 `acpPermissionPolicy` 服务依赖。不要每个规则插件各自重复安装服务，也不要向客户端远程暴露这个事件。这是开发者接入组合，不增加用户设置。

下面给出一组完整的组合与规则入口。先创建 `policy-rules.ts`：它演示如何为适配器已识别的 Antigravity runtime 拒绝执行类操作，其余请求继续交给后续策略。示例不是适配器内置规则。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AcpExternalPolicyDecision, AcpExternalPolicyRequest } from '@zaimokuza/dsh-acp-adapter/permission-policy'

export const inject = ['acpPermissionPolicy']

export function apply(ctx: Context): void {
  const rule = async (request: AcpExternalPolicyRequest, next: () => Promise<AcpExternalPolicyDecision>): Promise<AcpExternalPolicyDecision> => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.profile !== 'antigravity') return next()
    if (request.params.toolCall.kind === 'execute')
      return { decision: 'deny-once', reason: '本会话仅允许读取操作。' }
    return next()
  }
  ctx.on('dsh-acp/permission-policy', rule)
  ctx.on('dsh-acp/binary-permission-policy', rule)
}
```

然后创建通过 DSH 加载的组合插件入口 `index.ts`。它按顺序挂载共享服务与规则；需要多个规则时，在同一位置按所需顺序挂载其他规则插件。

```ts
import type { Context } from '@deepseek-ai/cordis'
import AcpPermissionPolicy from '@zaimokuza/dsh-acp-adapter/permission-policy'
import * as rules from './policy-rules.js'

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(AcpPermissionPolicy)
  await ctx.plugin(rules)
}
```

此组合插件的 Cordis 生命周期拥有策略服务和规则注册。卸载组合会清理二者；仅卸载某个规则插件不会卸载共享服务。适配器主插件与组合插件可能有不同的 owner，因此不能把“适配器主插件卸载”等同于“策略服务已经卸载”。部署方应显式管理组合的生命周期，不再需要策略时卸载该组合。

真实策略应使用现有机器规则服务，传递 `request.signal`，并在取消时清理自己的资源。它不能打开审批 UI、调用 `approval.request()` 或将工具操作重新执行一次。ACP 参数是外部 Agent 提供的事实，不是可信的企业策略或工具归属证明。

## 请求与返回契约

| 字段        | 含义                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`     | 原始执行子会话或主会话的真实 DSH `Agent` 对象，不是显示审批卡的父会话。对象身份保持不变；它不是克隆或冻结的 Agent 快照。                              |
| `requestId` | 当前适配器权限请求的标识，与既有 asked/decided 审计对应。不要只用外部 `toolCallId` 缓存决定。                                                         |
| `profile`   | 适配器解析的 runtime 分类，例如 `antigravity`、`devin`、`qwen`，不可用时为 `generic`。它不是用户配置的 profile ID 或名称，也不能由请求 `_meta` 改写。 |
| `params`    | 深度只读的完整 ACP 请求，包括原始选项 ID、kind 和名称。服务在第一次异步让出前克隆并冻结 JSON 事实，策略不能修改原请求或后续回复选项。                 |
| `signal`    | 当前请求和服务生命周期的合并取消信号。策略必须配合取消；不能凭时间经过推断授权成功。                                                                  |

策略可以直接返回以下字符串，也可以返回带说明的 `{ decision, reason?: string }`。

| 结果             | 适配器行为                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allow-once`     | 只有唯一 `allow_once` 时才返回其原始 ID；缺少或有多个不同范围的一次允许时，保留完整人工选择。不会转换为长期授权。 |
| `deny-once`      | 返回唯一 `reject_once` 的原始 ID；无法唯一表达时取消请求，不退回可以允许的人工问答。                              |
| `not-applicable` | 结束本次策略链，进入原有完整人工选择。要让下一策略判断，请调用并返回 `next()`。                                   |
| `cancelled`      | 取消本次授权，不打开人工允许降级。                                                                                |
| `failed`         | 取消授权，并使用原生反馈说明规则不可用、本次未授权。抛错和非法返回按此处理，不暴露异常详情。                      |

请提供简短、适合向用户和 Agent 公开的理由。转交人工时，审批卡先显示理由，再显示原始操作和选项。策略拒绝或取消时，适配器会在同一执行者和 ACP 会话下一次已准入的 `session/prompt` 中附带一次理由。外部 Agent 当前回合的内部推理步骤仍只收到标准权限答复。适配器不会为此发起模型调用。停止请求、关闭连接或替换执行者后，待发理由会丢弃。每条说明最多 512 个字符，每个连接保留最近 16 条。自动允许和规则故障不会转发理由。

策略决定不直接替代 Sidecar 持久化。现有权限处理器继续记录同一组 `asked` / `decided`，完成审计、取消和实例身份检查后才回复 ACP。服务不另设规则库、授权缓存或持久化 owner。

## 让 Antigravity 在同一轮读到命令拒绝理由

在 Apple 芯片 Mac 上，以 `agy acp` 或 `agy acp --stdio` 启动已验证的 Google 官方 `agy` 1.5.12 时，策略插件可以在同一服务注册 `dsh-acp/pre-tool-policy`，检查 CLI 即将执行的原生命令 `run_command`。适配器会为这个进程加载 Google 的 `PreToolUse` 钩子。用户可以沿用当前工作区和已有的钩子文件。

```ts
ctx.on('dsh-acp/pre-tool-policy', async (request, next) => {
  if (request.params.toolCall.kind === 'execute')
    return { decision: 'deny-once', reason: '此工作区只允许只读操作。' }
  return next()
})
```

事件提供执行操作的 Agent、ACP 会话、工具调用和取消信号。公开类型为 `AcpPreToolPolicyRequest` 和 `AcpPreToolPolicyDecision`。规则可以附公开理由拒绝本次调用、调用 `next()` 交给下一条规则，或返回 `not-applicable` 交回 CLI。拒绝决定单独写入 `phase: 'pre-tool'` 的权限审计，关联真实工具调用 ID，Antigravity 在当前轮就能收到理由。规则交回 CLI 后，原有规则继续生效，需要人工确认时仍显示原始选项。已有策略插件可以单独接入这个事件，保留自己的 ACP 审批处理器。

## 多策略顺序与生命周期

事件沿用 Cordis waterfall，而不是汇总投票：

1. 通常按注册顺序进入；显式 `{ prepend: true }` 会排到已有处理者前面。会话作用域过滤仍使用原始 Agent 身份及其祖先范围，兄弟会话不互相接收请求。
2. 处理者没有适用规则时应 `return next()`。链尾向提供方返回 `not-applicable`。所有规则都委托下一条时，已启用的 OpenCode 审查可接手符合条件的请求；规则直接返回 `not-applicable` 时交由人工决定。
3. 处理者直接返回结果时，其后的处理者不会被调用。直接返回 `not-applicable` 也会停止链；它不是自动跳过当前处理者。
4. 这是有序的策略委托，**不是所有插件间全局拒绝优先**。前面的允许可以使后面的拒绝没有执行机会。部署方须明确拥有策略顺序；处理者不应调用 `next()` 后改写下游决定。

注册归提供方 Cordis fiber 所有，注销后不再接收新请求。已经接受的异步工作仍由提供方负责清理。策略服务实际卸载时立即取消已接受调用的等待者，并等待已启动回调结算；同进程里忽略取消、永不退出的插件无法被安全强杀，卸载会继续等待。该契约没有超时自动允许或强制结束兜底。

## 保留的路由与边界

- 二选一授权在没有适用策略时交给原生审批。Antigravity 普通交互问答继续由问答服务处理。
- DSH 工具桥校验当前会话的工具身份和目录。匹配目录本身不授予权限；真正执行时仍需通过宿主的 `tools.execute` 检查。
- 父页面只代呈原子会话的审批；回复、执行身份和审计仍归原子会话。取消、实例替换和迟到决定不能授予已失效请求。
- 两个 ACP 授权事件处理 Agent 实际发来的请求。上述 Antigravity 执行前事件覆盖它的原生命令工具。ACP 客户端提供的文件和终端操作仍有各自独立的控制路径。
- 无规则且无人在线时仍等待人工；浏览器连接状态不能当作自动允许的条件。不能承诺普遍无人值守或 Host 崩溃后恢复未完成的机器策略调用。

接入方需要验证自己的规则和部署顺序。

## AI 审批

插件详情中的「AI 审批」默认关闭。开启后，该设置适用于 macOS 和 Linux 上受支持的本地 Devin 和 OpenCode 配置。审查进程无工具权限，只接收当前任务和待执行的操作。审计保存判断后，插件才可选择原请求中唯一的「仅本次允许」。模型标为高风险、审查未能得出结论或缺少唯一的「仅本次允许」选项时，由你确认。Windows 和 SSH 执行沿用人工审批。所选模型提供方会收到经脱敏的任务和操作内容，包括可能涉及的文件路径或变更。

### Devin

支持官方 CLI `3000.14.30821`。默认审查模型为 `swe-2-high`，可在详情页更改。第三方策略不代答 Devin 的请求；如果组织强制加载扩展，或无法核实独立审查进程没有扩展和 MCP 服务，请求转人工。业务会话可以继续使用自己的 MCP 和 Teams 工具。

### OpenCode

本地 `opencode acp` 2.3.2 支持主会话内置文件、检索和终端工具。默认沿用该会话已确认的模型，也可在详情页为此 Agent 选择其他审查模型。OpenCode 的 Ask 请求不携带规则来源；如果组织要求每个 Ask 都由人回答，请保留 AI 审批关闭。

业务连接需在启动时核实工具来源。已打开的会话如果缺少这项记录，会继续由你审批，直到下次建立连接。独立审查进程使用 OpenCode 的无工具文本生成接口。只有能核实进程隔离、审查结果和审计已保存时，才可选择原始的「仅本次允许」。外部策略有明确决定时优先；交回人工的策略、DSH 桥接工具请求、子 Agent、交互问答及无法核实的请求继续由你处理。会话审计分别显示模型的结论和最终是谁作答。
