import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const ACP_OPERATIONS = new Set([
  'initialize', 'session/new', 'session/load', 'session/resume', 'session/list',
  'session/set_config_option', 'session/set_mode', 'session/fork', 'session/prompt',
])
const TOOL_ERROR_CODES = new Set([
  'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'UNKNOWN_TOOL', 'INVALID_TOOL_OUTPUT', 'INVALID_ARGS', 'UNSUPPORTED_SCHEMA',
  'ACP_ABORTED', 'ACP_AUTH_REQUIRED', 'ACP_CRASH', 'ACP_PROTOCOL_ERROR', 'ACP_SPAWN_FAILURE', 'ACP_TIMEOUT',
  'TEAM_DISPOSED', 'TEAM_INVALID_ARGUMENT', 'TEAM_INVALID_CONFIG', 'TEAM_INVALID_MEMBER_NAME', 'TEAM_INVALID_TARGET',
  'TEAM_LEAD_REQUIRED', 'TEAM_MAILBOX_FULL', 'TEAM_MEMBER_LIMIT', 'TEAM_MEMBER_NAME_TAKEN', 'TEAM_MEMBER_NOT_FOUND',
  'TEAM_MESSAGE_TOO_LARGE', 'TEAM_NOT_MEMBER', 'TEAM_PROVISIONING_CONFLICT', 'TEAM_SELF_MESSAGE', 'TEAM_WAIT_ABORTED',
])

export interface SafeLiveDiagnostic {
  readonly code?: string
  readonly toolCode?: string
  readonly operation?: string
  readonly jsonRpcCode?: number
}

/** Extract only fixed protocol facts from a turn failure; never forward its text.
 * @param error - Structured failure fields from the host.
 * @returns Allowlisted error codes and protocol facts.
 */
export function safeLiveDiagnostic(error: { readonly code?: unknown; readonly info?: { readonly code?: unknown }; readonly message?: unknown }): SafeLiveDiagnostic {
  const message = typeof error.message === 'string' ? error.message : ''
  const rpcOperation = 'initialize|session\/(?:new|load|resume|list|set_config_option|set_mode|fork|prompt)'
  const operationMatch = new RegExp(`(?:rejected (${rpcOperation})(?::| \\()|ACP (${rpcOperation}) failed:)`).exec(message)
  const operationText = operationMatch?.[1] ?? operationMatch?.[2]
  const jsonRpcText = /JSON-RPC code (-?\d+)(?![\d.])/.exec(message)?.[1]
  const jsonRpcCode = jsonRpcText === undefined ? undefined : Number(jsonRpcText)
  return {
    ...(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? { code: error.code } : {}),
    ...(typeof error.info?.code === 'string' ? { toolCode: TOOL_ERROR_CODES.has(error.info.code) ? error.info.code : 'other' } : {}),
    ...(operationText !== undefined && ACP_OPERATIONS.has(operationText) ? { operation: operationText } : {}),
    ...(jsonRpcCode !== undefined && Number.isSafeInteger(jsonRpcCode) ? { jsonRpcCode } : {}),
  }
}

export interface SafeSpawnDiagnostic {
  readonly promptPresent: boolean
  readonly hasExpectedMarker: boolean
  readonly requestsSendMessage: boolean
  readonly context: 'default' | 'fresh' | 'other'
}

/** Keep only booleans and an enum from a teammate request; never return its arguments.
 * @param args - Parsed spawn tool arguments.
 * @param expectedMarker - Marker expected in the lead's teammate request.
 * @returns Safe presence checks and the normalized context value.
 */
export function safeSpawnDiagnostic(args: unknown, expectedMarker: string | undefined): SafeSpawnDiagnostic {
  const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined
  const context = input.context === undefined ? 'default' : input.context === 'fresh' ? 'fresh' : 'other'
  return {
    promptPresent: prompt !== undefined,
    hasExpectedMarker: prompt !== undefined && expectedMarker !== undefined && prompt.includes(expectedMarker),
    requestsSendMessage: prompt?.includes('send_message') === true,
    context,
  }
}

const TOOL_NAMES = new Set(['spawn_teammate', 'send_message', 'list_agents'])
const TOOL_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'other'] as const
type ToolStatus = typeof TOOL_STATUSES[number]
type ToolName = 'spawn_teammate' | 'send_message' | 'list_agents' | 'other'

export interface LiveActivitySummary {
  readonly available: boolean
  readonly activityRows: number
  readonly truncated: boolean
  readonly toolStatuses: Readonly<Record<ToolStatus, number>>
  readonly toolNames: Readonly<Record<ToolName, number>>
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>
}

function activityToolName(presentation: unknown, rawDetail: unknown): ToolName {
  let name: unknown
  if (typeof rawDetail === 'string') {
    try {
      const detail: unknown = JSON.parse(rawDetail)
      if (typeof detail === 'object' && detail !== null) name = (detail as Record<string, unknown>).toolName
    } catch { return 'other' /* Unrecognized detail must not trust its display title. */ }
    if (typeof name !== 'string') return 'other'
  } else name = presentation
  return typeof name === 'string' && TOOL_NAMES.has(name) ? name as ToolName : 'other'
}

/** Read bounded, test-owned activity facts without exposing titles or tool arguments.
 * @param databasePath - Temporary profile's sidecar database path.
 * @param sessionId - Session ID created by this test run.
 * @returns Aggregated activity counts for at most 64 rows, with availability and truncation status.
 */
export function readLiveActivitySummary(databasePath: string, sessionId: string): LiveActivitySummary {
  const toolStatuses = emptyCounts(TOOL_STATUSES)
  const toolNames = emptyCounts(['spawn_teammate', 'send_message', 'list_agents', 'other'] as const)
  let activityRows = 0
  let truncated = false
  if (!existsSync(databasePath)) {
    return { available: false, activityRows, truncated, toolStatuses, toolNames }
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(databasePath, { readOnly: true })
    const rows = database.prepare('SELECT kind, status, presentation, raw_detail FROM activity_journal WHERE dsh_session_id = ? ORDER BY revision_seq LIMIT 65')
      .all(sessionId) as Array<{ kind?: unknown; status?: unknown; presentation?: unknown; raw_detail?: unknown }>
    const accepted = rows.slice(0, 64)
    activityRows = accepted.length
    for (const row of accepted) {
      if (row.kind !== 'tool') continue
      const status = TOOL_STATUSES.includes(row.status as ToolStatus) ? row.status as ToolStatus : 'other'
      toolStatuses[status] += 1
      toolNames[activityToolName(row.presentation, row.raw_detail)] += 1
    }
    truncated = rows.length > 64
    return { available: true, activityRows, truncated, toolStatuses, toolNames }
  } catch {
    return { available: false, activityRows, truncated, toolStatuses, toolNames }
  } finally {
    try { database?.close() } catch (error) { void error /* Diagnostic cleanup cannot replace the test result. */ }
  }
}
