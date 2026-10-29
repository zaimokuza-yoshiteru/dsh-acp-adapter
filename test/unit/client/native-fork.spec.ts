import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Context } from '@deepseek-ai/cordis'
import { AcpNativeForkCoordinator } from '../../../src/client/coordinator/native-fork.ts'
import { createNativeForkJournal } from '../../../src/client/coordinator/native-fork-journal.ts'

function fixture() {
  const child = SessionId('child')
  const fork = vi.fn(async (options: { onCreated?: (child: ReturnType<typeof SessionId>) => void }) => {
    options.onCreated?.(child)
    return child
  })
  const register = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const scope = vi.fn(async () => ({ ok: true as const, value: '11111111-1111-4111-8111-111111111111' }))
  const records = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      records.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      records.delete(key)
    }),
  }
  const journal = (scope: string, source: string, atSeq: number) =>
    createNativeForkJournal(() => storage, scope, source, atSeq)
  const open = vi.fn(),
    failed = vi.fn()
  const createCoordinator = () =>
    new AcpNativeForkCoordinator({ sessions: { fork }, register, scope, journal, open, failed })
  return {
    child,
    fork,
    register,
    open,
    failed,
    scope,
    records,
    storage,
    journal,
    createCoordinator,
    coordinator: createCoordinator(),
  }
}

describe('ACP native fork coordinator', () => {
  it('retains native catalog/title handling and opens only after provenance is durable', async () => {
    const h = fixture()
    h.register.mockImplementation(async () => {
      expect(h.open).not.toHaveBeenCalled()
      return { ok: true, value: undefined }
    })
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'source', atSeq: 8, increaseTitle: true }))
    expect(h.register).toHaveBeenCalledWith('child', 'source', 8)
    expect(h.open).toHaveBeenCalledExactlyOnceWith('child')
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('preserves a failed child and retries registration without another native fork', async () => {
    const h = fixture()
    h.register.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'storage unavailable', {}),
    } as never)
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.failed).toHaveBeenCalledWith('source', 'child', undefined)
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.register).toHaveBeenCalledTimes(2)
    expect(h.open).toHaveBeenCalledExactlyOnceWith('child')
  })

  it('preserves a child from native workspace attachment failure before onCreated and blocks repeated creation', async () => {
    const h = fixture()
    h.fork.mockRejectedValueOnce(
      new SessionForkError(
        new RemoteError('session/workspace-attach-failed', 'workspace storage write failed', {
          sessionId: h.child,
          workspaceId: 'workspace',
        }),
        SessionId('source'),
      ),
    )
    await h.coordinator.fork(SessionId('source'), 8)
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.register).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    expect(h.failed).toHaveBeenCalledTimes(2)
    expect(h.failed).toHaveBeenLastCalledWith('source', 'child', 'workspace-attach')
  })

  it('does not accept structured fork failure evidence for another source', async () => {
    const h = fixture()
    h.fork.mockRejectedValueOnce(
      new SessionForkError(
        new RemoteError('session/workspace-attach-failed', 'unrelated fork', {
          sessionId: SessionId('unrelated-child'),
          workspaceId: 'workspace',
        }),
        SessionId('other-source'),
      ),
    )
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.failed).toHaveBeenLastCalledWith('source', undefined, 'unknown')
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('retains a child published before native title failure and stops navigation on disposal', async () => {
    const h = fixture()
    h.fork.mockImplementationOnce(async (options) => {
      options.onCreated?.(h.child)
      throw new Error('title failed')
    })
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.register).not.toHaveBeenCalled()
    h.register.mockImplementation(async () => {
      void h.coordinator.dispose()
      return { ok: true, value: undefined }
    })
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('drains native creation during unload after Remote withdrawal, then restores the exact child in a new owner', async () => {
    const h = fixture()
    const ctx = new Context()
    let release!: () => void
    let admitted!: () => void
    const started = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.fork.mockImplementationOnce(async (options) => {
      admitted()
      await gate
      options.onCreated?.(h.child)
      return h.child
    })
    h.register.mockRejectedValue(new Error('Remote namespace has already been withdrawn'))
    const owner = ctx.plugin((scope) => {
      scope.effect(() => h.coordinator.dispose)
    })
    await owner
    const operation = h.coordinator.fork(SessionId('source'), 8)
    await started
    let disposed = false
    const disposal = owner.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await operation
    await disposal
    expect(h.register).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    expect([...h.records.values()].map((raw) => JSON.parse(raw))).toEqual([{ phase: 'created', child: h.child }])
    h.register.mockResolvedValue({ ok: true, value: undefined })
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.register).toHaveBeenCalledExactlyOnceWith('child', 'source', 8)
    expect(h.open).toHaveBeenCalledExactlyOnceWith('child')
    expect(h.records.size).toBe(0)
    await ctx.fiber.dispose()
  })

  it('keeps an unconfirmed native result blocked across owner replacement', async () => {
    const h = fixture()
    h.fork.mockRejectedValueOnce(new Error('transport closed after dispatch'))
    await h.coordinator.fork(SessionId('source'), 8)
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.register).not.toHaveBeenCalled()
    expect(h.failed).toHaveBeenLastCalledWith('source', undefined, 'unknown')
  })

  it('permits a new attempt after a definitive pre-creation migration refusal', async () => {
    const h = fixture()
    h.fork.mockRejectedValueOnce(
      new SessionForkError(
        new RemoteError('session/migration-required', 'migration required', {} as never),
        SessionId('source'),
      ),
    )
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.records.size).toBe(0)
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.open).toHaveBeenCalledExactlyOnceWith('child')
  })

  it('does not create without a confirmed Host scope', async () => {
    const h = fixture()
    h.scope.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('dsh-acp/native-fork-scope-unavailable', 'storage', { sessionId: 'source' }),
    } as never)
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.records.size).toBe(0)
    expect(h.failed).toHaveBeenLastCalledWith('source', undefined, 'unavailable')
  })

  it('keeps uncertainty when storage fails after Native has named a child', async () => {
    const h = fixture()
    h.storage.setItem.mockImplementation((key, raw) => {
      if (JSON.parse(raw).phase === 'created') throw new Error('quota after creation')
      h.records.set(key, raw)
    })
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.failed).toHaveBeenLastCalledWith('source', 'child', 'storage')
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.failed).toHaveBeenLastCalledWith('source', undefined, 'unknown')
  })

  it('does not adopt a recorded child from another Host scope with the same source and cut', async () => {
    const h = fixture()
    h.open.mockImplementationOnce(() => {
      throw new Error('navigation failed')
    })
    await h.coordinator.fork(SessionId('source'), 8)
    h.scope.mockResolvedValue({ ok: true, value: '22222222-2222-4222-8222-222222222222' })
    h.fork.mockImplementationOnce(async (options) => {
      const other = SessionId('other-host-child')
      options.onCreated?.(other)
      return other
    })
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.register).toHaveBeenLastCalledWith('other-host-child', 'source', 8)
    expect(h.fork).toHaveBeenCalledTimes(2)
  })

  it('retains a verified child when opening throws and retries it without creating again', async () => {
    const h = fixture()
    h.open.mockImplementationOnce(() => {
      throw new Error('navigation failed')
    })
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.failed).toHaveBeenLastCalledWith('source', 'child', undefined)
    await h.createCoordinator().fork(SessionId('source'), 8)
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.register).toHaveBeenCalledTimes(2)
    expect(h.open).toHaveBeenLastCalledWith('child')
  })

  it.each(['corrupt', 'unwritable', 'discarded'])('does not dispatch a fork with a %s journal', async (mode) => {
    const h = fixture()
    if (mode === 'corrupt') h.storage.getItem.mockReturnValue('{')
    if (mode === 'unwritable')
      h.storage.setItem.mockImplementation(() => {
        throw new Error('quota')
      })
    if (mode === 'discarded') h.storage.setItem.mockImplementation(() => {})
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.failed).toHaveBeenLastCalledWith('source', undefined, 'storage')
  })

  it('keeps typed provenance refusals separate from retryable Remote failures', async () => {
    const h = fixture()
    h.register.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('dsh-acp/native-fork-rejected', 'child changed', {
        sessionId: 'child',
        sourceSessionId: 'source',
        atSeq: 8,
        reason: 'child-changed',
      }),
    } as never)
    await h.coordinator.fork(SessionId('source'), 8)
    expect(h.failed).toHaveBeenLastCalledWith('source', 'child', 'child-changed')
    expect(h.open).not.toHaveBeenCalled()
    expect(h.records.size).toBe(1)
  })
})
