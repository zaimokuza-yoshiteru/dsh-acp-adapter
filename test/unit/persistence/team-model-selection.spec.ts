import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ACP_SIDECAR_DB_FILENAME, createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'

let root = ''
let store: AcpSidecar

function dbFile(): string {
  return path.join(root, ACP_SIDECAR_DB_FILENAME)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-team-model-selection-'))
  store = createAcpSidecar({ root })
})

afterEach(async () => {
  await store.dispose().catch(() => undefined)
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('member model selection persistence', () => {
  it('keeps selections isolated by DSH session', async () => {
    await store.writeMemberModelSelection(SessionId('member-a'), { bindingKey: 'binding-a', model: 'model-a' })

    await expect(store.readMemberModelSelection(SessionId('member-a'))).resolves.toEqual({ bindingKey: 'binding-a', model: 'model-a' })
    await expect(store.readMemberModelSelection(SessionId('member-b'))).resolves.toBeUndefined()

    await store.writeMemberModelSelection(SessionId('member-b'), { bindingKey: 'binding-b', model: 'model-b' })
    await expect(store.readMemberModelSelection(SessionId('member-a'))).resolves.toEqual({ bindingKey: 'binding-a', model: 'model-a' })
    await expect(store.readMemberModelSelection(SessionId('member-b'))).resolves.toEqual({ bindingKey: 'binding-b', model: 'model-b' })
  })

  it('replaces one session row atomically and keeps the latest write after close/reopen', async () => {
    const sessionId = SessionId('member-reopen')
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'old-binding', model: 'old-model' })
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'new-binding', model: 'new-model' })

    const inspection = new DatabaseSync(dbFile())
    try {
      expect(inspection.prepare('SELECT COUNT(*) AS count FROM member_model_selections WHERE dsh_session_id = ?').get(sessionId)).toEqual({ count: 1 })
      expect(inspection.prepare('SELECT binding_key, model_id FROM member_model_selections WHERE dsh_session_id = ?').get(sessionId)).toEqual({ binding_key: 'new-binding', model_id: 'new-model' })
    } finally {
      inspection.close()
    }

    await store.dispose()
    store = createAcpSidecar({ root })
    await expect(store.readMemberModelSelection(sessionId)).resolves.toEqual({ bindingKey: 'new-binding', model: 'new-model' })

    // Binding changes do not delete or rewrite this member preference.
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'different-binding', model: 'new-model' })
    await expect(store.readMemberModelSelection(sessionId)).resolves.toEqual({ bindingKey: 'different-binding', model: 'new-model' })
  })

  it('adds the table when opening an older sidecar without changing existing tables', async () => {
    const legacy = new DatabaseSync(dbFile())
    try {
      legacy.exec('CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT')
      legacy.prepare('INSERT INTO legacy_marker (value) VALUES (?)').run('preserved')
    } finally {
      legacy.close()
    }

    await expect(store.readMemberModelSelection(SessionId('legacy-session'))).resolves.toBeUndefined()
    await store.writeMemberModelSelection(SessionId('legacy-session'), { bindingKey: 'legacy-binding', model: 'legacy-model' })
    await store.dispose()

    const upgraded = new DatabaseSync(dbFile())
    try {
      expect(upgraded.prepare('SELECT value FROM legacy_marker').get()).toEqual({ value: 'preserved' })
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_model_selections'").get()).toEqual({ name: 'member_model_selections' })
    } finally {
      upgraded.close()
    }
  })

  it('rejects unsafe session ids and out-of-bound selection values', async () => {
    const valid = { bindingKey: 'binding', model: 'model' }
    await expect(store.writeMemberModelSelection(SessionId('../escape'), valid)).rejects.toThrow(TypeError)
    await expect(store.readMemberModelSelection(SessionId('../escape'))).rejects.toThrow(TypeError)

    for (const selection of [
      { bindingKey: '', model: 'model' },
      { bindingKey: 'binding', model: '' },
      { bindingKey: 'b'.repeat(8_193), model: 'model' },
      { bindingKey: 'binding', model: 'm'.repeat(513) },
      null,
    ]) {
      await expect(store.writeMemberModelSelection(SessionId('invalid-selection'), selection as never)).rejects.toThrow(TypeError)
    }
    await expect(store.readMemberModelSelection(SessionId('invalid-selection'))).resolves.toBeUndefined()
  })
})
