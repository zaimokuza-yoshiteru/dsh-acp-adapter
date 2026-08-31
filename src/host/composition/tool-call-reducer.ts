/** Pure, prompt-scoped reducer for ACP tool_call patches. */

export type AcpToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AcpToolCallPatchStatus = AcpToolCallStatus | 'in_progress'

export interface AcpToolCallPatch {
  readonly callId: string
  readonly title?: string | null
  readonly name?: string | null
  readonly kind?: string | null
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly locations?: readonly unknown[] | null
  readonly content?: readonly unknown[] | null
  readonly status?: AcpToolCallPatchStatus | null
}

export interface AcpToolCallSnapshot extends AcpToolCallPatch {
  readonly provenanceId: string
  readonly status: AcpToolCallStatus
}

const terminalStatuses = new Set<AcpToolCallStatus>(['completed', 'failed', 'cancelled'])

function normalizedStatus(value: AcpToolCallPatchStatus | null | undefined): AcpToolCallStatus | undefined {
  if (value === undefined || value === null) return undefined
  return value === 'in_progress' ? 'running' : value
}

/** Stable ACP provenance for one call id within one DSH turn. */
export function acpToolProvenanceId(turnId: string, callId: string): string {
  return `acp:${turnId}:${callId}`
}

/** A bounded-in-scope reducer: one instance belongs to one DSH turn. */
export class AcpToolCallReducer {
  private readonly calls = new Map<string, AcpToolCallSnapshot>()

  constructor(private readonly turnId: string) {}

  apply(patch: AcpToolCallPatch): AcpToolCallSnapshot {
    const previous = this.calls.get(patch.callId)
    const patchStatus = normalizedStatus(patch.status)
    const status = previous !== undefined && terminalStatuses.has(previous.status)
      ? previous.status
      : patchStatus ?? previous?.status ?? 'pending'
    const next: AcpToolCallSnapshot = {
      ...(previous ?? { callId: patch.callId, provenanceId: acpToolProvenanceId(this.turnId, patch.callId), status: 'pending' }),
      // ACP says omitting a field leaves it unchanged.  `name: null` has the
      // same meaning explicitly; title is required on a created call, so a
      // nullable update cannot replace an established title with no title.
      ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && !((key === 'name' || key === 'title') && value === null))),
      status,
    } as AcpToolCallSnapshot
    this.calls.set(patch.callId, next)
    return next
  }
}
