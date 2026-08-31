/**
 * ACP 审批与运行边界的 sidecar 审计载荷。
 * `asked`/`decided` 配对记录 ACP agent 的选项列表（经过有界脱敏）与最终决定。
 *
 * 另有 `degradation`（{@link AcpDegradationAuditData}）：tool result 内容降级
 * （非文本项按占位/摘要落盘或截断）的事实记录，每次降级一条。
 *
 * 审计不是 DSH session event：0.1.2-alpha.1 仍没有可忽略的扩展事件 seam，直接写入未知
 * 事件会干扰 live session 的事件顺序。故本模块
 * 只产出纯 payload，由 ./permissions.ts（kind `permission`）包成 sidecar entry 经
 * `AcpSidecar.append` 落盘（见 src/persistence/sidecar.ts 模块注释）。
 * SessionEventMap declaration merging 与 `ignorable:true` 构造器不会回归——本包
 * 不再向 session log 写任何自定义事件。
 *
 * 两阶段保留可追溯审计：插件 ACP UI 的 `selectedOptionKind`/`decisionVia` 记录
 * 原始选项语义；旧 DSH 双按钮 fallback 无法精确对应时仍只选择 once-kind，
 * 绝不把一次选择升格为 always 类 optionId。`asked` 里的 optionId 保持精确，
 * 其余外部字段按持久化边界有界化。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/events
 */

import { createHash } from 'node:crypto'
import { redactSecretText as redactCommonSecretText } from '../observability/redaction.ts'
import type { PermissionOption, ToolCallLocation, ToolCallUpdate } from '@agentclientprotocol/sdk'

/** 审批审计 entry 在 sidecar 里的 `kind`（src/persistence/sidecar.ts entry 联合的判别值之一）。 */
export const ACP_PERMISSION_AUDIT_KIND = 'permission' as const

/**
 * tool result 内容降级审计 entry 的 sidecar `kind`：终端态 tool_call_update
 * 的 ACP 内容项无法原样呈现（diff/terminal/image/resource/未知类型按占位/摘要落盘，
 * 或超界截断）时记**一条**（不按 item 拆条）；非文本消息 chunk 占位落盘同样记一条。
 * 生产者是 host/composition/profile-adapter.ts 的 provider bridge（degradation 回调），
 * 接线在 src/domain/session/agent.ts（经 recordAudit seam 落 sidecar）。
 */
export const ACP_DEGRADATION_AUDIT_KIND = 'degradation' as const

/** DSH fork → ACP fork outcome, kept separate from degradation records. */
export const ACP_SESSION_FORK_AUDIT_KIND = 'session-fork' as const
export type AcpSessionForkOutcome = 'inherited' | 'blank'
export type AcpSessionForkReason =
  | 'inherited'
  | 'agent-does-not-advertise-fork'
  | 'parent-not-idle'
  | 'parent-recovery-required'
  | 'parent-binding-unavailable'
  | 'parent-binding-mismatch'
  | 'seed-not-latest-semantic-boundary'
  | 'candidate-not-available'

export interface AcpSessionForkAuditData {
  readonly outcome: AcpSessionForkOutcome
  readonly reason: AcpSessionForkReason
  readonly parentSessionId?: string
  readonly parentAgentSessionId?: string
  readonly agentSessionId?: string
}

/** Durable terminal lifecycle summary; command environment values are never included. */
export interface AcpTerminalAuditData {
  readonly operation: 'create' | 'output-summary' | 'exit' | 'kill' | 'release'
  readonly terminalId: string
  readonly dshSessionId: string
  readonly profileId: string
  readonly acpSessionId: string
  readonly command: string
  readonly argCount: number
  readonly cwd: string
  readonly outputBytes: number
  readonly truncated: boolean
  readonly outcome: 'started' | 'running' | 'exited' | 'killed' | 'released' | 'timeout' | 'error'
  readonly exitCode?: number | null
  readonly signal?: string | null
}

/**
 * 降级条目 payload 的类型真源在生产方 provider bridge（架构白名单：
 * protocol 层不得 import domain，domainPolicy → protocol 是许可方向，故此处
 * re-export 保持 sidecar 审计载荷在 events.ts 的可见性）。词表手工对齐说明见
 * 定义处注释。
 */
export type AcpDegradationCode = 'unsupported-tool-content' | 'unsupported-chunk-content'
export interface AcpDegradationItem {
  readonly type: string
  readonly reason: string
  readonly originalSize?: number
}
export interface AcpDegradationAuditData {
  readonly code: AcpDegradationCode
  readonly toolCallId?: string
  readonly items: readonly AcpDegradationItem[]
  readonly keptPreviewChars: number
  readonly truncated: boolean
}

/** Legacy approval outcome retained only to decode older permission audit rows. */
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

/** Bounds for ACP permission audit fields supplied by an external Agent. */
export const ACP_PERMISSION_AUDIT_OPTIONS_MAX = 32
export const ACP_PERMISSION_AUDIT_FIELD_MAX_CHARS = 512

/** 脱敏遍历界限：嵌套深度 / 数组条数 / 单字符串长度（防巨型 rawInput 放大审计体积）。 */
const REDACT_DEPTH_MAX = 6
const REDACT_ARRAY_MAX = 32
const REDACT_STRING_MAX = 200

const SHELL_SECRET_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s'"]+)`
const SECRET_JSON_PROPERTY_PATTERN = new RegExp(`((?:["']?)(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)(?:["']?)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^,\\s}\\]]+(?=\\s*[,}\\]]))`, 'gi')
const SECRET_ENV_ASSIGNMENT_PATTERN = new RegExp(`(\\b(?:[A-Za-z][A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)[A-Za-z0-9_-]*|token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)\\b)\\s*=\\s*${SHELL_SECRET_VALUE}`, 'gi')
const SECRET_OPTION_PATTERN = new RegExp(`(--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)[A-Za-z0-9_-]*)(?:\\s*=\\s*|\\s+)${SHELL_SECRET_VALUE}`, 'gi')
const SECRET_HEADER_PATTERN = new RegExp(`(\\b(?:authorization|proxy-authorization|x-api-key|api-key)\\b\\s*:\\s*(?:bearer\\s+)?)(?:"[^"]*"|'[^']*'|[^\\s'"]+)`, 'gi')

/**
 * 跨审计摘要与审批展示共用的 secret-text 脱敏规则。
 *
 * 对象字段由 {@link redactForAudit} 按 key 脱敏；但 command/header/env 等
 * 字符串内部仍可能携带 secret，因此这里也处理常见的文本形态。调用方
 * 必须在 raw input canonical hash 之外使用本函数，不能用脱敏值替代完整性哈希。
 */
export function redactSecretText(value: string): string {
  return redactCommonSecretText(value)
    .replace(SECRET_HEADER_PATTERN, '$1<redacted>')
    .replace(SECRET_JSON_PROPERTY_PATTERN, '$1<redacted>')
    .replace(SECRET_ENV_ASSIGNMENT_PATTERN, '$1=<redacted>')
    .replace(SECRET_OPTION_PATTERN, '$1=<redacted>')
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 递归脱敏：secret 词表命中的键值换 `<redacted>`；深度/数组/字符串各有界。 */
function redactForAudit(value: unknown, depth: number): unknown {
  if (depth > REDACT_DEPTH_MAX) return '…'
  if (typeof value === 'string') {
    const redacted = redactSecretText(value)
    return redacted.length > REDACT_STRING_MAX ? `${redacted.slice(0, REDACT_STRING_MAX)}…` : redacted
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

function boundedAuditText(value: string, max = ACP_PERMISSION_AUDIT_FIELD_MAX_CHARS): string {
  const sanitized = redactSecretText(value).replace(/[\u0000-\u001f\u007f]/g, ' ')
  return sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`
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
  /** The agent's option list, bounded and redacted for durable audit. */
  readonly options: readonly PermissionOption[]
  /** Number of options in the original ACP request (before audit bounding). Optional for pre-count sidecar rows. */
  readonly optionCount?: number
  /** Number of original options omitted from this bounded audit payload. Optional for pre-count sidecar rows. */
  readonly omittedOptionCount?: number
  /** Number of locations in the original ACP tool-call (before audit bounding). Optional for pre-count sidecar rows. */
  readonly locationCount?: number
  /** Number of original locations omitted from this bounded audit payload. Optional for pre-count sidecar rows. */
  readonly omittedLocationCount?: number
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
  /** Legacy field written by releases that consulted the DSH approval service. */
  readonly approvalOutcome?: AcpApprovalOutcome
  /** Exact option kind selected, without collapsing allow_once/allow_always. */
  readonly selectedOptionKind?: PermissionOption['kind']
  /** Which answerer produced the decision; the first two values are legacy. */
  readonly decisionVia?: 'acp-ui' | 'native-fallback' | 'native-question' | 'native-approval'
  /**
   * Current vocabulary includes `cancelled`, `question-service-unavailable`,
   * `agent-unavailable`, `custom-option-unsupported`, `invalid-option-id` and
   * `question-error`. Older approval bridge causes remain valid when reading
   * legacy rows.
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
  /** The agent's option list; durable fields are bounded/redacted below. */
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
  readonly selectedOptionKind?: PermissionOption['kind']
  readonly decisionVia?: 'acp-ui' | 'native-fallback' | 'native-question' | 'native-approval'
  readonly note?: string
}

/**
 * Build the `asked` audit payload: a bounded, redacted record of the question
 * as the agent posed it. The option id remains exact because it is the ACP
 * response identity used to answer the request; labels and collection size
 * are bounded for durable storage.
 * @param init - the ACP permission request's identity and option list.
 * @returns the sidecar-ready `asked` payload.
 */
export function createPermissionAskedAudit(init: PermissionAskedAuditInit): AcpPermissionAskedAuditData {
  const { toolCall } = init
  const rawInput = toolCall.rawInput == null ? undefined : summarizeRawInputForAudit(toolCall.rawInput)
  const optionCount = init.options.length
  const locationCount = toolCall.locations?.length ?? 0
  return {
    phase: 'asked',
    requestId: init.requestId,
    agentSessionId: init.agentSessionId,
    toolCall: {
      toolCallId: boundedAuditText(toolCall.toolCallId),
      ...(toolCall.title == null ? {} : { title: boundedAuditText(toolCall.title, 200) }),
      ...(toolCall.kind == null ? {} : { kind: boundedAuditText(toolCall.kind, 64) }),
      ...(toolCall.locations == null ? {} : { locations: toolCall.locations.slice(0, 4).map((location) => ({
        path: boundedAuditText(location.path),
        ...(location.line == null ? {} : { line: location.line }),
      })) }),
      ...(rawInput === undefined ? {} : { rawInputSummary: rawInput.summary, rawInputHash: rawInput.hash }),
    },
    options: init.options.slice(0, ACP_PERMISSION_AUDIT_OPTIONS_MAX).map((option) => ({
      ...option,
      optionId: option.optionId,
      name: boundedAuditText(option.name, 200),
    })),
    optionCount,
    omittedOptionCount: Math.max(0, optionCount - ACP_PERMISSION_AUDIT_OPTIONS_MAX),
    locationCount,
    omittedLocationCount: Math.max(0, locationCount - 4),
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
    ...(init.selectedOptionKind === undefined ? {} : { selectedOptionKind: init.selectedOptionKind }),
    ...(init.decisionVia === undefined ? {} : { decisionVia: init.decisionVia }),
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
