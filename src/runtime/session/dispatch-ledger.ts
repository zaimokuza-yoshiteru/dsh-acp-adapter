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

/** In-memory store for isolated composition tests only; never the production default. */
export class MemoryDispatchLedgerStore implements DispatchLedgerStore {
  private readonly records = new Map<string, DispatchRecord>()

  async begin(record: DispatchRecord): Promise<void> {
    const index = `${record.dshSessionId}:${record.key}`
    const existing = this.records.get(index)
    if (existing !== undefined) throw new Error(`ACP_RECOVERY_REQUIRED: dispatch ${record.key} is ${existing.state}`)
    for (const [candidate, value] of this.records) {
      if (!candidate.startsWith(`${record.dshSessionId}:`)) continue
      if (value.state === 'dispatch-uncertain') throw new Error(`ACP_RECOVERY_REQUIRED: dispatch ${value.key} is dispatch-uncertain`)
      this.records.delete(candidate)
    }
    this.records.set(index, record)
  }

  async settle(dshSessionId: string, key: string): Promise<void> {
    const index = `${dshSessionId}:${key}`
    const existing = this.records.get(index)
    if (existing === undefined) throw new Error(`ACP_LEDGER_MISSING: dispatch ${key} was not begun`)
    if (existing.state === 'settled') return
    this.records.set(index, { ...existing, state: 'settled', settledAt: Date.now() })
  }

  async read(dshSessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.records.get(`${dshSessionId}:${key}`)
  }
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
