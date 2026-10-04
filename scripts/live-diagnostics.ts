const ACP_OPERATIONS = new Set([
  'initialize',
  'session/new',
  'session/load',
  'session/resume',
  'session/list',
  'session/set_config_option',
  'session/set_mode',
  'session/fork',
  'session/prompt',
])

// Keep diagnostics to stable codes defined by ACP, the adapter's Team bridge,
// Agent Teams, or the shared tool runner. Never forward arbitrary error codes.
const LIVE_DIAGNOSTIC_CODES = new Set([
  'ACP_ABORTED',
  'ACP_AUTH_REQUIRED',
  'ACP_BINDING_PERSIST_FAILED',
  'ACP_CRASH',
  'ACP_CONFIG_CHANGE_DURING_PROMPT',
  'ACP_PROTOCOL_ERROR',
  'ACP_RESOURCE_EXHAUSTED',
  'ACP_SPAWN_FAILURE',
  'ACP_TIMEOUT',
  'ACP_AUXILIARY_CALL',
  'ACP_BINDING_UNAVAILABLE',
  'ACP_CONFIG_SYNC_FAILED',
  'ACP_CONFIG_UNSUPPORTED',
  'ACP_INPUT_NOT_SUPPORTED',
  'ACP_PROMPT_ALREADY_ACTIVE',
  'ACP_RETRY_FAILED',
  'ACP_STEERING_OUTCOME_UNKNOWN',
  'ACP_SESSION_CWD_UNAVAILABLE',
  'ACP_SESSION_NOT_FOUND',
  'ACP_SESSION_OPTIONS_READ_ONLY',
  'ACP_SESSION_OPTIONS_UNAVAILABLE',
  'ACP_SESSION_UNAVAILABLE',
  'ACP_STEERING_FAILED',
  'ACP_UNKNOWN_PROFILE',
  'ACP_TEAM_LEAD_REQUIRED',
  'ACP_TEAM_LEAD_UNAVAILABLE',
  'ACP_TEAM_LISTEN_FAILED',
  'ACP_TEAM_MEMBER_BUSY',
  'ACP_TEAM_MEMBER_REQUIRED',
  'ACP_TEAM_MODELS_UNAVAILABLE',
  'ACP_TEAM_MODEL_READ_ONLY_OR_UNAVAILABLE',
  'ACP_TEAM_PROMPT_INACTIVE',
  'ACP_TEAM_FORK_UNSUPPORTED',
  'ACP_TEAM_ROUTE_OVERRIDE_UNSUPPORTED',
  'ACP_TEAM_TOOL_FAILED',
  'ACP_TEAM_TOOL_UNAVAILABLE',
  'ACP_NO_VISIBLE_RESPONSE',
  'TEAM_DISPOSED',
  'TEAM_INVALID_ARGUMENT',
  'TEAM_INVALID_CONFIG',
  'TEAM_INVALID_MEMBER_NAME',
  'TEAM_INVALID_TARGET',
  'TEAM_INVALID_TIMEOUT',
  'TEAM_LEAD_REQUIRED',
  'TEAM_MAILBOX_FULL',
  'TEAM_MEMBER_LIMIT',
  'TEAM_MEMBER_NAME_TAKEN',
  'TEAM_MEMBER_NOT_FOUND',
  'TEAM_MESSAGE_TOO_LARGE',
  'TEAM_NOT_MEMBER',
  'TEAM_PROVISIONING_CONFLICT',
  'TEAM_SELF_MESSAGE',
  'INVALID_ARGS',
  'UNKNOWN_TOOL',
  'INVALID_TOOL_OUTPUT',
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
  'TOOL_TIMEOUT',
])

export interface SafeLiveDiagnostic {
  readonly code?: string
  readonly operation?: string
  readonly jsonRpcCode?: number
}

/** Extract only fixed protocol facts from a turn failure; never forward its text. */
export function safeLiveDiagnostic(error: {
  readonly code?: unknown
  readonly message?: unknown
  readonly info?: unknown
}): SafeLiveDiagnostic {
  const nestedCode =
    typeof error.info === 'object' && error.info !== null && 'code' in error.info ? error.info.code : undefined
  const code = error.code ?? nestedCode
  const message = typeof error.message === 'string' ? error.message : ''
  const rpcOperation = 'initialize|session\/(?:new|load|resume|list|set_config_option|set_mode|fork|prompt)'
  const operationMatch = new RegExp(`(?:rejected (${rpcOperation})(?::| \\()|ACP (${rpcOperation}) failed:)`).exec(
    message,
  )
  const operationText = operationMatch?.[1] ?? operationMatch?.[2]
  const jsonRpcText = /JSON-RPC code (-?\d+)(?![\d.])/.exec(message)?.[1]
  const jsonRpcCode = jsonRpcText === undefined ? undefined : Number(jsonRpcText)
  return {
    ...(typeof code === 'string' && LIVE_DIAGNOSTIC_CODES.has(code) ? { code } : {}),
    ...(operationText !== undefined && ACP_OPERATIONS.has(operationText) ? { operation: operationText } : {}),
    ...(jsonRpcCode !== undefined && Number.isSafeInteger(jsonRpcCode) ? { jsonRpcCode } : {}),
  }
}
