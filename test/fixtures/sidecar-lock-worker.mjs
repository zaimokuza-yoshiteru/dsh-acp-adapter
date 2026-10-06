import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const db = new DatabaseSync(workerData.dbPath)
db.exec('PRAGMA busy_timeout=5000')
db.exec('BEGIN IMMEDIATE')
db.prepare(
  'INSERT INTO audit (record_id, dsh_session_id, seq, time, kind, acp_provider_id, acp_session_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
).run(
  'worker-committed-row',
  workerData.sessionId,
  2,
  workerData.time,
  'replay-assessment',
  null,
  null,
  null,
  '{"status":"not-compared"}',
)
parentPort.postMessage({ type: 'locked' })
parentPort.once('message', () =>
  setTimeout(() => {
    try {
      db.exec('COMMIT')
      parentPort.postMessage({ type: 'committed' })
    } finally {
      db.close()
    }
  }, 200),
)
