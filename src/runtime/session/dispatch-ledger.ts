/**
 * Dispatch ledger seam. The ACP provider must persist uncertainty before an
 * RPC and settle it only after the response is durably known. Keeping the
 * persistence face injectable lets unit tests use a memory store while the
 * production composition uses AcpSidecar's SQLite WAL.
 */
export type DispatchState = 'dispatch-uncertain' | 'settled'

export interface DispatchProvenance {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly endSeq: number | null
  readonly anchorMessageId: string
  readonly acceptedMessageIds: readonly string[]
  /** Absent on dispatch rows written before bounded filtering provenance. */
  readonly projectionFiltered?: boolean
  /** Model confirmed on this ACP prompt's final lease before the dispatch attempt. */
  readonly confirmedAgentModel?: string
}

export interface DispatchRecord {
  readonly key: string
  readonly dshSessionId: string
  readonly provider: string
  readonly model: string
  readonly state: DispatchState
  readonly createdAt: number
  readonly settledAt?: number
  readonly provenance?: DispatchProvenance
}

export interface DispatchLedgerStore {
  begin(record: DispatchRecord, interruptedDispatchKey?: string): Promise<void>
  settle(dshSessionId: string, key: string): Promise<void>
  read(dshSessionId: string, key: string): Promise<DispatchRecord | undefined>
}

/** A small adapter around the durable sidecar methods. */
export class DispatchLedger {
  constructor(private readonly store: DispatchLedgerStore) {}

  begin(record: Omit<DispatchRecord, 'state'>, interruptedDispatchKey?: string): Promise<void> {
    return this.store.begin({ ...record, state: 'dispatch-uncertain' }, interruptedDispatchKey)
  }

  /** A new user turn can supersede a lost connection's guard, never its original input. */
  async interruptedBefore(
    sessionId: string,
    key: string,
    provider: string,
    next: DispatchProvenance,
  ): Promise<string | undefined> {
    const previous = await this.store.read(sessionId, key)
    const proof = previous?.provenance
    if (
      previous?.state !== 'dispatch-uncertain' ||
      previous.provider !== provider ||
      !proof ||
      !Number.isSafeInteger(proof.turn) ||
      !Number.isSafeInteger(proof.startSeq) ||
      next.turn <= proof.turn ||
      next.startSeq <= proof.startSeq ||
      !Array.isArray(proof.acceptedMessageIds) ||
      !proof.acceptedMessageIds.length ||
      !proof.acceptedMessageIds.every((id) => typeof id === 'string' && id.length > 0) ||
      next.acceptedMessageIds.some((id) => proof.acceptedMessageIds.includes(id))
    )
      return undefined
    return previous.key
  }

  settle(dshSessionId: string, key: string): Promise<void> {
    return this.store.settle(dshSessionId, key)
  }

  read(dshSessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.store.read(dshSessionId, key)
  }
}
