const ACP_OPERATIONS = new Set([
  'initialize', 'session/new', 'session/load', 'session/resume', 'session/list',
  'session/set_config_option', 'session/set_mode', 'session/fork', 'session/prompt',
])

export interface SafeLiveDiagnostic {
  readonly code?: string
  readonly operation?: string
  readonly jsonRpcCode?: number
}

/** Extract only fixed protocol facts from a turn failure; never forward its text. */
export function safeLiveDiagnostic(error: { readonly code?: unknown; readonly message?: unknown }): SafeLiveDiagnostic {
  const message = typeof error.message === 'string' ? error.message : ''
  const rpcOperation = 'initialize|session\/(?:new|load|resume|list|set_config_option|set_mode|fork|prompt)'
  const operationMatch = new RegExp(`(?:rejected (${rpcOperation})(?::| \\()|ACP (${rpcOperation}) failed:)`).exec(message)
  const operationText = operationMatch?.[1] ?? operationMatch?.[2]
  const jsonRpcText = /JSON-RPC code (-?\d+)(?![\d.])/.exec(message)?.[1]
  const jsonRpcCode = jsonRpcText === undefined ? undefined : Number(jsonRpcText)
  return {
    ...(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? { code: error.code } : {}),
    ...(operationText !== undefined && ACP_OPERATIONS.has(operationText) ? { operation: operationText } : {}),
    ...(jsonRpcCode !== undefined && Number.isSafeInteger(jsonRpcCode) ? { jsonRpcCode } : {}),
  }
}
