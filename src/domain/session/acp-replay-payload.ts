import { z } from 'zod'

/** Small opaque marker carried by a DSH assistant ReplayEnvelope. Unknown response fields are not retained. */
export const acpReplayPayloadSchema = z.object({
  kind: z.literal('dsh-acp'),
  version: z.literal(1),
  ownerDshSessionId: z.string(),
  profileId: z.string(),
  profileGeneration: z.number(),
  agentSessionId: z.string(),
  bindingEpoch: z.number(),
  launchFingerprint: z.string(),
  committedPromptOrdinal: z.number(),
  committedActivitySeq: z.number(),
  activityAnchorMessageId: z.string().optional(),
})
export type AcpReplayPayloadV1 = z.infer<typeof acpReplayPayloadSchema>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract the latest ACP marker from a seeded assistant message. */
export function acpReplayPayloadOf(event: { readonly type: string; readonly data: unknown }): AcpReplayPayloadV1 | undefined {
  if (event.type !== 'assistant/message' || !record(event.data)) return undefined
  const message = record(event.data.message) ? event.data.message : event.data
  const source = record(message.source) ? message.source : undefined
  const response = record(source?.replayState) ? source.replayState.response : undefined
  const parsed = acpReplayPayloadSchema.safeParse(response)
  return parsed.success ? parsed.data : undefined
}
