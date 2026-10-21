/** A Host-proven control reply. It records non-execution, never tool success. */
export interface AcpHostToolControlOutcome {
  readonly source: 'dsh-tool-bridge'
  readonly kind: 'deferred-team-message'
  readonly dshSessionId: string
  readonly toolCallId: string
  readonly tool: 'wait_agent'
  readonly executed: false
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the Host projection writes this field; provider metadata is not copied into it. */
export function activityHostToolControlOutcome(
  detail: unknown,
  row: {
    readonly ownerDshSessionId: string
    readonly promptAnchorMessageId: string
    readonly activityId: string
    readonly status: string
  },
): AcpHostToolControlOutcome | undefined {
  if (!record(detail) || !record(detail.hostControlOutcome) || row.status !== 'failed') return undefined
  const value = detail.hostControlOutcome
  if (
    value.source !== 'dsh-tool-bridge' ||
    value.kind !== 'deferred-team-message' ||
    value.dshSessionId !== row.ownerDshSessionId ||
    value.tool !== 'wait_agent' ||
    detail.toolName !== 'wait_agent' ||
    value.executed !== false ||
    typeof value.toolCallId !== 'string' ||
    value.toolCallId.length === 0 ||
    row.activityId !== `${row.promptAnchorMessageId}:tool:${value.toolCallId}`
  )
    return undefined
  return value as unknown as AcpHostToolControlOutcome
}
