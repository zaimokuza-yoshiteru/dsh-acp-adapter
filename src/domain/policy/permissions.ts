/** Native ACP permission bridge through DSH's user-question surface. */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type * as acp from '@agentclientprotocol/sdk'
import type { AcpNativeUserQuestionService } from './elicitation.ts'
import {
  ACP_PERMISSION_AUDIT_KIND,
  createPermissionAskedAudit,
  createPermissionDecidedAudit,
  redactSecretText,
  summarizeRawInputForAudit,
  type AcpPermissionAuditData,
} from './events.ts'

export type { AcpApprovalOutcome } from './events.ts'
export const ACP_PERMISSION_OPTIONS_MAX = 128
export const ACP_PERMISSION_ID_MAX_BYTES = 512

export interface AcpPermissionAuditRecord {
  readonly kind: typeof ACP_PERMISSION_AUDIT_KIND
  readonly time: number
  readonly data: AcpPermissionAuditData
}
export interface AcpPermissionAuditChannel { append(record: AcpPermissionAuditRecord): Promise<void> }
export interface AcpNativeApprovalService {
  request(req: { readonly agent: unknown; readonly toolName: string; readonly reason?: string; readonly signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}
export interface AcpNativePermissionBridgeDeps {
  readonly userQuestions?: AcpNativeUserQuestionService
  readonly approval?: AcpNativeApprovalService
  readonly getAgent: () => unknown
  readonly log?: (message: string) => void
  readonly audit?: AcpPermissionAuditChannel
  readonly now?: () => number
}

function cancelled(): acp.RequestPermissionResponse { return { outcome: { outcome: 'cancelled' } } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function assertBounds(toolCallId: string, options: readonly acp.PermissionOption[]): void {
  if (Buffer.byteLength(toolCallId, 'utf8') > ACP_PERMISSION_ID_MAX_BYTES) throw new Error('toolCallId exceeds ACP permission identity limit')
  if (options.length > ACP_PERMISSION_OPTIONS_MAX) throw new Error('ACP permission option count exceeds limit')
  const ids = new Set<string>()
  for (const option of options) {
    if (option.optionId.length === 0 || ids.has(option.optionId)) throw new Error('ACP permission optionId is empty or duplicated')
    if (Buffer.byteLength(option.optionId, 'utf8') > ACP_PERMISSION_ID_MAX_BYTES) throw new Error('optionId exceeds ACP permission identity limit')
    ids.add(option.optionId)
  }
}
function safeText(value: string, max = 180): string {
  const clean = redactSecretText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
/**
 * Keep the operation the user is approving complete while preventing control
 * characters (notably terminal escape sequences) from acting on the native
 * question surface. Unlike audit summaries, approval text must not redact or
 * truncate command arguments: doing either would make the displayed operation
 * differ from the one the Agent asked to execute.
 */
function visibleCommand(value: string): string {
  return value.replace(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.charCodeAt(0)
    return `\\x${code.toString(16).padStart(2, '0')}`
  })
}
function commandOf(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  if (typeof tool.rawInput === 'string') return tool.rawInput
  return firstString(recordValue(tool.rawInput), ['command', 'cmd', 'argv'])
}
function markdownCodeBlock(value: string): string {
  let longestFence = 0
  for (const match of value.matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length)
  const fence = '`'.repeat(Math.max(3, longestFence + 1))
  return `${fence}\n${value}\n${fence}`
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    if (/(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i.test(key)) continue
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}
function permissionDetail(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  const record = recordValue(tool.rawInput)
  if (tool.kind === 'execute') {
    const command = commandOf(tool)
    return command === undefined ? undefined : `Command: ${visibleCommand(command)}`
  }
  if (tool.kind === 'read' || tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move') {
    const path = firstString(record, ['file_path', 'filePath', 'path', 'target', 'source', 'destination']) ?? tool.locations?.find((location) => typeof location.path === 'string')?.path
    return path === undefined ? undefined : `Target: ${safeText(path, 160)}`
  }
  if (tool.rawInput === undefined) return undefined
  const summary = summarizeRawInputForAudit(tool.rawInput).summary
  return summary === '{}' ? undefined : `Details: ${safeText(summary)}`
}
function permissionQuestionDetail(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  if (tool.kind !== 'execute') return undefined
  const command = commandOf(tool)
  return command === undefined ? undefined : `Command:\n\n${markdownCodeBlock(visibleCommand(command))}`
}
export interface AcpPermissionReasonOptions { readonly includeExecuteDetails?: boolean }
export function buildPermissionReason(params: acp.RequestPermissionRequest, options: AcpPermissionReasonOptions = {}): string {
  const labels: Record<string, string> = { execute: 'run a command', edit: 'edit files', delete: 'delete files', move: 'move files', read: 'read restricted content', fetch: 'access a restricted external resource' }
  const kind = params.toolCall.kind ?? ''
  const lines = [`The ACP Agent requests permission to ${labels[kind] ?? 'perform a restricted operation'}.`]
  const title = params.toolCall.title ?? params.toolCall.name
  if (typeof title === 'string' && title.trim() !== '') lines.push(`Tool: ${safeText(title)}`)
  const detail = permissionDetail(params.toolCall)
  if (detail !== undefined && (kind !== 'execute' || options.includeExecuteDetails !== false)) lines.push(detail)
  return lines.join('\n')
}
function requestId(): string { return `dsh-acp-permission-${randomUUID()}` }

/** Render names as user-facing text while keeping the response map exact. */
function optionLabels(options: readonly acp.PermissionOption[]): readonly string[] {
  const names = options.map((option) => safeText(option.name, 120) || 'Agent option')
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const seen = new Map<string, number>()
  return names.map((name) => {
    if (counts.get(name) === 1) return name
    const ordinal = (seen.get(name) ?? 0) + 1
    seen.set(name, ordinal)
    return `${name} · option ${String(ordinal)}`
  })
}

export function createAcpNativePermissionHandler(deps: AcpNativePermissionBridgeDeps): (params: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse> {
  return async (params, signal) => {
    const id = requestId()
    try { assertBounds(params.toolCall.toolCallId, params.options) } catch (error: unknown) { deps.log?.(`dsh-acp native permission rejected by bounds: ${errorMessage(error)}`); return cancelled() }
    const append = async (data: AcpPermissionAuditData): Promise<boolean> => {
      if (deps.audit === undefined) return true
      try { await deps.audit.append({ kind: ACP_PERMISSION_AUDIT_KIND, time: deps.now?.() ?? Date.now(), data }); return true }
      catch (error: unknown) { deps.log?.(`dsh-acp native permission audit failed: ${errorMessage(error)}`); return false }
    }
    if (!await append(createPermissionAskedAudit({ requestId: id, agentSessionId: params.sessionId, toolCall: params.toolCall, options: params.options }))) return cancelled()
    const decide = async (init: { readonly outcome: 'selected' | 'cancelled'; readonly optionId?: string; readonly selectedOptionKind?: acp.PermissionOption['kind']; readonly note?: string }, decisionVia: 'native-question' | 'native-approval' = 'native-question'): Promise<acp.RequestPermissionResponse> => {
      const ok = await append(createPermissionDecidedAudit({ requestId: id, agentSessionId: params.sessionId, toolCallId: params.toolCall.toolCallId, ...init, decisionVia }))
      if (!ok || init.outcome === 'cancelled') return cancelled()
      return { outcome: { outcome: 'selected', optionId: init.optionId! } }
    }
    if (signal !== undefined && signal.aborted) return decide({ outcome: 'cancelled', note: 'cancelled' })
    const agent = deps.getAgent()
    if (agent === undefined) return decide({ outcome: 'cancelled', note: 'agent-unavailable' })
    const allowOnce = params.options.find(option => option.kind === 'allow_once')
    const reject = params.options.find(option => option.kind === 'reject_once')
      ?? params.options.find(option => option.kind === 'reject_always')
    if (deps.approval !== undefined && allowOnce !== undefined) {
      try {
        const outcome = await deps.approval.request({
          agent,
          toolName: params.toolCall.name ?? params.toolCall.kind ?? 'ACP tool',
          reason: buildPermissionReason(params),
          ...(signal === undefined ? {} : { signal }),
        })
        if (outcome === 'allowed-once') return decide({ outcome: 'selected', optionId: allowOnce.optionId, selectedOptionKind: allowOnce.kind }, 'native-approval')
        if (outcome === 'rejected' && reject !== undefined) return decide({ outcome: 'selected', optionId: reject.optionId, selectedOptionKind: reject.kind }, 'native-approval')
        return decide({ outcome: 'cancelled', note: outcome }, 'native-approval')
      } catch (error: unknown) {
        deps.log?.(`dsh-acp native approval unavailable: ${errorMessage(error)}`)
        // Continue to the generic native question only when it is available;
        // this preserves uncommon ACP option vocabularies without reviving a
        // plugin-owned permission surface.
      }
    }
    if (deps.userQuestions === undefined) return decide({ outcome: 'cancelled', note: 'question-service-unavailable' })
    const questionId = `acp-permission:${id}`
    const renderedLabels = optionLabels(params.options)
    const labels = new Map(renderedLabels.map((label, index) => [label, params.options[index]!]))
    try {
      const detail = permissionQuestionDetail(params.toolCall)
      const answer = await deps.userQuestions.ask({
        agent,
        questions: [{
          id: questionId,
          // Keep the header compact and put the exact command in the native
          // card's scrollable Markdown detail area, which preserves line
          // breaks and does not require a second custom permission UI.
          question: buildPermissionReason(params, { includeExecuteDetails: false }),
          ...(detail === undefined ? {} : { detail }),
          options: renderedLabels.map((label) => ({ label })),
        }],
        ...(signal === undefined ? {} : { signal }),
      })
      if (signal !== undefined && signal.aborted) return decide({ outcome: 'cancelled', note: 'cancelled' })
      const selected = answer.answers.find((item) => item.id === questionId)
      if (selected === undefined || selected.custom !== undefined || selected.selected.length !== 1) return decide({ outcome: 'cancelled', note: selected?.custom === undefined ? 'cancelled' : 'custom-option-unsupported' })
      const option = labels.get(selected.selected[0]!)
      if (option === undefined) return decide({ outcome: 'cancelled', note: 'invalid-option-id' })
      return decide({ outcome: 'selected', optionId: option.optionId, selectedOptionKind: option.kind })
    } catch (error: unknown) { deps.log?.(`dsh-acp native permission question cancelled: ${errorMessage(error)}`); return decide({ outcome: 'cancelled', note: 'question-error' }) }
  }
}
