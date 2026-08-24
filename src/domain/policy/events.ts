/**
 * ACP 审批与运行边界的 sidecar 审计载荷。
 * `asked`/`decided` 配对记录 ACP agent 的完整选项列表与最终决定。
 *
 * 本模块同时承载权限范围与 Agent mode 两条独立审计轴：
 * - `permission-scope`（{@link AcpPermissionScopeAuditData}）：DSH 权限范围轴——每次
 *   ACP spawn 重新解析 `ctx.sandboxPolicy` 后的实际 confine 事实。这是安全边界
 *   （宿主 sandbox 强制的能力上限），与 ACP mode 无关。
 * - `agent-mode`（{@link AcpAgentModeAuditData}）：ACP agent mode 轴——mode 的建立
 *   与每次经本插件 seam 下发的切换。这是 agent 侧行为配置，不是安全边界。
 * 两轴各自独立条目、分别落盘，不做隐式双向同步；agent 自发推送的
 * `current_mode_update` 只更新 UI 状态槽，v1 不落条目（审计记录本插件建立/下发的事实）。
 * 另有 `degradation`（{@link AcpDegradationAuditData}）：tool result 内容降级
 * （非文本项按占位/摘要落盘或截断）的事实记录，每次降级一条。
 *
 * 审计不是 DSH session event：rc.2 没有可忽略的扩展事件 seam，直接写入未知
 * 事件会干扰 live session 的事件顺序。故本模块
 * 只产出纯 payload，由 ./permissions.ts（kind `permission`）与
 * src/domain/session/agent.ts（的两个新 kind）包成 sidecar entry 经
 * `AcpSidecar.append` 落盘（见 src/persistence/sidecar.ts 模块注释）。
 * SessionEventMap declaration merging 与 `ignorable:true` 构造器不会回归——本包
 * 不再向 session log 写任何自定义事件。
 *
 * 两阶段保留完整审计：双按钮 web 面板与 agent 选项表无法精确对应的一侧
 * （此时桥答 cancelled，绝不把一次选择升格为 always 类 optionId——见
 * ./permissions.ts 模块头），`asked` 里的完整选项列表仍是唯一未损记录。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/events
 */

import { createHash } from 'node:crypto'
import type { PermissionOption, ToolCallLocation, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { AcpConfinedArgv, AcpSandboxMode } from './sandbox.ts'

/** 审批审计 entry 在 sidecar 里的 `kind`（src/persistence/sidecar.ts entry 联合的判别值之一）。 */
export const ACP_PERMISSION_AUDIT_KIND = 'permission' as const

/** DSH 权限范围轴审计 entry 的 sidecar `kind`（每次 ACP spawn 落一条）。 */
export const ACP_PERMISSION_SCOPE_AUDIT_KIND = 'permission-scope' as const

/** ACP agent mode 轴审计 entry 的 sidecar `kind`（建立与每次下发切换各落一条）。 */
export const ACP_AGENT_MODE_AUDIT_KIND = 'agent-mode' as const

/** agent 配置改动审计 entry 的 sidecar `kind`（面板/设置文档的每次改动一条）。 */
export const ACP_AGENT_CONFIG_AUDIT_KIND = 'agent-config' as const

/**
 * tool result 内容降级审计 entry 的 sidecar `kind`：终端态 tool_call_update
 * 的 ACP 内容项无法原样呈现（diff/terminal/image/resource/未知类型按占位/摘要落盘，
 * 或超界截断）时记**一条**（不按 item 拆条）；非文本消息 chunk 占位落盘同样记一条。
 * 生产者是 src/protocol/v1/translate.ts 的 TurnTranslator（degradation 回调），
 * 接线在 src/domain/session/agent.ts（经 recordAudit seam 落 sidecar）。
 */
export const ACP_DEGRADATION_AUDIT_KIND = 'degradation' as const

/**
 * 降级条目 payload 的类型真源在生产方 src/protocol/v1/translate.ts（架构白名单：
 * protocol 层不得 import domain，domainPolicy → protocol 是许可方向，故此处
 * re-export 保持 sidecar 审计载荷在 events.ts 的可见性）。词表手工对齐说明见
 * 定义处注释。
 */
export type { AcpDegradationAuditData, AcpDegradationCode, AcpDegradationItem } from '../../protocol/v1/translate.ts'

/**
 * DSH 权限范围轴的审计快照：每次 spawn 前 `ctx.sandboxPolicy.resolve`
 * 重新解析出档位，本条目记录该次 spawn **实际应用**的 confine 事实。
 */
export interface AcpPermissionScopeAuditData {
  /** spawn 时重新解析的 DSH 会话权限档位（安全边界，与 ACP mode 无关）。 */
  readonly mode: AcpSandboxMode
  /**
 * 产出该次 spawn 计划的平台标识（扩展字段；= 平台 adapter 的
   * `process.platform` 值）——enforcement 事实的平台归属据此可读
   * （win32 恒 partial，见 src/domain/policy/platform/windows.ts）。
   */
  readonly platform: string
  /**
   * 实际 confine 事实（可写 root + enforcement 如实透传）；`null` = 未 confine
   * （danger-full-access：子进程持有宿主用户的 OS 级写权限——此时唯一防线是
   * DSH 原生 Full Access 确认与审批桥，二者都不是 sandbox 意义上的边界）。
   */
  readonly confined: {
    readonly workspaceRoot: string
    readonly enforcement: AcpConfinedArgv['enforcement']
  } | null
}

/** ACP agent mode 轴审计快照的来源词表。 */
export type AcpAgentModeAuditVia = 'session-setup' | 'set_config_option' | 'set_mode'

/**
 * ACP agent mode 轴的审计快照：mode 是 agent 侧行为配置（Devin 的
 * Ask/Plan/Accept Edits/Bypass 等），不改变 DSH sandbox 档位；本条目只回答
 * 「该会话此刻处于哪个 mode、谁切过来的」。
 */
export interface AcpAgentModeAuditData {
  readonly modeId: string
  /**
   * 快照来源：`session-setup`（会话建立响应/种子）/ `set_config_option` /
   * `set_mode`（均为本插件 seam 下发的切换）。agent 自发推送的
   * `current_mode_update` 只更新 UI 状态槽，v1 不落条目。
   */
  readonly via: AcpAgentModeAuditVia
}

/**
 * agent 配置改动审计快照：`dsh-acp` 设置文档里一个 agent 条目的
 * 新增/移除/改动事实。落盘位置是 sidecar 的配置审计专档（伪 sessionId
 * `agent-config`，见 src/persistence/sidecar.ts），不是某个会话的文件——配置
 * 改动先于/独立于任何会话存在。
 *
 * 密钥纪律（硬约束）：env 只记**键名级** diff（added/removed/changed 的键名
 * 列表），值永不落盘——疑似 secret 的值只记「已变更」事实本身。command/args
 * 是审计要点（谁在把 spawn 命令改成什么），变更时记新值快照。
 */
export interface AcpAgentConfigAuditData {
  readonly change: 'added' | 'removed' | 'changed'
  readonly agentId: string
  /**
   * 改动涉及的字段名（`name`/`command`/`args`/`env`/`loginHint` 的
 * 子集，排序固定； credentialReadPaths 字段已删除，不再出现）；
   * added/removed 时为该条目的全量字段清单（removed 的 env 同样只记键名）。
   */
  readonly changedFields: readonly string[]
  /** command 变更（或 added 时的初始值）快照；不涉及时缺席。 */
  readonly command?: string
  /** args 变更（或 added 时的初始值）快照；不涉及时缺席。 */
  readonly args?: readonly string[]
  /** env 键名级 diff（值永不落盘）；env 未涉及时缺席。 */
  readonly env?: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
}

/** {@link createAgentConfigAudit} 的输入（diff 由 agent-config.ts 的纯函数产出）。 */
export interface AgentConfigAuditInit {
  readonly change: 'added' | 'removed' | 'changed'
  readonly agentId: string
  readonly changedFields: readonly string[]
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
}

/**
 * 组装 `agent-config` 审计 payload（可选字段缺席而非 undefined；env 键名列表
 * 各自排序固定，保证 recordId 哈希稳定）。
 */
export function createAgentConfigAudit(init: AgentConfigAuditInit): AcpAgentConfigAuditData {
  return {
    change: init.change,
    agentId: init.agentId,
    changedFields: [...init.changedFields].sort(),
    ...(init.command === undefined ? {} : { command: init.command }),
    ...(init.args === undefined ? {} : { args: [...init.args] }),
    ...(init.env === undefined
      ? {}
      : {
          env: {
            added: [...init.env.added].sort(),
            removed: [...init.env.removed].sort(),
            changed: [...init.env.changed].sort(),
          },
        }),
  }
}

/**
 * Structural mirror of dsh-user-approval's `ApprovalOutcome` (this package does
 * not depend on that package; the real `ctx.approval` service is assignable to
 * the bridge's requester interface because both sides use this closed union).
 */
export type AcpApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The tool-call snapshot persisted in the `asked` phase: id/title/kind/
 * locations + rawInput 的**有界脱敏摘要与哈希**（修订—— 曾把 rawInput
 * 原文随快照落盘，理由是 sidecar 为唯一审计通道、快照须自洽；但 rawInput 可能
 * 携带 secret 值（命令行里的 token、配置内容），审计真源不等于可以原文落盘。
 * 此后改为 `rawInputSummary`（字段级脱敏 + 有界单行）+ `rawInputHash`
 * （canonical JSON 的 sha256-16，完整性证据、不可逆）——审计可核对「当时问的
 * 是什么」且不留秘密字节）。status/content/rawOutput 不入快照：它们描述执行
 * 进展/结果，而 asked 记的是「要不要执行」的问题本身（提问时 status 恒 pending）。
 */
export interface AcpPermissionToolCallSnapshot {
  readonly toolCallId: string
  readonly title?: string
  readonly kind?: string
  readonly locations?: readonly ToolCallLocation[]
  /** rawInput 的字段级脱敏、有界单行摘要（{@link summarizeRawInputForAudit}；agent 未发 rawInput 时缺席）。 */
  readonly rawInputSummary?: string
  /** rawInput canonical JSON 的 sha256 前 16 hex（agent 未发 rawInput 时缺席）。 */
  readonly rawInputHash?: string
}

/** rawInput 审计摘要按字段名脱敏的 key 词表（命中键的值替换为 `<redacted>`，永不落盘）。 */
export const AUDIT_SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i

/** rawInput 审计摘要的截断上限（单行可读性；与审批 reason 摘要同口径）。 */
export const RAW_INPUT_AUDIT_SUMMARY_MAX_CHARS = 300

/** 脱敏遍历界限：嵌套深度 / 数组条数 / 单字符串长度（防巨型 rawInput 放大审计体积）。 */
const REDACT_DEPTH_MAX = 6
const REDACT_ARRAY_MAX = 32
const REDACT_STRING_MAX = 200

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 递归脱敏：secret 词表命中的键值换 `<redacted>`；深度/数组/字符串各有界。 */
function redactForAudit(value: unknown, depth: number): unknown {
  if (depth > REDACT_DEPTH_MAX) return '…'
  if (typeof value === 'string') {
    return value.length > REDACT_STRING_MAX ? `${value.slice(0, REDACT_STRING_MAX)}…` : value
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value.slice(0, REDACT_ARRAY_MAX).map((item) => redactForAudit(item, depth + 1))
    if (value.length > REDACT_ARRAY_MAX) items.push(`… +${String(value.length - REDACT_ARRAY_MAX)} items`)
    return items
  }
  if (isPlainObjectValue(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = AUDIT_SECRET_KEY_PATTERN.test(key) ? '<redacted>' : redactForAudit(value[key], depth + 1)
    }
    return out
  }
  return value
}

/** canonical JSON（对象键排序递归）：哈希与摘要的稳定输入（与生产者键序无关）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isPlainObjectValue(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * rawInput 的审计落盘形态：`hash` 是**原文** canonical JSON 的
 * sha256-16（完整性证据，不可逆、不含秘密字节）；`summary` 是**脱敏后**的
 * canonical 单行，超界截断并标注原始长度。summary 不含任何 secret 键的值。
 */
export function summarizeRawInputForAudit(rawInput: unknown): { summary: string; hash: string } {
  const hash = createHash('sha256').update(canonicalJson(rawInput)).digest('hex').slice(0, 16)
  const redacted = canonicalJson(redactForAudit(rawInput, 0))
  const summary =
    redacted.length > RAW_INPUT_AUDIT_SUMMARY_MAX_CHARS
      ? `${redacted.slice(0, RAW_INPUT_AUDIT_SUMMARY_MAX_CHARS)}…(+${String(redacted.length - RAW_INPUT_AUDIT_SUMMARY_MAX_CHARS)} chars)`
      : redacted
  return { summary, hash }
}

/** `asked` phase payload: the question exactly as the agent posed it. */
export interface AcpPermissionAskedAuditData {
  readonly phase: 'asked'
  /** Pairs this record with its `decided` counterpart. */
  readonly requestId: string
  /** ACP-side session id the request arrived on (diagnostics). */
  readonly agentSessionId: string
  readonly toolCall: AcpPermissionToolCallSnapshot
  /** The agent's complete option list, verbatim (审批审计边界: audit loses nothing). */
  readonly options: readonly PermissionOption[]
}

/** `decided` phase payload: what the bridge answered, and why. */
export interface AcpPermissionDecidedAuditData {
  readonly phase: 'decided'
  /**
   * Pairs this record with its `asked` counterpart. 此后为
   * `dsh-acp-permission-<randomUUID >`——跨进程/跨重启全局唯一，不再是模块级
   * 计数器（旧计数器在 DSH 重启后重复，sidecar 去重会丢掉新 decided）。
   */
  readonly requestId: string
  /**
   * ACP-side session id the request arrived on（decided 也落——去重键
   * 的 ACP 会话分量；DSH 会话分量即 sidecar 文件键）。
   */
  readonly agentSessionId: string
  /** 被决定的 tool call id（去重键的 tool call 分量）。 */
  readonly toolCallId: string
  /** The outcome returned to the ACP agent. */
  readonly outcome: 'selected' | 'cancelled'
  /** The selected option id (present iff `outcome === 'selected'`). */
  readonly optionId?: string
  /** The dsh approval service's own outcome, when it was consulted. */
  readonly approvalOutcome?: AcpApprovalOutcome
  /**
   * Outcome cause. Vocabulary: `user-rejected`（审批服务以 `rejected` 结案——
 * 用户点拒或 `never` 策略——且桥选中 reject 类选项回包； taxonomy
 * 预留词， 归位）, `cancelled` (user/turn abort),
   * `approval-unavailable` (no UI answerer), `approval-error` (service threw),
 * `allow-once-unsupported` / `reject-once-unsupported`（该侧无
   * once-kind 选项可忠实映射——含仅 always 类、完全缺失与仅未知 kind——
   * 桥答 cancelled，绝不升格 always 类 optionId）。
   */
  readonly note?: string
}

/** The permission audit payload union (discriminant: `phase`). */
export type AcpPermissionAuditData = AcpPermissionAskedAuditData | AcpPermissionDecidedAuditData

/** Inputs for {@link createPermissionAskedAudit}. */
export interface PermissionAskedAuditInit {
  readonly requestId: string
  readonly agentSessionId: string
  /** The ACP permission request's tool call; snapshotted down to id/title/kind/locations/rawInput. */
  readonly toolCall: ToolCallUpdate
  /** The agent's complete option list; persisted verbatim by the sidecar's JSON snapshot. */
  readonly options: readonly PermissionOption[]
}

/** Inputs for {@link createPermissionDecidedAudit}. Optional fields stay ABSENT (not undefined). */
export interface PermissionDecidedAuditInit {
  readonly requestId: string
  /** ACP-side session id（decided 去重键分量，必填）。 */
  readonly agentSessionId: string
  /** 被决定的 tool call id（decided 去重键分量，必填）。 */
  readonly toolCallId: string
  readonly outcome: 'selected' | 'cancelled'
  readonly optionId?: string
  readonly approvalOutcome?: AcpApprovalOutcome
  readonly note?: string
}

/**
 * Build the `asked` audit payload: the question exactly as the agent posed it.
 * @param init - the ACP permission request's identity and verbatim option list.
 * @returns the sidecar-ready `asked` payload.
 */
export function createPermissionAskedAudit(init: PermissionAskedAuditInit): AcpPermissionAskedAuditData {
  const { toolCall } = init
  const rawInput = toolCall.rawInput == null ? undefined : summarizeRawInputForAudit(toolCall.rawInput)
  return {
    phase: 'asked',
    requestId: init.requestId,
    agentSessionId: init.agentSessionId,
    toolCall: {
      toolCallId: toolCall.toolCallId,
      ...(toolCall.title == null ? {} : { title: toolCall.title }),
      ...(toolCall.kind == null ? {} : { kind: toolCall.kind }),
      ...(toolCall.locations == null ? {} : { locations: toolCall.locations }),
      ...(rawInput === undefined ? {} : { rawInputSummary: rawInput.summary, rawInputHash: rawInput.hash }),
    },
    options: init.options,
  }
}

/**
 * Build the `decided` audit payload: the answer returned to the agent plus the
 * facts needed to audit why (approval outcome / fail-closed note).
 * @param init - the answered decision.
 * @returns the sidecar-ready `decided` payload.
 */
export function createPermissionDecidedAudit(init: PermissionDecidedAuditInit): AcpPermissionDecidedAuditData {
  return {
    phase: 'decided',
    requestId: init.requestId,
    agentSessionId: init.agentSessionId,
    toolCallId: init.toolCallId,
    outcome: init.outcome,
    ...(init.optionId === undefined ? {} : { optionId: init.optionId }),
    ...(init.approvalOutcome === undefined ? {} : { approvalOutcome: init.approvalOutcome }),
    ...(init.note === undefined ? {} : { note: init.note }),
  }
}

/** Narrow audit payload to the `asked` phase. */
export function isPermissionAskedAudit(data: AcpPermissionAuditData): data is AcpPermissionAskedAuditData {
  return data.phase === 'asked'
}

/** Narrow audit payload to the `decided` phase. */
export function isPermissionDecidedAudit(data: AcpPermissionAuditData): data is AcpPermissionDecidedAuditData {
  return data.phase === 'decided'
}
