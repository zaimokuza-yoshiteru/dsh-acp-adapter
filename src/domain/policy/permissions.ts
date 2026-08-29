/**
 * ACP approval bridge。所有无法精确表达的选择都 fail closed，审计写入 sidecar：
 * ACP `session/request_permission` uses the plugin-owned browser broker when a
 * fresh observer lease exists, preserving the exact optionId (including
 * always-kind options). Without that lease it falls back to
 * `ctx.approval.request({ agent, toolName, callId, reason, signal })`; that
 * legacy two-button seam maps only once-kind options and never promotes a
 * choice to always. Missing once-kind options fail closed with an explicit
 * disclosure (see {@link ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE} /
 * {@link ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE}).
 *
 * This handler is the package's ONLY consumer of the approval service, wired
 * exclusively as `AcpClientConnection.onPermissionRequest` — which the
 * connection invokes solely for wire `session/request_permission` frames
 * (the approval UI therefore appears only for requests the agent
 * actually sent; 全仓无第二个 `approval.request` 调用点).
 *
 * Fail closed everywhere: a request arriving outside an open turn, a missing
 * or throwing approval service, an un-mappable option list, or a failed audit
 * append all answer `cancelled` and log — the bridge never defaults to allow.
 *
 * Pending-request settlement：Devin 的挂起请求永不悬挂，但桥**不设
 * 护栏超时** ACP v1 对 `session/request_permission` 没有 wire 级超时约定
 * （协议唯一条款：client 发 `session/cancel` 时 MUST 对所有挂起权限请求答
 * `cancelled`——reference/agent-client-protocol docs/protocol/v1/
 * prompt-turn.mdx §cancellation），用户思考时间本就无界；且 dsh 把未答
 * 问题作为 durable pending 持有（浏览器断开不取消、重连 replay——宿主
 * DSH 0.1.2-alpha.1 Session Controller 应答者语义），桥侧自造超时会在 agent 已被告知 cancelled 之后
 * 把 dsh 侧问题留成仍可应答的僵尸。取代超时的是终局结算保证：
 * - turn/会话取消或 dispose：turn abort signal 经 `turnSignal` 透传，审批
 *   服务以 `cancelled` 结案并丢弃迟到答复，桥答 cancelled（协议 MUST 条款
 *   由此满足）；
 * - 插件卸载/agent dispose：compat 拆除链 `cancel({kind:'disposed'})` →
 *   `whenIdle()` → `scope.dispose()` → 连接关闭杀子进程——即便 cancelled
 *   回包与关流竞速落败（SDK 吞掉迟到写，无 unhandled rejection），子进程
 *   死亡即结算 agent 侧挂起请求；
 * - 审批网关自身 teardown：宿主把其挂起问题全部结算 `cancelled`。
 * UI/浏览器单纯断开不会取消已经交给 broker 的问题（问题保持可答，桥忠实
 * 等待、绝不伪造答复）；后续请求因 observer lease 过期而精确降级到 DSH
 * approval。审批服务缺席/抛错则立即 fail closed `cancelled`。
 *
 * Audit (审批审计边界, sidecar 持久化规则 通道): the asked/decided pair (payload 见 ./events.ts) 经注入的
 * {@link AcpPermissionAuditChannel} 落 **sidecar**（不落 session log——spike 实证
 * 直写 sessionPersistence 在 live session 上吞后续 live 事件，
 * `审批顺序探针`）——asked BEFORE consulting the
 * approval service, decided BEFORE responding to the agent. An audit append
 * failure aborts the request with `cancelled`: returning an unlogged decision
 * would violate the audit pair. asked 记 agent 选项列表（有界脱敏）与 toolCall
 * 快照（含 rawInput 摘要）；decided 记 outcome/optionId/approvalOutcome/
 * note——拒绝结案（用户点拒或 never 策略）的 decided 带 note
 * `user-rejected`（taxonomy 预留词， 归位）。
 *
 * 观测面：deps.log 的第二参携带结构化字段（operation=permission +
 * acpSessionId + result 终局码，宿主接线层补 dshSessionId/acpProvider）；
 * deps.metrics 计 acp.approval.requested / acp.approval.decided{outcome}
 * 配对计数（缺席 = 不记录；词表见 ../observability/metrics.ts 模块头）。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/policy/permissions
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type * as acp from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PermissionRequestHandler } from '../../protocol/v1/types.ts'
import { acpUnknownToolName } from '../../protocol/v1/translate.ts'
import type { AcpToolCallPresentationSnapshot } from '../../protocol/v1/translate.ts'
import type { AcpLogFields } from '../observability/logging.ts'
import { ACP_METRIC } from '../observability/metrics.ts'
import type { AcpMetricsLike } from '../observability/metrics.ts'
import {
  ACP_PERMISSION_AUDIT_KIND,
  createPermissionAskedAudit,
  createPermissionDecidedAudit,
  redactSecretText,
  type AcpApprovalOutcome,
  type AcpPermissionAuditData,
} from './events.ts'
import { summarizeRawInputForAudit } from './events.ts'

export type { AcpApprovalOutcome } from './events.ts'

/**
 * ask 时 `reason` 的可用性披露句：agent 选项表缺 `allow_once` kind 时附——
 * 面板的选择允许无法忠实表达，桥将视为取消（绝不升格 allow_always）。
 */
export const ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE = 'This agent did not offer an allow-once option; a one-time allow choice will be treated as cancelled'

/**
 * ask 时 `reason` 的可用性披露句：agent 选项表缺 `reject_once` kind 时附——
 * 面板的选择拒绝无法忠实表达，桥将视为取消（绝不升格 reject_always）。
 */
export const ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE = 'This agent did not offer a reject-once option; a one-time reject choice will be treated as cancelled'

/** Maximum option buttons retained by the plugin-owned approval surface. */
export const ACP_PERMISSION_OPTIONS_MAX = 128
/** Maximum UTF-8 byte length of ACP identities retained or echoed by the bridge. */
export const ACP_PERMISSION_ID_MAX_BYTES = 512

class AcpPermissionOptionsLimitError extends Error {
  constructor(count: number) {
    super(`ACP permission request contains ${String(count)} options; limit is ${String(ACP_PERMISSION_OPTIONS_MAX)}`)
    this.name = 'AcpPermissionOptionsLimitError'
  }
}

class AcpPermissionIdentityLimitError extends Error {
  constructor(kind: 'toolCallId' | 'optionId') {
    super(`ACP permission ${kind} exceeds the ${String(ACP_PERMISSION_ID_MAX_BYTES)}-byte identity limit`)
    this.name = 'AcpPermissionIdentityLimitError'
  }
}

function assertPermissionIdentity(value: string, kind: 'toolCallId' | 'optionId'): void {
  if (Buffer.byteLength(value, 'utf8') > ACP_PERMISSION_ID_MAX_BYTES) {
    throw new AcpPermissionIdentityLimitError(kind)
  }
}

function assertPermissionIdentities(toolCallId: string, options: readonly acp.PermissionOption[]): void {
  assertPermissionIdentity(toolCallId, 'toolCallId')
  for (const option of options) assertPermissionIdentity(option.optionId, 'optionId')
}

function isToolKind(value: string | undefined): value is acp.ToolKind {
  return value === 'read' || value === 'edit' || value === 'delete' || value === 'move'
    || value === 'search' || value === 'execute' || value === 'think' || value === 'fetch'
    || value === 'switch_mode' || value === 'other'
}

/** rawInput JSON 摘要的截断上限（reason 单行可读性）。 */
export const RAW_INPUT_SUMMARY_MAX_CHARS = 300

/**
 * Structural narrowing of dsh-user-approval's `ApprovalRequest` (this package
 * does not depend on that package; field-for-field identical, so the real
 * service is assignable to {@link AcpApprovalRequester}).
 */
export interface AcpApprovalRequest {
  /** The agent on whose behalf the question is asked (routing + audit target). */
  readonly agent: Agent
  /** The tool the question is about (ACP `name`/`title` — presentation and audit). */
  readonly toolName: string
  /** The exact tool call being decided, matching the streamed `tool/call`. */
  readonly callId?: ReturnType<typeof ToolCallId>
  /** Human-readable why: tool title/kind, rawInput summary, locations, once-option availability disclosure. */
  readonly reason?: string
  /** Turn abort signal: aborting settles the question `'cancelled'`. */
  readonly signal?: AbortSignal
}

/** The dsh approval service face the bridge needs (`ctx.approval` in production). */
export interface AcpApprovalRequester {
  /**
   * Ask for one decision. Rejects when no turn is open.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; `'allowed-once'` is the only grant.
   */
  request(req: AcpApprovalRequest): Promise<AcpApprovalOutcome>
}

export type AcpPendingPermissionDecision =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

/** Broker-owned view; remote/service maps this structurally to the wire contract. */
export interface AcpPendingPermissionView {
  readonly requestId: string
  readonly sessionId: string
  readonly acpSessionId: string
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly reason: string
  readonly agentId?: string
  readonly agentName?: string
  readonly locations?: readonly { readonly path: string; readonly displayPath?: string; readonly line?: number }[]
  /** Total locations in the Agent request and count omitted from the bounded view. */
  readonly locationCount?: number
  readonly omittedLocationCount?: number
  readonly inputSummary?: string
  /** A bounded, redacted command summary for execute requests. */
  readonly command?: string
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[]
  readonly createdAt: number
}

export interface AcpPendingPermissionRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly acpSessionId: string
  readonly toolCall: acp.RequestPermissionRequest['toolCall']
  readonly options: readonly acp.PermissionOption[]
  readonly reason: string
  readonly agentId?: string
  readonly agentName?: string
  /** Workspace root used only to derive a compact, user-facing path label. */
  readonly workspaceRoot?: string
  readonly signal?: AbortSignal
}

/** Plugin-owned broker preserving every ACP optionId until the client answers. */
export interface AcpPendingPermissionBroker {
  open(request: AcpPendingPermissionRequest): Promise<AcpPendingPermissionDecision>
  list(sessionId?: string): readonly AcpPendingPermissionView[]
  /** Mark the browser permission surface as reachable for this DSH session. */
  observe(sessionId: string): void
  /** True only while a recent browser heartbeat exists; stale observers fail over to DSH approval. */
  hasFreshObserver(sessionId: string, now?: number): boolean
  answer(sessionId: string, requestId: string, optionId: string): void
  cancel(sessionId: string, requestId: string): void
  cancelSession(sessionId: string): void
  dispose(): void
}

interface PendingPermissionEntry {
  readonly view: AcpPendingPermissionView
  readonly options: readonly acp.PermissionOption[]
  readonly resolve: (decision: AcpPendingPermissionDecision) => void
  readonly signal?: AbortSignal
  readonly abort: () => void
}

export class InMemoryAcpPendingPermissionBroker implements AcpPendingPermissionBroker {
  private readonly entries = new Map<string, PendingPermissionEntry>()
  private readonly observers = new Map<string, number>()
  private readonly clock: () => number
  /** Poll cadence is 750ms; this lease only selects the answerer and never times out an approval. */
  static readonly OBSERVER_LEASE_MS = 5_000
  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  open(request: AcpPendingPermissionRequest): Promise<AcpPendingPermissionDecision> {
    const key = this.key(request.sessionId, request.requestId)
    if (this.entries.has(key)) throw new Error('pending ACP permission "' + request.requestId + '" is already active')
    if (request.signal?.aborted === true) return Promise.resolve({ outcome: 'cancelled' })
    assertPermissionIdentities(request.toolCall.toolCallId, request.options)
    // Never show a partial option set: the response identity must remain a
    // faithful projection of the Agent request. Refuse oversized requests as
    // a whole; the handler records the refusal and answers cancelled.
    if (request.options.length > ACP_PERMISSION_OPTIONS_MAX) {
      return Promise.reject(new AcpPermissionOptionsLimitError(request.options.length))
    }
    const command = requestCommand(request.toolCall)
    const view: AcpPendingPermissionView = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      acpSessionId: request.acpSessionId,
      toolCallId: request.toolCall.toolCallId,
      title: permissionToolName(request.toolCall),
      kind: request.toolCall.kind ?? 'unknown',
      reason: request.reason,
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
      ...(request.toolCall.locations == null ? {} : { locations: request.toolCall.locations.slice(0, 4).map((location) => {
        const path = safeReasonText(location.path, 4_096).replaceAll('\\', '/')
        return {
          // `path` is the bounded, redacted technical fact. `displayPath` is
          // the compact label rendered in the primary details row.
          path,
          displayPath: displayTargetPath(path, request.workspaceRoot),
          ...(location.line === undefined || location.line === null ? {} : { line: location.line }),
        }
      }) }),
      ...(request.toolCall.locations == null ? {} : {
        locationCount: request.toolCall.locations.length,
        omittedLocationCount: Math.max(0, request.toolCall.locations.length - 4),
      }),
      ...(request.toolCall.rawInput === undefined ? {} : { inputSummary: summarizeRawInputForAudit(request.toolCall.rawInput).summary }),
      ...(command === undefined ? {} : { command }),
      options: request.options.map((option) => ({
        // Keep optionId byte-for-byte: it is the ACP response identity, not a
        // display field. The visible label is the bounded field below.
        optionId: option.optionId,
        name: safeReasonText(option.name, 200),
        kind: option.kind,
      })),
      createdAt: this.clock(),
    }
    return new Promise((resolve) => {
      const abort = (): void => this.settle(key, { outcome: 'cancelled' })
      const entry: PendingPermissionEntry = {
        view,
        options: request.options,
        resolve,
        abort,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      this.entries.set(key, entry)
      request.signal?.addEventListener('abort', abort, { once: true })
      // Close the tiny registration/abort race: an abort can land between the
      // pre-check above and listener registration.
      if (request.signal?.aborted === true) abort()
    })
  }

  list(sessionId?: string): readonly AcpPendingPermissionView[] {
    return [...this.entries.values()]
      .map((entry) => entry.view)
      .filter((view) => sessionId === undefined || view.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  observe(sessionId: string): void {
    this.observers.set(sessionId, this.clock())
  }

  hasFreshObserver(sessionId: string, now = this.clock()): boolean {
    const observedAt = this.observers.get(sessionId)
    if (observedAt === undefined) return false
    if (now - observedAt > InMemoryAcpPendingPermissionBroker.OBSERVER_LEASE_MS) {
      this.observers.delete(sessionId)
      return false
    }
    return true
  }

  answer(sessionId: string, requestId: string, optionId: string): void {
    assertPermissionIdentity(optionId, 'optionId')
    const key = this.key(sessionId, requestId)
    const entry = this.entries.get(key)
    if (entry === undefined) throw new Error('pending ACP permission "' + requestId + '" is not active')
    if (!entry.options.some((option) => option.optionId === optionId)) {
      throw new Error('optionId "' + optionId + '" was not offered by the Agent')
    }
    this.settle(key, { outcome: 'selected', optionId })
  }

  cancel(sessionId: string, requestId: string): void {
    const key = this.key(sessionId, requestId)
    if (!this.entries.has(key)) throw new Error('pending ACP permission "' + requestId + '" is not active')
    this.settle(key, { outcome: 'cancelled' })
  }

  cancelSession(sessionId: string): void {
    this.observers.delete(sessionId)
    for (const [key, entry] of this.entries) if (entry.view.sessionId === sessionId) this.settle(key, { outcome: 'cancelled' })
  }

  dispose(): void {
    this.observers.clear()
    for (const key of [...this.entries.keys()]) this.settle(key, { outcome: 'cancelled' })
  }

  private key(sessionId: string, requestId: string): string {
    return sessionId + '\u0000' + requestId
  }

  private settle(key: string, decision: AcpPendingPermissionDecision): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.abort)
    entry.resolve(decision)
  }
}

/**
 * 一条待落盘的审批审计记录：sidecar permission entry 的全字段形态（`time` 由桥
 * 用注入时钟打好——测试确定性；生产接线即 `(record) => sidecar.append(sessionId,
 * record)`，见 src/persistence/sidecar.ts 的 `AcpSidecarEntryInput`）。
 */
export interface AcpPermissionAuditRecord {
  readonly kind: typeof ACP_PERMISSION_AUDIT_KIND
  /** Unix epoch milliseconds. */
  readonly time: number
  readonly data: AcpPermissionAuditData
}

/**
 * 审计落盘通道（seam；sidecar 持久化规则 后唯一的持久化出口）。生产实现 =
 * `AcpSidecar.append` 绑定到所属 dsh sessionId（接线点：
 * `permissionHandler` 注入处构造）。
 *
 * 与 sidecar 持久化规则 前的契约差异：不再有 `nextSeq()` 与单调下限——sidecar 是
 * append-only 旁路存储（SQLite WAL 单库），无 session-log seq 概念；
 * 顺序由调用先后保证，permission 审计走同步 durable 路径（append 落库 commit
 * 后才 resolve——本桥 fail-closed 语义依赖此）。
 */
export interface AcpPermissionAuditChannel {
  /**
   * Persist one audit record (production: `sidecar.append(sessionId, record)`).
   * @param record - fully-stamped permission audit record.
   */
  append(record: AcpPermissionAuditRecord): Promise<void>
}

/** Dependencies of {@link createAcpPermissionHandler}. */
export interface AcpPermissionBridgeDeps {
  /** The dsh agent handle forwarded to `approval.request` (routing + audit pair target). */
  readonly agent: Agent
  /** Bounded profile identity shown in the plugin-owned permission card. */
  readonly agentId?: string
  readonly agentName?: string
  /** DSH session identity used by the plugin-owned pending broker (distinct from ACP sessionId). */
  readonly dshSessionId?: string | undefined
  /** Workspace root for compact approval path labels; never a security boundary. */
  readonly workspaceRoot?: string | undefined
  /**
   * The dsh approval service (`ctx.approval` in production). ABSENT means the
   * UI answerer is unavailable → every request fails closed to `cancelled`.
   */
  readonly approval?: AcpApprovalRequester | undefined
  /** Optional plugin-owned broker; preserves every ACP optionId. */
  readonly pending?: AcpPendingPermissionBroker | undefined
  /** Bounded translator identity used when request_permission omits title/kind. */
  readonly toolCallPresentation?: ((toolCallId: string) => AcpToolCallPresentationSnapshot | undefined) | undefined
  /** The audit append channel (see its contract). */
  readonly audit: AcpPermissionAuditChannel
  /**
   * Whether the owning dsh session currently sits inside an open turn — the
   * `approval.request` precondition. The wiring (AcpAgent turn driver) knows
   * this; requests arriving when false are answered `cancelled` + logged.
   */
  readonly hasOpenTurn: () => boolean
  /** The current turn's abort signal, if a turn is open (forwarded to `approval.request`). */
  readonly turnSignal?: (() => AbortSignal | undefined) | undefined
  /**
 * Log sink for fail-closed paths (production: 结构化 logger 的 warn 绑定，
 * 见 src/host/factory/agent-loop.ts)；第二参携带结构化字段（词表，适用
   * 字段缺失即省略）。default noop.
   */
  readonly log?: ((message: string, fields?: AcpLogFields) => void) | undefined
  /** Clock for audit timestamps (default `Date.now`); tests inject determinism. */
  readonly now?: (() => number) | undefined
  /**
 * 指标 sink：`acp.approval.requested` / `acp.approval.decided`
   * （decided 带 outcome 标签）。缺席 = 不记录。
   */
  readonly metrics?: AcpMetricsLike | undefined
}

/** The outcome→optionId mapping result. */
type MappedDecision =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled'; readonly note: string }

/**
 * requestId 用 `randomUUID()`——跨进程/跨 DSH 重启全局唯一。旧实现是
 * 模块级计数器（`dsh-acp-permission-<n>`），重启后从 1 重新计数，两个进程先后写
 * 同一 sidecar 时第二个进程的 decided 会因 `decided:<requestId>` 撞名被去重跳过
 * （新 asked 保留、对应 decided 丢失）。去重键组成见 sidecar.ts
 * `decidedDedupeKeyOf`：DSH session（文件键）+ ACP session + tool call + request
 * occurrence（本 id）。
 */
function newPermissionRequestId(): string {
  return `dsh-acp-permission-${randomUUID()}`
}

function cancelledResponse(): acp.RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pick the option id for a grant side, by `PermissionOptionKind` (never by
 * label text): ONLY the once-kind option qualifies ( — the two-button
 * panel expresses one-time semantics; an always-kind or unknown-kind option is
 * never a faithful answer, so its absence resolves to `cancelled`).
 */
function pickOption(
  options: readonly acp.PermissionOption[],
  onceKind: acp.PermissionOptionKind,
  missingNote: string,
): MappedDecision {
  const once = options.find((option) => option.kind === onceKind)
  if (once !== undefined) return { outcome: 'selected', optionId: once.optionId }
  return { outcome: 'cancelled', note: missingNote }
}

/** dsh outcome → ACP response mapping (see module doc for the table). */
function mapOutcome(outcome: AcpApprovalOutcome, options: readonly acp.PermissionOption[]): MappedDecision {
  switch (outcome) {
    case 'allowed-once':
      return pickOption(options, 'allow_once', 'allow-once-unsupported')
    case 'rejected':
      return pickOption(options, 'reject_once', 'reject-once-unsupported')
    case 'cancelled':
      return { outcome: 'cancelled', note: 'cancelled' }
    case 'unavailable':
      return { outcome: 'cancelled', note: 'approval-unavailable' }
  }
}

/** True when the agent's option list offers the given kind. */
function hasKind(options: readonly acp.PermissionOption[], kind: acp.PermissionOptionKind): boolean {
  return options.some((option) => option.kind === kind)
}

const PERMISSION_REASON_MAX_CHARS = 180
const PERMISSION_TOOL_TITLE_MAX_CHARS = 80

function safeReasonText(value: string, max = PERMISSION_REASON_MAX_CHARS): string {
  const sanitized = redactSecretText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (sanitized.length <= max) return sanitized
  return `${sanitized.slice(0, max - 1)}…`
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function rawString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    if (/(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i.test(key)) continue
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length > 0) return value.join(' ')
  }
  return undefined
}

function shortTargetPath(value: string): string {
  // Select the tail before applying the display bound; truncating the complete
  // path first can discard the actual filename and leave only parent segments.
  const clean = safeReasonText(value, Number.MAX_SAFE_INTEGER).replaceAll('\\', '/')
  const absolute = clean.startsWith('/')
  const parts = clean.split('/').filter(Boolean)
  if (parts.length === 0) return clean
  const display = absolute || clean.length > 90 || parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : clean
  return safeReasonText(display)
}

/** Prefer a workspace-relative label; otherwise keep a short path tail. */
function displayTargetPath(value: string, workspaceRoot?: string): string {
  const clean = value.replaceAll('\\', '/').replace(/\/+/g, '/')
  const root = workspaceRoot === undefined
    ? undefined
    : workspaceRoot.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '')
  if (root !== undefined && root !== '' && (clean === root || clean.startsWith(`${root}/`))) {
    const relative = clean.slice(root.length).replace(/^\//, '')
    return safeReasonText(relative === '' ? '.' : relative, 160)
  }
  return shortTargetPath(clean).slice(0, 160)
}

function requestDetail(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  const record = rawRecord(tool.rawInput)
  const kind = tool.kind ?? ''
  if (kind === 'execute') {
    const command = typeof tool.rawInput === 'string' ? tool.rawInput : rawString(record, ['command', 'cmd', 'argv'])
    return command === undefined ? undefined : `Command: ${safeReasonText(command)}`
  }
  if (kind === 'edit' || kind === 'read' || kind === 'delete' || kind === 'move') {
    if (kind === 'move') {
      const source = rawString(record, ['source', 'source_path', 'sourcePath', 'from'])
      const destination = rawString(record, ['destination', 'destination_path', 'destinationPath', 'dest', 'to', 'target'])
      if (source !== undefined && destination !== undefined) {
        return `Source: ${shortTargetPath(source)}; destination: ${shortTargetPath(destination)}`
      }
      const oneSided = source ?? destination
      if (oneSided !== undefined) return `${source === undefined ? 'Destination' : 'Source'}: ${shortTargetPath(oneSided)}`
    }
    const rawPath = rawString(record, ['file_path', 'filePath', 'path', 'target', 'source', 'destination', 'dest', 'filename'])
    const location = tool.locations?.find((entry) => typeof entry.path === 'string')?.path
    const target = rawPath ?? location
    return target === undefined ? undefined : `Target: ${shortTargetPath(target)}`
  }
  // For unknown shapes, only use the existing field-level redacted summary;
  // never put raw JSON in a user-facing approval prompt.
  if (tool.rawInput !== undefined) {
    const summary = summarizeRawInputForAudit(tool.rawInput).summary
    return summary === '{}' ? undefined : `Details: ${safeReasonText(summary)}`
  }
  return undefined
}

/** Extract only an execute command for a readable approval code block. */
function requestCommand(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  if (tool.kind !== 'execute') return undefined
  const record = rawRecord(tool.rawInput)
  const command = typeof tool.rawInput === 'string' ? tool.rawInput : rawString(record, ['command', 'cmd', 'argv'])
  return command === undefined ? undefined : safeReasonText(command, 512)
}

/**
 * Assemble a self-contained, bounded approval reason.  ACP does not require a
 * preceding tool_call, and the host approval panel does not render locations
 * from a missing pairing, so the request itself carries a small redacted title
 * and command/path detail.  It deliberately never includes raw JSON.
 */
export interface AcpPermissionReasonOptions {
  /** Native DSH fallback has no folded detail panel, so retain its command summary. */
  readonly includeExecuteDetails?: boolean
}

export function buildPermissionReason(
  params: acp.RequestPermissionRequest,
  options: AcpPermissionReasonOptions = {},
): string {
  const reasonByKind: Record<string, string> = {
    execute: 'The ACP Agent requests permission to run a command.',
    edit: 'The ACP Agent requests permission to edit files.',
    delete: 'The ACP Agent requests permission to delete files.',
    move: 'The ACP Agent requests permission to move files.',
    read: 'The ACP Agent requests permission to read restricted content.',
    fetch: 'The ACP Agent requests permission to access a restricted external resource.',
  }
  const kind = params.toolCall.kind ?? ''
  const lines = [reasonByKind[kind] ?? 'The ACP Agent requests permission to perform a restricted operation.']
  const title = params.toolCall.title ?? params.toolCall.name
  if (typeof title === 'string' && title.trim() !== '') lines.push(`Tool: ${safeReasonText(title)}`)
  const detail = requestDetail(params.toolCall)
  if (detail !== undefined && (params.toolCall.kind !== 'execute' || options.includeExecuteDetails !== false)) lines.push(detail)
  if (!hasKind(params.options, 'allow_once')) {
    lines.push(`Note: ${ACP_PERMISSION_NO_ALLOW_ONCE_DISCLOSURE}`)
  }
  if (!hasKind(params.options, 'reject_once')) {
    lines.push(`Note: ${ACP_PERMISSION_NO_REJECT_ONCE_DISCLOSURE}`)
  }
  return lines.join('\n')
}

/** 审批标题：优先 Agent 标题；否则用稳定语义标签，最后才回退有界 callId。 */
function permissionToolName(tool: acp.RequestPermissionRequest['toolCall']): string {
  const explicit = tool.title ?? tool.name
  if (typeof explicit === 'string') {
    const safe = safeReasonText(explicit, PERMISSION_TOOL_TITLE_MAX_CHARS)
    if (safe !== '') return safe
  }
  const byKind: Record<string, string> = {
    execute: 'Run command',
    edit: 'Edit files',
    delete: 'Delete files',
    move: 'Move files',
    read: 'Read files',
    fetch: 'Access external resource',
  }
  return byKind[tool.kind ?? ''] ?? acpUnknownToolName(tool.toolCallId)
}

/**
 * Create the `session/request_permission` handler for one ACP agent session
 * (wired as `AcpAgentOptions.permissionHandler` → `AcpClientConnection`'s
 * `onPermissionRequest`; the connection invokes it per agent request).
 *
 * Flow per request: outside a turn → `cancelled` + log (no audit — a bare
 * asked record between turns has no pairing context). Inside a turn: asked
 * record → `approval.request` → map the outcome (kind-based, once-kind only;
 * no always fallback) → decided record → response. Any missing/throwing
 * dependency or failed audit append resolves to `cancelled` + log (fail
 * closed).
 *
 * @param deps - see {@link AcpPermissionBridgeDeps}.
 * @returns the permission handler for `AcpClientConnection`.
 */
export function createAcpPermissionHandler(deps: AcpPermissionBridgeDeps): PermissionRequestHandler {
  const log = deps.log ?? ((): void => undefined)
  const now = deps.now ?? ((): number => Date.now())

  return async (params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
    const accumulated = deps.toolCallPresentation?.(params.toolCall.toolCallId)
    const toolCall = accumulated === undefined
      ? params.toolCall
      : {
          ...params.toolCall,
          ...(params.toolCall.title == null && accumulated.title !== undefined ? { title: accumulated.title } : {}),
          ...(params.toolCall.kind == null && isToolKind(accumulated.kind) ? { kind: accumulated.kind } : {}),
          ...(params.toolCall.locations == null && accumulated.locations !== undefined ? { locations: [...accumulated.locations] } : {}),
          ...(params.toolCall.rawInput == null && accumulated.inputSummary !== undefined ? { rawInput: accumulated.inputSummary } : {}),
        }
    const toolTitle = safeReasonText(toolCall.title ?? toolCall.toolCallId, PERMISSION_TOOL_TITLE_MAX_CHARS)
 // 结构化字段（acpSessionId 来自请求本身；dshSessionId/acpProvider 由
    // 生产接线的 log 绑定补齐）与指标（requested/decided 配对计数）
    const fields = (result: string): AcpLogFields => ({ operation: 'permission', acpSessionId: params.sessionId, result })
    const decided = (outcome: 'selected' | 'cancelled'): void => {
      deps.metrics?.increment(ACP_METRIC.approvalDecided, { outcome })
    }
    deps.metrics?.increment(ACP_METRIC.approvalRequested)

    if (!deps.hasOpenTurn()) {
      log(`dsh-acp permission bridge: request for "${toolTitle}" arrived outside an open turn; responding cancelled (fail closed)`, fields('cancelled'))
      decided('cancelled')
      return cancelledResponse()
    }

    // ACP identities are echoed back in the response and used as broker keys.
    // Refuse the complete request before creating an audit row or pending UI;
    // truncating either identity could answer a different Agent request.
    try {
      assertPermissionIdentities(toolCall.toolCallId, params.options)
    } catch (error: unknown) {
      log(`dsh-acp permission bridge: request identity exceeds the safe limit for "${toolTitle}" (${errorMessage(error)}); responding cancelled (fail closed)`, fields('cancelled'))
      decided('cancelled')
      return cancelledResponse()
    }

    const requestId = newPermissionRequestId()
    try {
      await deps.audit.append({
        kind: ACP_PERMISSION_AUDIT_KIND,
        time: now(),
        data: createPermissionAskedAudit({
          requestId,
          agentSessionId: params.sessionId,
          toolCall,
          options: params.options,
        }),
      })
    } catch (error: unknown) {
      log(`dsh-acp permission bridge: asked audit append failed for "${toolTitle}" (${errorMessage(error)}); responding cancelled (fail closed)`, fields('cancelled'))
      decided('cancelled')
      return cancelledResponse()
    }

    let outcome: AcpApprovalOutcome
    let pendingDecision: MappedDecision | undefined
    let errorNote: string | undefined
    let selectedOptionKind: acp.PermissionOption['kind'] | undefined
    const signal = deps.turnSignal?.()
    const dshSessionId = deps.dshSessionId ?? String(deps.agent.id)
    const usePluginUi = deps.pending !== undefined && deps.pending.hasFreshObserver(dshSessionId)
    if (usePluginUi && deps.pending !== undefined) {
      try {
        const decision = await deps.pending.open({
          requestId,
          sessionId: dshSessionId,
          acpSessionId: params.sessionId,
          toolCall,
          options: params.options,
          // The plugin dock renders execute details in a folded code block;
          // do not repeat a potentially long command in the always-visible
          // reason. Native fallback below keeps the detail because it has no
          // separate ACP request panel.
          reason: buildPermissionReason({ ...params, toolCall }, { includeExecuteDetails: false }),
          ...(deps.agentId === undefined ? {} : { agentId: deps.agentId }),
          ...(deps.agentName === undefined ? {} : { agentName: deps.agentName }),
          ...(deps.workspaceRoot === undefined ? {} : { workspaceRoot: deps.workspaceRoot }),
          ...(signal === undefined ? {} : { signal }),
        })
        if (decision.outcome === 'selected') {
          const option = params.options.find((candidate) => candidate.optionId === decision.optionId)
          if (option === undefined) {
            outcome = 'unavailable'
            pendingDecision = { outcome: 'cancelled', note: 'invalid-option-id' }
          } else if (option.kind === 'allow_once' || option.kind === 'allow_always') {
            outcome = 'allowed-once'
            selectedOptionKind = option.kind
            pendingDecision = { outcome: 'selected', optionId: option.optionId }
          } else if (option.kind === 'reject_once' || option.kind === 'reject_always') {
            outcome = 'rejected'
            selectedOptionKind = option.kind
            pendingDecision = { outcome: 'selected', optionId: option.optionId }
          } else {
            outcome = 'unavailable'
            pendingDecision = { outcome: 'cancelled', note: 'unknown-option-kind' }
          }
        } else {
          outcome = 'cancelled'
          pendingDecision = { outcome: 'cancelled', note: 'cancelled' }
        }
      } catch (error: unknown) {
        outcome = 'unavailable'
        errorNote = error instanceof AcpPermissionOptionsLimitError ? 'options-limit' : 'pending-broker-error'
        pendingDecision = { outcome: 'cancelled', note: errorNote }
        log('dsh-acp permission broker failed for "' + toolTitle + '" (' + errorMessage(error) + '); responding cancelled (fail closed)', fields('cancelled'))
      }
    } else if (deps.approval === undefined) {
      outcome = 'unavailable'
      log(`dsh-acp permission bridge: no fresh plugin observer or approval service available for "${toolTitle}" (no approval service); responding cancelled (fail closed)`, fields('cancelled'))
    } else {
      try {
        outcome = await deps.approval.request({
          agent: deps.agent,
          // name/title 双缺时回退到含 callId 的有界中文标签（真机 Devin
          // 的 request_permission 常不带 name/title——审批 UI 不再显示字面量
          // 'unknown-tool'）；fail-closed 语义不变。
          toolName: permissionToolName(toolCall),
          callId: ToolCallId(toolCall.toolCallId),
          reason: buildPermissionReason({ ...params, toolCall }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error: unknown) {
        outcome = 'unavailable'
        errorNote = 'approval-error'
        log(`dsh-acp permission bridge: approval service threw for "${toolTitle}" (${errorMessage(error)}); responding cancelled (fail closed)`, fields('cancelled'))
      }
    }

    const mapped = pendingDecision ?? mapOutcome(outcome, params.options)
    if (mapped.outcome === 'selected' && selectedOptionKind === undefined) {
      selectedOptionKind = params.options.find((option) => option.optionId === mapped.optionId)?.kind
    }
    if (mapped.outcome === 'cancelled' && (mapped.note === 'allow-once-unsupported' || mapped.note === 'reject-once-unsupported')) {
      log(`dsh-acp permission bridge: agent offered no once-kind ${mapped.note === 'allow-once-unsupported' ? 'allow' : 'reject'} option for "${toolTitle}"; responding cancelled (fail closed)`, fields('cancelled'))
    }

    try {
      await deps.audit.append({
        kind: ACP_PERMISSION_AUDIT_KIND,
        time: now(),
        data: createPermissionDecidedAudit({
          requestId,
          agentSessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          outcome: mapped.outcome,
          ...(usePluginUi ? {} : { approvalOutcome: outcome }),
          ...(selectedOptionKind === undefined ? {} : { selectedOptionKind }),
          decisionVia: usePluginUi ? 'acp-ui' : 'native-fallback',
          ...(mapped.outcome === 'selected'
            ? {
                optionId: mapped.optionId,
 // taxonomy 词 user-rejected 归位：审批服务以
                // `rejected` 结案（用户点拒或 never 策略）且桥答出 reject 类
                // 选项——审计可按该词 grep 出所有拒绝决定。
                ...(outcome === 'rejected' ? { note: 'user-rejected' } : {}),
              }
            : { note: errorNote ?? mapped.note }),
        }),
      })
    } catch (error: unknown) {
      // 决定已出但审计未落：回 selected 会违反 asked/decided 配对（fail closed）
      log(`dsh-acp permission bridge: decided audit append failed for "${toolTitle}" (${errorMessage(error)}); responding cancelled (fail closed)`, fields('cancelled'))
      decided('cancelled')
      return cancelledResponse()
    }

    decided(mapped.outcome)
    return mapped.outcome === 'selected'
      ? { outcome: { outcome: 'selected', optionId: mapped.optionId } }
      : cancelledResponse()
  }
}
