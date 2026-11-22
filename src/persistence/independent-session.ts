import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const independentSessionSchema = `CREATE TABLE IF NOT EXISTS independent_session_requests (
  source_id TEXT NOT NULL, request_key TEXT NOT NULL, destination_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL, model TEXT NOT NULL, profile_identity TEXT NOT NULL, phase TEXT NOT NULL,
  PRIMARY KEY(source_id, request_key)
);`

type Phase = 'creating' | 'created' | 'submitting' | 'queued'

interface Receipt {
  readonly sessionId: string
  readonly phase: Phase
}

/** One reservation precedes native creation. Store only the task fingerprint, never a second copy of the task. */
export class IndependentSessionRequests {
  private readonly open: () => DatabaseSync

  constructor(open: () => DatabaseSync) {
    this.open = open
  }

  reserve(source: string, key: string, profile: string, model: string, identity: string): Receipt & { fresh: boolean } {
    const db = this.open()
    const result = db
      .prepare(
        `INSERT INTO independent_session_requests
      (source_id,request_key,destination_id,profile_id,model,profile_identity,phase) VALUES (?,?,?,?,?,?,'creating')
      ON CONFLICT(source_id,request_key) DO NOTHING`,
      )
      .run(source, key, 'session-' + randomUUID(), profile, model, identity)
    const row = db
      .prepare(
        `SELECT destination_id AS sessionId, phase, profile_identity AS profileIdentity FROM independent_session_requests
      WHERE source_id = ? AND request_key = ?`,
      )
      .get(source, key) as unknown as Receipt & { profileIdentity: string }
    if (row.profileIdentity !== identity)
      throw new Error('ACP_SESSION_AGENT_CHANGED: The original request selected a different Agent installation.')
    return { ...row, fresh: result.changes === 1 }
  }

  advance(source: string, key: string, previous: Phase, next: Phase, sessionId: string): void {
    const change = this.open()
      .prepare(
        `UPDATE independent_session_requests SET phase = ?, destination_id = ?
      WHERE source_id = ? AND request_key = ? AND phase = ?`,
      )
      .run(next, sessionId, source, key, previous)
    if (change.changes !== 1) throw new Error('ACP_SESSION_CREATE_CHANGED: Check the existing creation request.')
  }

  list(source: string) {
    return this.open()
      .prepare(
        `SELECT destination_id AS sessionId, profile_id AS agent, model
      FROM independent_session_requests WHERE source_id = ? AND phase != 'creating' ORDER BY rowid DESC`,
      )
      .all(source) as unknown as ReadonlyArray<{ sessionId: string; agent: string; model: string }>
  }
}
