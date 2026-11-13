import type { PermissionOption } from '@agentclientprotocol/sdk'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'
import type { AcpPermissionAskedAuditData, AcpPermissionCheckAuditData } from '../../src/domain/policy/events.ts'

/** This single observed CLI's manual UI contract, never an Auto-policy identity rule. */
export function isKnownDevinManualTitleRequest(
  cliVersion: string,
  asked: AcpPermissionAskedAuditData,
  bridge: AcpPermissionCheckAuditData,
): boolean {
  const tool = bridge.toolName
  if (
    cliVersion !== '3000.12.43' ||
    tool === undefined ||
    !/^[a-z_]+$/.test(tool) ||
    bridge.reason !== 'approval-required' ||
    bridge.identitySource !== 'devin-title' ||
    bridge.structuredIdentityPresent !== false ||
    bridge.titleMatchesCurrentTool !== true ||
    asked.toolCall.title !== tool ||
    asked.optionCount !== 7 ||
    (asked.omittedOptionCount ?? 0) !== 0
  )
    return false
  const expected: readonly PermissionOption[] = [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
    {
      optionId: 'allow_session',
      kind: 'allow_always',
      name: `Yes, allow calling ${tool} on the dsh MCP server (this session)`,
    },
    { optionId: 'allow_always', kind: 'allow_always', name: `Yes, always allow calling ${tool} on the dsh MCP server` },
    {
      optionId: 'allow_server_session',
      kind: 'allow_always',
      name: 'Yes, allow calling all tools on the dsh MCP server (this session)',
    },
    {
      optionId: 'allow_server_always',
      kind: 'allow_always',
      name: 'Yes, always allow calling tools on the dsh MCP server',
    },
    { optionId: 'switch_bypass', kind: 'allow_always', name: 'Yes, switch to bypass mode' },
    { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
  ]
  return (
    asked.options.length === expected.length &&
    asked.options.every((option, index) => {
      const original = expected[index]!
      return option.optionId === original.optionId && option.kind === original.kind && option.name === original.name
    })
  )
}

interface Task {
  readonly id: string
  readonly subject: string
  readonly revision: number
  readonly status: string
  readonly ownerName?: string
  readonly ready: boolean
}

export interface DevinTeamScope {
  readonly role: 'lead' | 'member'
  readonly token: string
  readonly memberName: string
  readonly provider: string
  readonly model: string
  readonly tasks: readonly Task[]
  readonly childExists: boolean
  readonly messageSent: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 8_192
}
function keys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((key) => allowed.includes(key))
}
function empty(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}
function integer(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}

/** Require the exact original hash, using the native request's complete details when audit text was redacted. */
export function intactPermissionInput(summary: string | undefined, hash: string | undefined, detail?: string): unknown {
  if (summary === undefined || hash === undefined) throw new Error('LIVE_TEAM_PERMISSION_INPUT_MISSING')
  let input: unknown
  let summaryFailure = 'LIVE_TEAM_PERMISSION_INPUT_CHANGED'
  try {
    input = JSON.parse(summary)
  } catch {
    summaryFailure = 'LIVE_TEAM_PERMISSION_INPUT_TRUNCATED'
  }
  if (input !== undefined && summarizeRawInputForAudit(input).hash === hash) return input
  if (detail !== undefined) {
    // The native child presenter may prepend one source line. It is display-only:
    // the independently checked owner and original input hash still supply authority.
    // Parse exactly one complete block, never search prose or choose among multiple matches.
    const block = /^(?:(?:Source child session|来源子会话): [^\r\n]+\n\n)?(`{3,})\n([\s\S]*)\n\1$/.exec(detail)
    let envelope: Record<string, unknown> | undefined
    try {
      envelope = block === null ? undefined : record(JSON.parse(block[2]!))
    } catch {
      /* fail closed below */
    }
    if (envelope === undefined || !Object.hasOwn(envelope, 'rawInput') || !keys(envelope, ['rawInput', 'locations']))
      throw new Error('LIVE_TEAM_PERMISSION_DETAIL_INVALID')
    if (summarizeRawInputForAudit(envelope.rawInput).hash !== hash)
      throw new Error('LIVE_TEAM_PERMISSION_DETAIL_CHANGED')
    return envelope.rawInput
  }
  throw new Error(summaryFailure)
}

/** Select one original once option; ambiguous labels or identities must never fall back to a broader grant. */
export function exactOnceOption(options: readonly PermissionOption[]): PermissionOption {
  const once = options.filter((option) => option.kind === 'allow_once')
  if (
    once.length !== 1 ||
    new Set(options.map((option) => option.optionId)).size !== options.length ||
    new Set(options.map((option) => option.name)).size !== options.length ||
    options.some((option) => !text(option.name) || !text(option.optionId)) ||
    /\b(?:session|always|all tools|bypass)\b/i.test(once[0]?.name ?? '')
  )
    throw new Error('LIVE_TEAM_PERMISSION_ONCE_AMBIGUOUS')
  return once[0]!
}

/** Authorization for this synthetic two-task calculation only; not a product permission policy. */
export function permitsDevinTeamTool(tool: string, raw: unknown, scope: DevinTeamScope): boolean {
  const args = record(raw)
  if (args === undefined) return false
  const lead = scope.role === 'lead'
  const compute = scope.tasks.find((task) => task.subject === `Compute ${scope.token}`)
  const review = scope.tasks.find((task) => task.subject === `Review ${scope.token}`)
  const task = scope.tasks.find((task) => task.id === args.task_id)
  const ownedTask = lead ? review : compute
  switch (tool) {
    case 'team_task_create':
      return (
        lead &&
        keys(args, ['subject', 'description', 'blocked_by', 'write_scopes']) &&
        text(args.description) &&
        empty(args.write_scopes) &&
        ((args.subject === `Compute ${scope.token}` && compute === undefined && empty(args.blocked_by)) ||
          (args.subject === `Review ${scope.token}` &&
            review === undefined &&
            compute !== undefined &&
            Array.isArray(args.blocked_by) &&
            args.blocked_by.length === 1 &&
            args.blocked_by[0] === compute.id))
      )
    case 'subagent':
      return (
        lead &&
        !scope.childExists &&
        compute !== undefined &&
        keys(args, ['name', 'description', 'prompt', 'provider', 'model']) &&
        args.name === scope.memberName &&
        text(args.description) &&
        text(args.prompt) &&
        args.prompt.includes(scope.token) &&
        args.prompt.includes(compute.id) &&
        /1\s*\+\s*1/.test(args.prompt) &&
        (args.provider === undefined || args.provider === scope.provider) &&
        (args.model === undefined || args.model === scope.model)
      )
    case 'team_task_get':
      return keys(args, ['task_id']) && task !== undefined && (lead || task === compute)
    case 'team_task_update':
      return (
        keys(args, ['task_id', 'expected_revision', 'action']) &&
        task !== undefined &&
        task === ownedTask &&
        args.expected_revision === task.revision &&
        ((args.action === 'claim' && task.status === 'pending' && task.ownerName === undefined && task.ready) ||
          (args.action === 'complete' &&
            task.status === 'in_progress' &&
            task.ownerName === (lead ? 'lead' : scope.memberName)))
      )
    case 'team_task_list':
      return (
        keys(args, ['status', 'owner', 'unowned', 'ready', 'cursor', 'limit']) &&
        (args.status === undefined || ['pending', 'in_progress', 'completed'].includes(String(args.status))) &&
        (args.owner === undefined || ['lead', scope.memberName].includes(String(args.owner))) &&
        (args.unowned === undefined || typeof args.unowned === 'boolean') &&
        (args.owner === undefined || args.unowned === undefined) &&
        (args.ready === undefined || typeof args.ready === 'boolean') &&
        (args.cursor === undefined || integer(args.cursor, 0, 100)) &&
        (args.limit === undefined || integer(args.limit, 1, 100))
      )
    case 'send_message':
      return (
        !lead &&
        !scope.messageSent &&
        keys(args, ['agent', 'message']) &&
        args.agent === 'lead' &&
        text(args.message) &&
        args.message.includes(scope.token) &&
        /\b2\b/.test(args.message) &&
        compute?.status === 'completed' &&
        compute.ownerName === scope.memberName
      )
    case 'list_agents':
      return Object.keys(args).length === 0
    case 'wait_agent':
      return (
        lead &&
        keys(args, ['timeout_ms']) &&
        (args.timeout_ms === undefined || integer(args.timeout_ms, 10_000, 60_000))
      )
    default:
      return false
  }
}
