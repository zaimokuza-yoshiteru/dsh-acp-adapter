import type { DatabaseSync } from 'node:sqlite'
import type { AcpPermissionAuditData } from '../domain/policy/events.ts'

export type PermissionWithdrawal = Extract<AcpPermissionAuditData, { phase: 'decision-withdrawn' }>

/** Host-owned across Loader generations. Entries leave memory only after SQLite commits them. */
export class UncommittedWithdrawals {
  private readonly records = new Map<
    string,
    {
      readonly database: string
      readonly sessionId: string
      readonly time: number
      readonly data: PermissionWithdrawal
      readonly closeStore: () => Promise<void>
    }
  >()

  retain(
    database: string,
    sessionId: string,
    time: number,
    data: PermissionWithdrawal,
    closeStore: () => Promise<void>,
  ): void {
    const key = JSON.stringify([database, sessionId, data.agentSessionId, data.toolCallId, data.requestId])
    if (!this.records.has(key)) this.records.set(key, { database, sessionId, time, data: { ...data }, closeStore })
  }

  persist(database: string, sessionId: string | undefined, open: () => DatabaseSync): void {
    for (const [key, record] of this.records) {
      if (record.database !== database || (sessionId !== undefined && record.sessionId !== sessionId)) continue
      try {
        // Standalone autocommit, before any attempt to write the audit projection.
        open()
          .prepare(
            'INSERT INTO pending_permission_withdrawals (dsh_session_id, acp_session_id, tool_call_id, request_id, time) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          )
          .run(record.sessionId, record.data.agentSessionId, record.data.toolCallId, record.data.requestId, record.time)
        this.records.delete(key)
      } catch {
        throw new Error('ACP_PERMISSION_AUDIT_UNAVAILABLE')
      }
    }
  }

  /** The owning plugin may already be disabled when the Host finally stops. */
  async close(): Promise<void> {
    const stores = new Map(Array.from(this.records.values(), (record) => [record.database, record.closeStore] as const))
    const results = await Promise.allSettled(Array.from(stores.values(), (close) => close()))
    if (results.some((result) => result.status === 'rejected')) throw new Error('ACP_PERMISSION_AUDIT_UNAVAILABLE')
  }
}
