/** Host-observed process termination attached to an explicitly referenced ACP
 * terminal. This is separate from the Agent's tool status and raw output. */
export interface AcpHostTerminalOutcome {
  readonly source: 'acp-client-terminal'
  readonly dshSessionId: string
  readonly acpSessionId: string
  readonly terminalId: string
  readonly exitCode: number | null
  readonly signal: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** More than one terminal entry is ambiguous, even if its ids repeat. */
export function singleActivityTerminalId(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const references = content.filter((item) => record(item) && item.type === 'terminal')
  if (references.length !== 1) return undefined
  const id = references[0]?.terminalId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Validate the Host-only field again at the persisted presentation boundary. */
export function activityHostTerminalOutcome(
  detail: unknown,
  ownerDshSessionId: string,
): AcpHostTerminalOutcome | undefined {
  if (!record(detail) || !record(detail.hostTerminalOutcome)) return undefined
  const value = detail.hostTerminalOutcome
  if (
    value.source !== 'acp-client-terminal' ||
    value.dshSessionId !== ownerDshSessionId ||
    typeof value.acpSessionId !== 'string' ||
    value.acpSessionId.length === 0 ||
    value.terminalId !== singleActivityTerminalId(detail.content) ||
    typeof value.terminalId !== 'string' ||
    !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
    !(value.signal === null || (typeof value.signal === 'string' && value.signal.length > 0)) ||
    (value.exitCode === null && value.signal === null)
  )
    return undefined
  return value as unknown as AcpHostTerminalOutcome
}
