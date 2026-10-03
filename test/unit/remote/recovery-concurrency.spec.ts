import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpRecoveryAdapterLike } from '../../../src/remote/service.ts'
import type { AcpRecoveryView } from '../../../src/contract/remote.ts'

const recovery: AcpRecoveryView = {
  dshSessionId: 'session-1',
  kind: 'outcome-unknown',
  cause: 'load-failed',
  detail: 'Recovery has not completed',
  provider: 'acp-codex',
  acpSessionId: 'agent-session-1',
  generation: 1,
  interruptedTurnId: null,
  lastAttemptAt: null,
  lastUserAction: null,
  updatedAt: 10,
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createService(adapter: AcpRecoveryAdapterLike, state = recovery) {
  const adapterFor = vi.fn(() => adapter)
  const stateRead = vi.fn(async (sessionId: string) => ({ ...state, dshSessionId: sessionId }))
  const service = new AcpRemoteService(new Context(), {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    resolveLiveAgent: () => undefined,
    ownedSessionReadGate: () => true,
    backendFacts: {
      readBindingProvider: async () => 'acp-codex',
      peekHeaderProvider: async () => undefined,
      hasLiveAgent: () => false,
    },
    recoveryAdapter: adapterFor,
    recoveryStateStore: { read: stateRead },
  })
  return { service, adapterFor, stateRead }
}

async function waitForCall(calls: number, read: () => number): Promise<void> {
  await vi.waitFor(() => expect(read()).toBe(calls))
}

describe('ACP recovery operation concurrency', () => {
  it('rejects a second retry for the same session without invoking the adapter or changing recovery', async () => {
    const gate = deferred()
    const retryOriginal = vi.fn(() => gate.promise)
    const rebindBlank = vi.fn(async () => undefined)
    const { service, adapterFor, stateRead } = createService({ retryOriginal, rebindBlank })
    const first = service.retryOriginal('session-1')
    await waitForCall(1, () => retryOriginal.mock.calls.length)

    await expect(service.retryOriginal('session-1')).rejects.toMatchObject({
      code: 'dsh-acp/resume-conflict',
      message: 'An ACP recovery action is already in progress for this session',
    })
    expect(retryOriginal).toHaveBeenCalledTimes(1)
    expect(adapterFor).toHaveBeenCalledTimes(1)
    expect(stateRead).toHaveBeenCalledTimes(0)

    gate.resolve()
    await expect(first).resolves.toMatchObject({ kind: 'outcome-unknown', detail: recovery.detail })
    expect(stateRead).toHaveBeenCalledTimes(1)
  })

  it('rejects retry versus blank rebind for the same session', async () => {
    const gate = deferred()
    const retryOriginal = vi.fn(() => gate.promise)
    const rebindBlank = vi.fn(async () => undefined)
    const { service } = createService({ retryOriginal, rebindBlank })
    const first = service.retryOriginal('session-1')
    await waitForCall(1, () => retryOriginal.mock.calls.length)

    await expect(service.rebindRecoveryBlank('session-1')).rejects.toMatchObject({
      code: 'dsh-acp/resume-conflict',
    })
    expect(retryOriginal).toHaveBeenCalledTimes(1)
    expect(rebindBlank).not.toHaveBeenCalled()

    gate.resolve()
    await first
  })

  it('releases the session lock after a failed action', async () => {
    const retryOriginal = vi.fn().mockRejectedValueOnce(new Error('restore failed')).mockResolvedValueOnce(undefined)
    const { service } = createService({ retryOriginal, rebindBlank: async () => undefined })

    await expect(service.retryOriginal('session-1')).rejects.toThrow('restore failed')
    await expect(service.retryOriginal('session-1')).resolves.toMatchObject({ kind: 'outcome-unknown' })
    expect(retryOriginal).toHaveBeenCalledTimes(2)
  })

  it('allows recovery operations on different sessions to proceed independently', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const retryOriginal = vi.fn((sessionId: string) =>
      sessionId === 'session-1' ? firstGate.promise : secondGate.promise,
    )
    const { service, adapterFor } = createService({ retryOriginal, rebindBlank: async () => undefined })
    const first = service.retryOriginal('session-1')
    const second = service.retryOriginal('session-2')
    await waitForCall(2, () => retryOriginal.mock.calls.length)

    expect(adapterFor).toHaveBeenCalledTimes(2)
    firstGate.resolve()
    secondGate.resolve()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { dshSessionId: 'session-1', kind: 'outcome-unknown' },
      { dshSessionId: 'session-2', kind: 'outcome-unknown' },
    ])
  })
})
