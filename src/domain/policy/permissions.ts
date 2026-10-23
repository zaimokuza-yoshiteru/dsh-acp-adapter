/** Native ACP permission bridge through DSH's user-question surface. */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type * as acp from '@agentclientprotocol/sdk'
import { isAntigravityInteractionCall } from './antigravity-question.ts'
import type {
  AcpNativeQuestionUnavailable,
  AcpNativeUserQuestionService,
  AcpPermissionQuestionService,
} from './elicitation.ts'
import { permissionCopy, type PermissionCopy } from './permission-copy.ts'
import {
  ACP_PERMISSION_AUDIT_KIND,
  createPermissionAskedAudit,
  createPermissionDecidedAudit,
  redactSecretText,
  type AcpPermissionAuditData,
  type AcpPermissionPresentation,
} from './events.ts'

export type { AcpApprovalOutcome } from './events.ts'
export const ACP_PERMISSION_OPTIONS_MAX = 128
export const ACP_PERMISSION_ID_MAX_BYTES = 512

const dshTeamPresentation = Symbol('dsh-team-permission-presentation')
interface DshTeamPermissionPresentation {
  readonly tool: 'spawn_teammate' | 'send_message'
  readonly workspace?: string
}

/**
 * Only the live DSH bridge may attach this presentation hint after resolving
 * its own tool definition. Wire metadata and cached display names cannot forge
 * the symbol. It grants no authority and is deliberately absent from JSON.
 */
export function withDshTeamPermissionPresentation<T extends acp.ToolCallUpdate>(
  call: T,
  presentation: DshTeamPermissionPresentation,
): T {
  return Object.defineProperty({ ...call }, dshTeamPresentation, { value: Object.freeze({ ...presentation }) })
}

export interface AcpPermissionAuditRecord {
  readonly kind: typeof ACP_PERMISSION_AUDIT_KIND
  readonly time: number
  readonly data: AcpPermissionAuditData
}
export interface AcpPermissionAuditChannel {
  append(record: AcpPermissionAuditRecord): Promise<void>
}
export type AcpNativeQuestionProfile = 'antigravity'
export interface AcpNativeApprovalService {
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly signal?: AbortSignal
    /** Tool input at the approval boundary, after runtime normalization; absent when not supplied here. */
    readonly toolArgs?: unknown
    /** Recognized string command from execute input at this boundary; absent for other or unrecognized inputs. */
    readonly commandLine?: string
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}
export interface AcpNativePermissionBridgeDeps {
  readonly userQuestions?: AcpNativeUserQuestionService
  /** External permission-only presentation; ordinary interaction calls keep their native owner. */
  readonly permissionQuestions?: AcpPermissionQuestionService
  readonly approval?: AcpNativeApprovalService
  readonly nativeQuestionProfile?: AcpNativeQuestionProfile
  readonly getAgent: () => unknown
  readonly locale?: string
  readonly log?: (message: string) => void
  readonly onUnavailable?: (issue: AcpNativeQuestionUnavailable) => void | Promise<void>
  readonly audit?: AcpPermissionAuditChannel
  readonly now?: () => number
}

function cancelled(): acp.RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function assertBounds(toolCallId: string, options: readonly acp.PermissionOption[]): void {
  if (Buffer.byteLength(toolCallId, 'utf8') > ACP_PERMISSION_ID_MAX_BYTES)
    throw new Error('toolCallId exceeds ACP permission identity limit')
  if (options.length > ACP_PERMISSION_OPTIONS_MAX) throw new Error('ACP permission option count exceeds limit')
  const ids = new Set<string>()
  for (const option of options) {
    if (option.optionId.length === 0 || ids.has(option.optionId))
      throw new Error('ACP permission optionId is empty or duplicated')
    if (Buffer.byteLength(option.optionId, 'utf8') > ACP_PERMISSION_ID_MAX_BYTES)
      throw new Error('optionId exceeds ACP permission identity limit')
    ids.add(option.optionId)
  }
}
function safeText(value: string, max = 180): string {
  const clean = redactSecretText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
const commandKeys = ['command', 'cmd', 'CommandLine', 'argv'] as const
function commandOf(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  if (typeof tool.rawInput === 'string') return tool.rawInput
  return firstString(recordValue(tool.rawInput), commandKeys)
}
function markdownCodeBlock(value: string): string {
  let longestFence = 0
  for (const match of value.matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length)
  const fence = '`'.repeat(Math.max(3, longestFence + 1))
  return `${fence}\n${value}\n${fence}`
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
/** Keep both input and target facts; neither is a replacement for the other. */
function permissionInputDetail(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  let input = tool.rawInput
  const command = tool.kind === 'execute' ? commandOf(tool) : undefined
  if (command !== undefined) {
    const record = recordValue(input)
    if (record === undefined)
      input = undefined // The string command is displayed separately.
    else {
      const commandKey = commandKeys.find((key) => record[key] === command)
      const remaining = Object.fromEntries(Object.entries(record).filter(([key]) => key !== commandKey))
      input = Object.keys(remaining).length === 0 ? undefined : remaining
    }
  }
  const details =
    tool.locations === undefined
      ? input
      : input === undefined
        ? tool.locations
        : { rawInput: input, locations: tool.locations }
  if (details === undefined) return undefined
  return visibleCommand(typeof details === 'string' ? details : JSON.stringify(details, null, 2))
}
function permissionQuestionDetail(
  tool: acp.RequestPermissionRequest['toolCall'],
  copy: PermissionCopy,
): string | undefined {
  const parts: string[] = []
  if (tool.kind === 'execute') {
    const command = commandOf(tool)
    parts.push(
      command === undefined ? copy.unknownCommand : `${copy.command}:\n\n${markdownCodeBlock(visibleCommand(command))}`,
    )
  }
  const detail = permissionInputDetail(tool)
  if (detail !== undefined) parts.push(`${copy.details}:\n\n${markdownCodeBlock(detail)}`)
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
/** Native approval owns localized chrome. Only Agent-supplied operation facts cross to its reason field. */
function nativePermissionReason(tool: acp.RequestPermissionRequest['toolCall'], copy: PermissionCopy): string {
  const title = tool.title ?? tool.name ?? tool.kind ?? 'ACP'
  const command = tool.kind === 'execute' ? commandOf(tool) : undefined
  const displayTitle = command !== undefined && title === command ? undefined : safeText(title)
  const input = recordValue(tool.rawInput)
  const description = tool.kind === 'execute' && typeof input?.description === 'string' ? input.description : undefined
  // Execute descriptions are prose, while unknown fields remain complete input
  // evidence. Keep the original payload unchanged for questions and audit.
  const detailTool =
    description === undefined
      ? tool
      : { ...tool, rawInput: Object.fromEntries(Object.entries(input!).filter(([key]) => key !== 'description')) }
  return [
    displayTitle,
    description === undefined ? undefined : visibleCommand(description),
    command === undefined ? undefined : visibleCommand(command),
    permissionInputDetail(detailTool),
    tool.kind === 'execute' && command === undefined ? copy.unknownCommand : undefined,
  ]
    .filter((value) => value !== undefined)
    .join('\n')
}
/** Keep targets and unknown scope visible; verified Team task prose stays in raw-request details. */
function permissionQuestionFacts(tool: acp.RequestPermissionRequest['toolCall'], copy: PermissionCopy): string {
  const command = tool.kind === 'execute' ? commandOf(tool) : undefined
  const title = tool.title ?? tool.name
  const lines: string[] = []
  if (typeof title === 'string' && title.trim() !== '' && title !== command) lines.push(visibleCommand(title))
  else if (command === undefined) lines.push(copy.actions[tool.kind ?? ''] ?? copy.restrictedOperation)
  if (tool.kind === 'execute') {
    lines.push(command === undefined ? copy.unknownCommand : `${copy.command}: ${visibleCommand(command)}`)
  }

  let input = tool.rawInput
  const record = recordValue(input)
  if (record !== undefined) {
    const team = (tool as { readonly [dshTeamPresentation]?: DshTeamPermissionPresentation })[dshTeamPresentation]
    const presented = new Set<string>()
    if (tool.kind === 'execute' && typeof record.description === 'string') {
      lines.push(visibleCommand(record.description))
      presented.add('description')
    }
    const field = (key: string, label: string): boolean => {
      const value = record[key]
      if (typeof value !== 'string' || value.trim() === '') return false
      lines.push(`${label}: ${visibleCommand(value)}`)
      presented.add(key)
      return true
    }
    if (team?.tool === 'spawn_teammate' && field('name', copy.member)) {
      field('description', copy.responsibility)
      if (!field('context', copy.context) && record.context === undefined) lines.push(`${copy.context}: fresh`)
      field('provider', copy.provider)
      field('model', copy.model)
      field('agent', copy.agent)
      if (team.workspace !== undefined) lines.push(`${copy.workspace}: ${visibleCommand(team.workspace)}`)
      if (typeof record.prompt === 'string') presented.add('prompt')
    } else if (team?.tool === 'send_message' && field('target', copy.recipient)) {
      if (typeof record.message === 'string') presented.add('message')
    }
    const commandKey = command === undefined ? undefined : commandKeys.find((key) => record[key] === command)
    const directory = typeof record.cwd === 'string' ? record.cwd : undefined
    if (directory !== undefined) lines.push(`${copy.directory}: ${visibleCommand(directory)}`)
    const fileContent = typeof record.file_path === 'string' && typeof record.content === 'string'
    if (fileContent) {
      lines.push(`${copy.filePath}: ${visibleCommand(record.file_path as string)}`)
      lines.push(`${copy.content}: ${visibleCommand(record.content as string)}`)
    }
    const remaining = Object.fromEntries(
      Object.entries(record).filter(
        ([key]) =>
          key !== commandKey &&
          !presented.has(key) &&
          !(key === 'cwd' && directory !== undefined) &&
          !(fileContent && (key === 'file_path' || key === 'content')),
      ),
    )
    input = Object.keys(remaining).length === 0 ? undefined : remaining
  } else if (command !== undefined) {
    input = undefined
  }
  if (tool.locations != null && tool.locations.length > 0) {
    lines.push(
      `${copy.locations}: ${tool.locations
        .map((location) => visibleCommand(`${location.path}${location.line == null ? '' : `:${location.line}`}`))
        .join('\n')}`,
    )
  }
  // Unknown input can itself be the requested scope (for example Codex's
  // additional sandbox permissions). Never move it exclusively into a disclosure.
  if (input !== undefined)
    lines.push(`${copy.input}: ${visibleCommand(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}`)
  return lines.join('\n')
}

function permissionRequestDetail(tool: acp.RequestPermissionRequest['toolCall']): string | undefined {
  if (tool.rawInput === undefined && tool.locations === undefined) return undefined
  return markdownCodeBlock(
    visibleCommand(JSON.stringify({ rawInput: tool.rawInput, locations: tool.locations }, null, 2)),
  )
}
function requestId(): string {
  return `dsh-acp-permission-${randomUUID()}`
}

/** Render names as user-facing text while keeping the response map exact. */
function optionLabels(options: readonly acp.PermissionOption[], copy: PermissionCopy): readonly string[] {
  // Option names can specify different authority at their end. Keep the complete
  // choice; audit redaction and display truncation must not erase that scope.
  const names = options.map((option) => visibleCommand(option.name).trim() || copy.agentOption)
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = names.map((name) => {
    if (counts.get(name) === 1) return name
    const ordinal = (seen.get(name) ?? 0) + 1
    seen.set(name, ordinal)
    return `${name} · ${copy.option(ordinal)}`
  })
  // An Agent name can equal another option's generated disambiguator. Prefix
  // the complete set on collision so every response still maps to one option.
  return new Set(labels).size === labels.length ? labels : labels.map((label, index) => `${index + 1}. ${label}`)
}

/** The native binary card must not discard an offered decision or authorization scope. */
function binaryApprovalOptions(options: readonly acp.PermissionOption[]):
  | {
      allow: acp.PermissionOption
      reject?: acp.PermissionOption
    }
  | undefined {
  const allows = options.filter((option) => option.kind === 'allow_once')
  const rejects = options.filter((option) => option.kind === 'reject_once')
  if (allows.length !== 1 || rejects.length > 1 || options.length !== allows.length + rejects.length) return undefined
  const names = options.map((option) => visibleCommand(option.name).trim())
  if (names.some((name) => name === '') || new Set(names).size !== names.length) return undefined
  return { allow: allows[0]!, ...(rejects[0] === undefined ? {} : { reject: rejects[0] }) }
}

export function createAcpNativePermissionHandler(
  deps: AcpNativePermissionBridgeDeps,
): (params: acp.RequestPermissionRequest, signal?: AbortSignal) => Promise<acp.RequestPermissionResponse> {
  const copy = permissionCopy(deps.locale)
  return async (params, signal) => {
    const id = requestId()
    try {
      assertBounds(params.toolCall.toolCallId, params.options)
    } catch (error: unknown) {
      deps.log?.(`dsh-acp native permission rejected by bounds: ${errorMessage(error)}`)
      return cancelled()
    }
    const append = async (data: AcpPermissionAuditData): Promise<boolean> => {
      if (deps.audit === undefined) return true
      try {
        await deps.audit.append({ kind: ACP_PERMISSION_AUDIT_KIND, time: deps.now?.() ?? Date.now(), data })
        return true
      } catch (error: unknown) {
        deps.log?.(`dsh-acp native permission audit failed: ${errorMessage(error)}`)
        return false
      }
    }
    if (
      !(await append(
        createPermissionAskedAudit({
          requestId: id,
          agentSessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        }),
      ))
    )
      return cancelled()
    let presentation: AcpPermissionPresentation | undefined
    const decide = async (
      init: {
        readonly outcome: 'selected' | 'cancelled'
        readonly optionId?: string
        readonly selectedOptionKind?: acp.PermissionOption['kind']
        readonly note?: string
      },
      decisionVia: 'native-question' | 'native-approval' = 'native-question',
    ): Promise<acp.RequestPermissionResponse> => {
      const ok = await append(
        createPermissionDecidedAudit({
          requestId: id,
          agentSessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          ...init,
          decisionVia,
          ...(presentation === undefined ? {} : { presentation }),
        }),
      )
      if (!ok || init.outcome === 'cancelled') return cancelled()
      return { outcome: { outcome: 'selected', optionId: init.optionId! } }
    }
    if (signal !== undefined && signal.aborted) return decide({ outcome: 'cancelled', note: 'cancelled' })
    const agent = deps.getAgent()
    if (agent === undefined) return decide({ outcome: 'cancelled', note: 'agent-unavailable' })
    const binary = binaryApprovalOptions(params.options)
    const nativeInteractionCall =
      deps.nativeQuestionProfile === 'antigravity' && isAntigravityInteractionCall(params.toolCall)
    const nativeInteractionQuestion =
      nativeInteractionCall &&
      params.options.length > 0 &&
      params.options.every((option) => option.kind === 'allow_once')

    if (!nativeInteractionQuestion && deps.approval !== undefined && binary !== undefined) {
      try {
        const commandLine = params.toolCall.kind === 'execute' ? commandOf(params.toolCall) : undefined
        const outcome = await deps.approval.request({
          agent,
          toolName: params.toolCall.name ?? params.toolCall.kind ?? copy.acpTool,
          callId: params.toolCall.toolCallId,
          ...(params.toolCall.rawInput === undefined ? {} : { toolArgs: params.toolCall.rawInput }),
          ...(commandLine === undefined ? {} : { commandLine }),
          reason: [
            nativePermissionReason(params.toolCall, copy),
            `${copy.allowOnce}: ${visibleCommand(binary.allow.name)}`,
            ...(binary.reject === undefined ? [] : [`${copy.rejectOnce}: ${visibleCommand(binary.reject.name)}`]),
          ].join('\n'),
          ...(signal === undefined ? {} : { signal }),
        })
        if (outcome === 'allowed-once')
          return decide(
            { outcome: 'selected', optionId: binary.allow.optionId, selectedOptionKind: binary.allow.kind },
            'native-approval',
          )
        if (outcome === 'rejected' && binary.reject !== undefined)
          return decide(
            { outcome: 'selected', optionId: binary.reject.optionId, selectedOptionKind: binary.reject.kind },
            'native-approval',
          )
        return decide({ outcome: 'cancelled', note: outcome }, 'native-approval')
      } catch (error: unknown) {
        deps.log?.(`dsh-acp native approval unavailable: ${errorMessage(error)}`)
        // Continue to the generic native question only when it is available;
        // this preserves uncommon ACP option vocabularies without reviving a
        // plugin-owned permission surface.
      }
    }
    if (nativeInteractionCall && !nativeInteractionQuestion && binary !== undefined)
      return decide({ outcome: 'cancelled', note: 'native-approval-unavailable' }, 'native-approval')
    const questions = nativeInteractionCall ? deps.userQuestions : (deps.permissionQuestions ?? deps.userQuestions)
    if (questions === undefined) return decide({ outcome: 'cancelled', note: 'question-service-unavailable' })
    const questionId = `acp-permission:${id}`
    const renderedLabels = optionLabels(params.options, copy)
    const labels = new Map(renderedLabels.map((label, index) => [label, params.options[index]!]))
    try {
      const detail = nativeInteractionQuestion
        ? permissionQuestionDetail(params.toolCall, copy)
        : permissionRequestDetail(params.toolCall)
      const questionRequest = {
        agent,
        questions: [
          {
            id: questionId,
            question: nativeInteractionQuestion
              ? params.toolCall.title!
              : permissionQuestionFacts(params.toolCall, copy),
            ...(nativeInteractionQuestion ? {} : { header: copy.permission }),
            ...(detail === undefined ? {} : { detail }),
            options: renderedLabels.map((label) => ({ label })),
          },
        ],
        ...(signal === undefined ? {} : { signal }),
      }
      const answer =
        questions === deps.permissionQuestions
          ? await deps.permissionQuestions.ask(questionRequest, (value) => {
              presentation = value
            })
          : await questions.ask(questionRequest)
      if (signal !== undefined && signal.aborted) return decide({ outcome: 'cancelled', note: 'cancelled' })
      const selected = answer.answers.find((item) => item.id === questionId)
      if (selected === undefined || selected.custom !== undefined || selected.selected.length !== 1)
        return decide({
          outcome: 'cancelled',
          note: selected?.custom === undefined ? 'cancelled' : 'custom-option-unsupported',
        })
      const option = labels.get(selected.selected[0]!)
      if (option === undefined) return decide({ outcome: 'cancelled', note: 'invalid-option-id' })
      return decide({ outcome: 'selected', optionId: option.optionId, selectedOptionKind: option.kind })
    } catch (error: unknown) {
      if (signal?.aborted) return decide({ outcome: 'cancelled', note: 'cancelled' })
      if (recordValue(error)?.code === 'DELEGATED_CALLER') {
        try {
          await deps.onUnavailable?.({
            code: 'ACP_DELEGATED_QUESTION_UNAVAILABLE',
            message: nativeInteractionQuestion
              ? copy.delegatedQuestionUnavailable
              : copy.delegatedPermissionUnavailable,
          })
        } catch (reportError: unknown) {
          deps.log?.(`dsh-acp unavailable permission reporting failed: ${errorMessage(reportError)}`)
        }
        return decide({ outcome: 'cancelled', note: 'delegated-question-unavailable' })
      }
      deps.log?.(`dsh-acp native permission question cancelled: ${errorMessage(error)}`)
      return decide({ outcome: 'cancelled', note: 'question-error' })
    }
  }
}
