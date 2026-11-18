import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ACP_SIDECAR_DB_FILENAME, createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../../src/contract/config-options.ts'
import { acpDeclaredModelRoute } from '../../../src/contract/model-selection.ts'

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
  it('preserves an escaped maximum-length Agent model through close and reopen', async () => {
    const model = acpDeclaredModelRoute('dsh-acp:'.padEnd(ACP_CONFIG_IDENTIFIER_MAX, 'x'))
    const selection = { bindingKey: 'binding', model }
    const id = SessionId('member-escaped')
    await store.writeMemberModelSelection(id, selection)
    await store.dispose()
    store = createAcpSidecar({ root })
    await expect(store.readMemberModelSelection(id)).resolves.toEqual(selection)
    await expect(store.writeMemberModelSelection(id, { ...selection, model: `${model}x` })).rejects.toThrow(TypeError)
  })

  it('keeps selections isolated by DSH session', async () => {
    await store.writeMemberModelSelection(SessionId('member-a'), { bindingKey: 'binding-a', model: 'model-a' })

    await expect(store.readMemberModelSelection(SessionId('member-a'))).resolves.toEqual({
      bindingKey: 'binding-a',
      model: 'model-a',
    })
    await expect(store.readMemberModelSelection(SessionId('member-b'))).resolves.toBeUndefined()

    await store.writeMemberModelSelection(SessionId('member-b'), { bindingKey: 'binding-b', model: 'model-b' })
    await expect(store.readMemberModelSelection(SessionId('member-a'))).resolves.toEqual({
      bindingKey: 'binding-a',
      model: 'model-a',
    })
    await expect(store.readMemberModelSelection(SessionId('member-b'))).resolves.toEqual({
      bindingKey: 'binding-b',
      model: 'model-b',
    })
  })

  it('replaces one session row atomically and keeps the latest write after close/reopen', async () => {
    const sessionId = SessionId('member-reopen')
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'old-binding', model: 'old-model' })
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'new-binding', model: 'new-model' })

    const inspection = new DatabaseSync(dbFile())
    try {
      expect(
        inspection
          .prepare('SELECT COUNT(*) AS count FROM member_model_selections WHERE dsh_session_id = ?')
          .get(sessionId),
      ).toEqual({ count: 1 })
      expect(
        inspection
          .prepare('SELECT binding_key, model_id FROM member_model_selections WHERE dsh_session_id = ?')
          .get(sessionId),
      ).toEqual({ binding_key: 'new-binding', model_id: 'new-model' })
    } finally {
      inspection.close()
    }

    await store.dispose()
    store = createAcpSidecar({ root })
    await expect(store.readMemberModelSelection(sessionId)).resolves.toEqual({
      bindingKey: 'new-binding',
      model: 'new-model',
    })

    // Binding changes do not delete or rewrite this member preference.
    await store.writeMemberModelSelection(sessionId, { bindingKey: 'different-binding', model: 'new-model' })
    await expect(store.readMemberModelSelection(sessionId)).resolves.toEqual({
      bindingKey: 'different-binding',
      model: 'new-model',
    })
  })

  it('consumes only the exact intent and preserves a newer or rebound selection', async () => {
    const id = SessionId('member-consumed')
    const consumed = { bindingKey: 'binding-a', model: 'model-a' }
    await store.writeMemberModelSelection(id, consumed)
    await store.clearMemberModelSelection(id, consumed)
    await expect(store.readMemberModelSelection(id)).resolves.toBeUndefined()

    const newer = { bindingKey: 'binding-a', model: 'model-c' }
    await store.writeMemberModelSelection(id, newer)
    await store.clearMemberModelSelection(id, consumed)
    await expect(store.readMemberModelSelection(id)).resolves.toEqual(newer)
    const rebound = { bindingKey: 'binding-b', model: 'model-a' }
    await store.writeMemberModelSelection(id, rebound)
    await store.clearMemberModelSelection(id, consumed)
    await expect(store.readMemberModelSelection(id)).resolves.toEqual(rebound)
  })

  it('upgrades legacy intent rows and preserves the exact native cut through reopen', async () => {
    const legacy = new DatabaseSync(dbFile())
    legacy.exec(
      'CREATE TABLE member_model_selections (dsh_session_id TEXT PRIMARY KEY, binding_key TEXT NOT NULL, model_id TEXT NOT NULL) STRICT',
    )
    legacy.prepare('INSERT INTO member_model_selections VALUES (?, ?, ?)').run('old-member', 'binding', 'old-model')
    legacy.close()
    await expect(store.readMemberModelSelection(SessionId('old-member'))).resolves.toEqual({
      bindingKey: 'binding',
      model: 'old-model',
    })
    const selection = {
      bindingKey: 'binding',
      model: 'new-model',
      sessionSeq: 42,
      nativeSelectionKey: '["provider","old-model",null]',
    }
    await store.writeMemberModelSelection(SessionId('old-member'), selection)
    await store.dispose()
    store = createAcpSidecar({ root })
    await expect(store.readMemberModelSelection(SessionId('old-member'))).resolves.toEqual(selection)
    await store.clearMemberModelSelection(SessionId('old-member'), { ...selection, sessionSeq: 41 })
    await expect(store.readMemberModelSelection(SessionId('old-member'))).resolves.toEqual(selection)
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
    await store.writeMemberModelSelection(SessionId('legacy-session'), {
      bindingKey: 'legacy-binding',
      model: 'legacy-model',
    })
    await store.dispose()

    const upgraded = new DatabaseSync(dbFile())
    try {
      expect(upgraded.prepare('SELECT value FROM legacy_marker').get()).toEqual({ value: 'preserved' })
      expect(
        upgraded
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_model_selections'")
          .get(),
      ).toEqual({ name: 'member_model_selections' })
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
      { bindingKey: 'binding', model: 'model', sessionSeq: -1 },
      { bindingKey: 'binding', model: 'model', sessionSeq: 1.5 },
      { bindingKey: 'binding', model: 'model', nativeSelectionKey: 'x'.repeat(8193) },
      null,
    ]) {
      await expect(store.writeMemberModelSelection(SessionId('invalid-selection'), selection as never)).rejects.toThrow(
        TypeError,
      )
    }
    await expect(store.readMemberModelSelection(SessionId('invalid-selection'))).resolves.toBeUndefined()
  })
})
