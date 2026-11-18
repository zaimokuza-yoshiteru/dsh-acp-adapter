import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import {
  assertNativeForkSeed,
  createNativeForkRegistrar,
  registerNativeFork,
} from '../../../src/host/composition/native-fork.ts'
import { AcpNativeForkError } from '../../../src/domain/session/native-fork-error.ts'
import { createAcpSidecar, ACP_SIDECAR_DB_FILENAME, type AcpSidecar } from '../../../src/persistence/sidecar.ts'

const roots: string[] = []
const stores: AcpSidecar[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function snapshots() {
  const parent: SessionLogSnapshot = {
    session: { id: SessionId('source'), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    inheritedEventCount: SessionLogOffset(0),
    events: [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const child: SessionLogSnapshot = {
    session: { ...parent.session, id: SessionId('child'), isSeeded: true },
    inheritedEventCount: SessionLogOffset(4),
    events: buildForkSeed(parent.events, SessionSeq(3)),
  }
  return { parent, child }
}

describe('explicit ordinary native fork provenance', () => {
  it.each(['owner', 'query-provider'])(
    'drains accepted verification during %s removal before releasing dependencies',
    async (target) => {
      const ctx = new Context()
      const { parent, child } = snapshots()
      let release!: () => void
      let announce!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const reading = new Promise<void>((resolve) => {
        announce = resolve
      })
      let closed = false
      const recordNativeFork = vi.fn(async () => {
        expect(closed).toBe(false)
      })
      const sidecar = {
        readNativeFork: async () => undefined,
        readLatestBinding: async (id: string) => (id === 'source' ? { status: 'ok', binding: {} } : undefined),
        recordNativeFork,
      } as unknown as AcpSidecar
      const provider = ctx.plugin((scope) => {
        scope.provide('sessionQuery', {
          readSession: async (id: string) => {
            announce()
            await gate
            return id === 'source' ? parent : child
          },
        } as never)
        scope.provide('sessions', { get: () => ({ seq: child.events.length }) } as never)
      })
      await provider
      let registrar!: ReturnType<typeof createNativeForkRegistrar>
      const owner = ctx.plugin((scope) => {
        registrar = createNativeForkRegistrar(scope, sidecar)
        scope.effect(function* () {
          yield scope.effect(() => () => {
            closed = true
          })
          yield registrar.releaseQuery
          yield scope.effect(() => registrar.drain)
        })
      })
      await owner
      const source = { dshSessionId: 'child', sourceSessionId: 'source', atSeq: 3 }
      const accepted = registrar.register(source)
      await reading
      let disposed = false
      const disposal = (target === 'owner' ? owner : provider).dispose().then(() => {
        disposed = true
      })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(closed).toBe(false)
      release()
      await accepted
      await disposal
      expect(recordNativeFork).toHaveBeenCalledExactlyOnceWith(source)
      expect(closed).toBe(target === 'owner')
      await expect(registrar.register(source)).rejects.toMatchObject({ reason: 'unavailable' })
      await owner.dispose()
      expect(closed).toBe(true)
      await ctx.fiber.dispose()
    },
  )

  it('uses the public native seed builder, preserving no parentSession relationship', () => {
    const { parent, child } = snapshots()
    expect(() => assertNativeForkSeed(parent, child, 3)).not.toThrow()
    expect(child.session.parentSession).toBeUndefined()
  })

  it.each(['source', 'cut', 'payload', 'subagent', 'appended activity'])(
    'rejects an incompatible %s before recording provenance',
    (mismatch) => {
      const { parent, child } = snapshots()
      if (mismatch === 'source') child.session = { ...child.session, id: parent.session.id }
      if (mismatch === 'cut') child.inheritedEventCount = SessionLogOffset(3)
      if (mismatch === 'payload') child.events[0] = { ...child.events[0]!, time: 99 }
      if (mismatch === 'subagent')
        child.session = { ...child.session, origin: 'subagent', parentSession: parent.session.id }
      if (mismatch === 'appended activity')
        child.events.push({ type: 'turn/start', seq: SessionSeq(5), time: 6, data: { turn: 2 } })
      expect(() => assertNativeForkSeed(parent, child, 3)).toThrow(AcpNativeForkError)
    },
  )

  it('persists once across restart and rejects an attempt to replace the source or cut', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-native-fork-'))
    roots.push(root)
    const first = createAcpSidecar({ root })
    const scope = await first.initializeNativeForkScope()
    const source = { dshSessionId: 'child', sourceSessionId: 'source', atSeq: 3 }
    await first.recordNativeFork(source)
    await first.dispose()
    const reopened = createAcpSidecar({ root })
    stores.push(reopened)
    expect(await reopened.initializeNativeForkScope()).toBe(scope)
    expect(await reopened.readNativeFork(SessionId('child'))).toEqual(source)
    await reopened.recordNativeFork(source)
    await expect(reopened.recordNativeFork({ ...source, sourceSessionId: 'other' })).rejects.toThrow('different source')
    await expect(reopened.recordNativeFork({ ...source, atSeq: 2 })).rejects.toThrow('different source')
    expect(await reopened.readNativeFork(SessionId('child'))).toEqual(source)
    const db = new DatabaseSync(join(root, ACP_SIDECAR_DB_FILENAME))
    try {
      db.prepare('UPDATE native_fork_sources SET payload = ? WHERE dsh_session_id = ?').run('{"invalid":true}', 'child')
    } finally {
      db.close()
    }
    await expect(reopened.readNativeFork(SessionId('child'))).rejects.toThrow()
  })

  it('assigns separate durable scopes to independent Sidecar profiles and rejects corrupt metadata', async () => {
    const ids: string[] = []
    for (let index = 0; index < 2; index++) {
      const root = mkdtempSync(join(tmpdir(), 'acp-fork-scope-'))
      roots.push(root)
      const store = createAcpSidecar({ root })
      stores.push(store)
      ids.push(await store.initializeNativeForkScope())
    }
    expect(ids[0]).not.toBe(ids[1])
    const db = new DatabaseSync(join(roots.at(-1)!, ACP_SIDECAR_DB_FILENAME))
    db.prepare('UPDATE native_fork_scope SET scope_id = ?').run('corrupted')
    db.close()
    expect(() => stores.at(-1)!.initializeNativeForkScope()).toThrow('malformed')
  })

  it('registers only an unchanged exact child and retries without rereading or overwriting history', async () => {
    const { parent, child } = snapshots()
    const root = mkdtempSync(join(tmpdir(), 'acp-native-fork-'))
    roots.push(root)
    const store = createAcpSidecar({ root })
    stores.push(store)
    const readBinding = vi
      .spyOn(store, 'readLatestBinding')
      .mockImplementation(async (id) => (id === 'source' ? { status: 'ok', binding: {} as never } : undefined))
    const readSession = vi.fn(async (id) => (id === 'source' ? parent : child))
    const ctx = {
      sessionQuery: { readSession },
      sessions: { get: () => ({ seq: child.events.length }) },
    } as unknown as Context
    const source = { dshSessionId: 'child', sourceSessionId: 'source', atSeq: 3 }
    await registerNativeFork(ctx, store, source)
    expect(await store.readNativeFork(SessionId('child'))).toEqual(source)
    readSession.mockClear()
    readBinding.mockClear()
    await registerNativeFork(ctx, store, source)
    expect(readSession).not.toHaveBeenCalled()
    expect(readBinding).not.toHaveBeenCalled()
    await expect(registerNativeFork(ctx, store, { ...source, sourceSessionId: 'other' })).rejects.toThrow(
      'different source',
    )
  })

  it('rejects an already bound child and a child changed during verification', async () => {
    const { parent, child } = snapshots()
    const recordNativeFork = vi.fn()
    const ctx = {
      sessionQuery: { readSession: async (id: string) => (id === 'source' ? parent : child) },
      sessions: { get: () => ({ seq: child.events.length + 1 }) },
    } as unknown as Context
    const sidecar = {
      readNativeFork: async () => undefined,
      readLatestBinding: vi.fn(async () => ({ status: 'ok', binding: {} })),
      recordNativeFork,
    } as unknown as AcpSidecar
    const source = { dshSessionId: 'child', sourceSessionId: 'source', atSeq: 3 }
    await expect(registerNativeFork(ctx, sidecar, source)).rejects.toThrow('already bound')
    vi.mocked(sidecar.readLatestBinding).mockImplementation(async (id) =>
      id === 'source' ? { status: 'ok', binding: {} as never } : undefined,
    )
    await expect(registerNativeFork(ctx, sidecar, source)).rejects.toThrow('changed')
    expect(recordNativeFork).not.toHaveBeenCalled()
  })
})
