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
  begin(record: DispatchRecord): Promise<void>
  settle(dshSessionId: string, key: string): Promise<void>
  read(dshSessionId: string, key: string): Promise<DispatchRecord | undefined>
}

/** A small adapter around the durable sidecar methods. */
export class DispatchLedger {
  constructor(private readonly store: DispatchLedgerStore) {}

  begin(record: Omit<DispatchRecord, 'state'>): Promise<void> {
    return this.store.begin({ ...record, state: 'dispatch-uncertain' })
  }

  settle(dshSessionId: string, key: string): Promise<void> {
    return this.store.settle(dshSessionId, key)
  }

  read(dshSessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.store.read(dshSessionId, key)
  }
}
