import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { AcpPermissionAuditData } from '../../src/domain/policy/events.ts'
import { required } from './required.ts'

/** Observe the durable ACP audit owner; native UI answerers need not rewrite Session policy or audit. */
export function acpPermissionAudit<P extends 'asked' | 'decided'>(host: { ctx: Context }, phase: P) {
  const database = new DatabaseSync(join(required(host.ctx.dshHomePath)('dsh-acp'), 'sidecar.sqlite'), {
    readOnly: true,
  })
  try {
    const rows = database
      .prepare("SELECT dsh_session_id, payload FROM audit WHERE kind = 'permission' ORDER BY time, rowid")
      .all()
    return rows.flatMap((row) => {
      const data = JSON.parse(String(row.payload)) as AcpPermissionAuditData
      return data.phase === phase
        ? [{ sessionId: String(row.dsh_session_id), data: data as Extract<AcpPermissionAuditData, { phase: P }> }]
        : []
    })
  } finally {
    database.close()
  }
}
