/** Small opaque marker carried by a DSH assistant ReplayEnvelope. */
export interface AcpReplayPayloadV1 {
  readonly kind: 'dsh-acp'
  readonly version: 1
  readonly ownerDshSessionId: string
  readonly profileId: string
  readonly profileGeneration: number
  readonly agentSessionId: string
  readonly bindingEpoch: number
  readonly launchFingerprint: string
  readonly committedPromptOrdinal: number
  readonly committedActivitySeq: number
  readonly activityAnchorMessageId?: string
  readonly activityRequestHeaderSeq?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract the latest ACP marker from a seeded assistant message. */
export function acpReplayPayloadOf(event: { readonly type: string; readonly data: unknown }): AcpReplayPayloadV1 | undefined {
  if (event.type !== 'assistant/message' || !record(event.data)) return undefined
  const message = record(event.data.message) ? event.data.message : event.data
  const source = record(message.source) ? message.source : undefined
  const response = record(source?.replayState) ? source.replayState.response : undefined
  if (!record(response) || response.kind !== 'dsh-acp' || response.version !== 1) return undefined
  if (typeof response.ownerDshSessionId !== 'string' || typeof response.profileId !== 'string'
    || typeof response.profileGeneration !== 'number' || typeof response.agentSessionId !== 'string'
    || typeof response.bindingEpoch !== 'number' || typeof response.launchFingerprint !== 'string'
    || typeof response.committedPromptOrdinal !== 'number' || typeof response.committedActivitySeq !== 'number'
    || (response.activityRequestHeaderSeq !== undefined && typeof response.activityRequestHeaderSeq !== 'number')) return undefined
  return response as unknown as AcpReplayPayloadV1
}
