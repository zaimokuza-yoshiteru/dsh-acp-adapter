# 外部 ACP 非交互授权策略

[English](permission-policy.en.md)

适配器提供 Host 内的 `dsh-acp/permission-policy` 扩展事件，让明确接入的策略插件处理完整 ACP 授权请求。它不需要修改 DSH，也不增加适配器用户设置或默认授权规则。未安装策略插件时，原有完整选项和人工交互保持不变。

这不是旧 `approval/request` 插件的自动迁移接口。旧事件混合自动答复和原生人工二选一，不能作为只查询机器规则的接口；`unavailable` 也不只表示没有规则。策略提供方需要明确接入本事件。

## 安装与公开入口

开发者从 `@zaimokuza/dsh-acp-adapter/permission-policy` 导入公开类型。该 Host ESM 入口导出 `AcpExternalPolicyRequest`、`AcpExternalPolicyDecision`、`AcpPermissionFacts<T>`，并包含 Cordis 服务和事件声明。默认导出是可显式挂载的策略服务类。适配器主插件默认不安装它；只注册事件监听器而不挂载服务，也不会触发机器策略。授权调用仍由适配器发起，策略提供方不应自行调用 `evaluate()` 替代该流程。

策略插件须依赖包含此入口的适配器版本，并通过 DSH 原有插件机制加载在同一 Host。由部署组合插件负责挂载一次策略服务，多个规则插件共享该实例；各规则插件声明 `acpPermissionPolicy` 服务依赖。不要每个规则插件各自重复安装服务，也不要向客户端远程暴露这个事件。这是开发者接入组合，不增加用户设置。

下面给出一组完整的组合与规则入口。先创建 `policy-rules.ts`：它演示如何为适配器已识别的 Antigravity runtime 拒绝执行类操作，其余请求继续交给后续策略。示例不是适配器内置规则。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AcpExternalPolicyRequest } from '@zaimokuza/dsh-acp-adapter/permission-policy'

export const inject = ['acpPermissionPolicy']

export function apply(ctx: Context): void {
  ctx.on('dsh-acp/permission-policy', async (request: AcpExternalPolicyRequest, next) => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.profile !== 'antigravity') return next()
    if (request.params.toolCall.kind === 'execute') return 'deny-once'
    return next()
  })
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

只允许以下五种结果：

| 结果             | 适配器行为                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allow-once`     | 只有唯一 `allow_once` 时才返回其原始 ID；缺少或有多个不同范围的一次允许时，保留完整人工选择。不会转换为长期授权。 |
| `deny-once`      | 返回唯一 `reject_once` 的原始 ID；无法唯一表达时取消请求，不退回可以允许的人工问答。                              |
| `not-applicable` | 结束本次策略链，进入原有完整人工选择。要让下一策略判断，请调用并返回 `next()`。                                   |
| `cancelled`      | 取消本次授权，不打开人工允许降级。                                                                                |
| `failed`         | 取消授权，并使用原生反馈说明规则不可用、本次未授权。抛错和非法返回按此处理，不暴露异常详情。                      |

策略决定不直接替代 Sidecar 持久化。现有权限处理器继续记录同一组 `asked` / `decided`，完成审计、取消和实例身份检查后才回复 ACP。服务不另设规则库、授权缓存或持久化 owner。

## 多策略顺序与生命周期

事件沿用 Cordis waterfall，而不是汇总投票：

1. 通常按注册顺序进入；显式 `{ prepend: true }` 会排到已有处理者前面。会话作用域过滤仍使用原始 Agent 身份及其祖先范围，兄弟会话不互相接收请求。
2. 处理者没有适用规则时应 `return next()`。链尾返回 `not-applicable`。
3. 处理者直接返回结果时，其后的处理者不会被调用。直接返回 `not-applicable` 也会停止链；它不是自动跳过当前处理者。
4. 这是有序的策略委托，**不是所有插件间全局拒绝优先**。前面的允许可以使后面的拒绝没有执行机会。部署方须明确拥有策略顺序；处理者不应调用 `next()` 后改写下游决定。

注册归提供方 Cordis fiber 所有，注销后不再接收新请求。已经接受的异步工作仍由提供方负责清理。策略服务实际卸载时立即取消已接受调用的等待者，并等待已启动回调结算；同进程里忽略取消、永不退出的插件无法被安全强杀，卸载会继续等待。该契约没有超时自动允许或强制结束兜底。

## 保留的路由与边界

- 二选一授权仍使用既有原生审批；Antigravity 普通交互问答不进入此机器策略事件。
- 已确认身份的 DSH 工具桥 Auto 保留原路径和真实 `tools.execute` 检查。此扩展不改变 Auto、Full access、bypass 或子会话原生 `never` 的含义。
- Devin 完整授权保持保守人工路径。不能从 Agent 自报 metadata 或模式推断企业强制 Ask 可被自动回答。
- 父页面只代呈原子会话的审批；回复、执行身份和审计仍归原子会话。取消、实例替换和迟到决定不能授予已失效请求。
- 这里只处理 Agent 实际发来的 ACP 授权请求，不会拦截 Agent 私有进程里没有发来请求的操作，也不会把这些工具接入 DSH Auto Review。ACP 客户端提供的文件和终端操作仍有各自独立的控制路径。
- 无规则且无人在线时仍等待人工；浏览器连接状态不能当作自动允许的条件。不能承诺普遍无人值守或 Host 崩溃后恢复未完成的机器策略调用。

接入方需要验证自己的规则和部署顺序。测试策略的结果不代表 Issue 作者实际插件已经兼容，也不代表所有 Agent、企业策略或操作系统都已通过验收。用户安装说明保持在 README；实际运行记录和验证证据不属于此公共 API 文档。
