/**
 * ACP 审批与运行边界的 sidecar 审计载荷。
 * `asked`/`decided` 配对记录 ACP agent 的选项列表（经过有界脱敏）与最终决定。
 *
 * 本模块同时承载权限范围与 Agent mode 两条独立审计轴：
 * - `permission-scope`（{@link AcpPermissionScopeAuditData}）：每次 ACP spawn
 *   重新解析 `ctx.sandboxPolicy` 后记录 Native Agent Access 的准入事实。它不
 *   表示插件建立了操作系统安全边界，与 ACP mode 无关。
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
 * 两阶段保留可追溯审计：插件 ACP UI 的 `selectedOptionKind`/`decisionVia` 记录
 * 原始选项语义；旧 DSH 双按钮 fallback 无法精确对应时仍只选择 once-kind，
 * 绝不把一次选择升格为 always 类 optionId。`asked` 里的 optionId 保持精确，
 * 其余外部字段按持久化边界有界化。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/events
 */

import { createHash } from 'node:crypto'
import type { PermissionOption, ToolCallLocation, ToolCallUpdate } from '@agentclientprotocol/sdk'

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

/** DSH fork → ACP fork outcome, kept separate from degradation records. */
export const ACP_SESSION_FORK_AUDIT_KIND = 'session-fork' as const
export type AcpSessionForkOutcome = 'inherited' | 'blank'
export type AcpSessionForkReason =
  | 'inherited'
  | 'agent-does-not-advertise-fork'
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

/** Structured ACP elicitation audit; submitted values and URL query strings are excluded. */
export const ACP_ELICITATION_AUDIT_KIND = 'elicitation' as const
export type { AcpElicitationAudit as AcpElicitationAuditData } from './elicitation.ts'

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
 * 降级条目 payload 的类型真源在生产方 src/protocol/v1/translate.ts（架构白名单：
 * protocol 层不得 import domain，domainPolicy → protocol 是许可方向，故此处
 * re-export 保持 sidecar 审计载荷在 events.ts 的可见性）。词表手工对齐说明见
 * 定义处注释。
 */
export type { AcpDegradationAuditData, AcpDegradationCode, AcpDegradationItem } from '../../protocol/v1/translate.ts'

/**
 * DSH 权限范围轴的审计快照：每次 spawn 前重新解析档位，本条目记录
 * ACP 进程采用的 Native Agent Access 事实。审批不是操作系统安全边界。
 */
export interface AcpPermissionScopeAuditData {
  /** spawn 时重新解析并验证过的 DSH 会话权限档位。 */
  readonly mode: 'danger-full-access'
  /**
   * 产出该次 spawn 计划的平台标识（扩展字段；= `process.platform`）。
   */
  readonly platform: string
  /**
   * 恒为 `null`：插件不包装或隔离 Agent 子进程；子进程持有宿主用户可用的
   * OS 权限，ACP 审批不是强制安全边界。
   */
  readonly confined: null
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
  return value
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
  /** The dsh approval service's own outcome, when it was consulted. */
  readonly approvalOutcome?: AcpApprovalOutcome
  /** Exact option kind selected, without collapsing allow_once/allow_always. */
  readonly selectedOptionKind?: PermissionOption['kind']
  /** Which answerer produced the decision. */
  readonly decisionVia?: 'acp-ui' | 'native-fallback'
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
  readonly decisionVia?: 'acp-ui' | 'native-fallback'
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
