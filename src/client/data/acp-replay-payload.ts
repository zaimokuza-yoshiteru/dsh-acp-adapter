/**
 * Client-safe reader for the ACP replay marker carried by DSH assistant
 * messages.  This intentionally does not import the host session domain: the
 * marker is a wire datum used only to identify an additive activity node.
 */

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

/** Extract an ACP marker from a DSH assistant/message event. */
export function acpReplayPayloadOf(event: { readonly type: string; readonly data: unknown }): AcpReplayPayloadV1 | undefined {
  if (event.type !== 'assistant/message' || !record(event.data)) return undefined
  const message = record(event.data.message) ? event.data.message : event.data
  // Alpha DSH normally stores the envelope at message.source.replayState.
  // Keep the reader tolerant of the two equivalent compact-history shapes
  // emitted by older/third-party session serializers: message.replayState and
  // data.replayState.  These are still read-only replay evidence; no provider
  // specific event is synthesized for the conversation assembler.
  const source = record(message.source) ? message.source : undefined
  const replayState = record(source?.replayState)
    ? source.replayState
    : record(message.replayState)
      ? message.replayState
      : record(event.data.replayState) ? event.data.replayState : undefined
  const response = record(replayState?.response)
    ? replayState.response
    : replayState
  if (!record(response) || response.kind !== 'dsh-acp' || response.version !== 1) return undefined
  if (typeof response.ownerDshSessionId !== 'string' || typeof response.profileId !== 'string'
    || typeof response.profileGeneration !== 'number' || typeof response.agentSessionId !== 'string'
    || typeof response.bindingEpoch !== 'number' || typeof response.launchFingerprint !== 'string'
    || typeof response.committedPromptOrdinal !== 'number' || typeof response.committedActivitySeq !== 'number'
    || (response.activityRequestHeaderSeq !== undefined && typeof response.activityRequestHeaderSeq !== 'number')) return undefined
  return response as unknown as AcpReplayPayloadV1
}
