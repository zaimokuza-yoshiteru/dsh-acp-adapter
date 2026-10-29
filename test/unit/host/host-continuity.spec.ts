import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AcpHostContinuity, ensureHostContinuity } from '../../../src/host/composition/host-continuity.ts'
import { AcpLocalSettlementError } from '../../../src/host/composition/local-settlement.ts'

const recovery = {
  dshSessionId: 'session-a',
  kind: 'reconciliation-required' as const,
  cause: 'load-failed',
  detail: 'retired runtime has uncommitted feedback',
  updatedAt: 1,
}

async function drainMicrotasks(): Promise<void> {
  for (let count = 0; count < 20; count++) await Promise.resolve()
}

describe('Host continuity owner', () => {
  it('retains gates and fallback across plugin replacement, isolated from another Host', async () => {
    const root = new Context()
    const other = new Context()
    let pending = true
    const settled = Promise.withResolvers<void>()
    const runtime = {
      hasPendingHostCalls: () => pending,
      waitForHostCallsSettled: () => settled.promise,
    }
    const owner = ensureHostContinuity(root)
    let cleanups = 0
    const plugin = (ctx: Context) => {
      const continuity = ensureHostContinuity(ctx)
      expect(continuity).toBe(owner)
      const disposeResources = ctx.effect(() => () => {
        cleanups++
        continuity.executionOwners.retain('session-a', runtime)
        continuity.executionOwners.setRecoveryFallback(recovery)
      })
      const lease = continuity.borrow(disposeResources)
      ctx.effect(function* () {
        yield disposeResources
        yield ctx.effect(() => lease.close)
      })
    }
    try {
      const first = await root.plugin(plugin)
      await first.dispose()
      expect(cleanups).toBe(1)
      expect(ensureHostContinuity(root.extend({}))).toBe(owner)
      expect(owner.executionOwners.getRecoveryFallback('session-a')).toEqual(recovery)
      expect(() => owner.executionOwners.assertQuiescent('session-a')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
      expect(() => ensureHostContinuity(other).executionOwners.assertQuiescent('session-a')).not.toThrow()

      const second = await root.plugin(plugin)
      await second.dispose()
      expect(cleanups).toBe(2)
      expect(ensureHostContinuity(root)).toBe(owner)
    } finally {
      pending = false
      settled.resolve()
      await Promise.all([root.fiber.dispose(), other.fiber.dispose()])
    }
    expect(root.get('acpHostContinuity', false)).toBeUndefined()
    expect(owner.executionOwners.getRecoveryFallback('session-a')).toBeUndefined()
    expect(() => owner.borrow(() => undefined)).toThrow('ACP_HOST_CONTINUITY_CLOSED')
  })

  it.each(['root', 'consumer'] as const)(
    'joins the real resource cleanup when %s disposal starts first, before withdrawing its service',
    async (first) => {
      const root = new Context()
      const owner = ensureHostContinuity(root)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const durable: string[] = []
      let resourceOpen = true
      let cleanupCalls = 0
      const consumer = await root.plugin((ctx) => {
        const disposeResources = ctx.effect(() => async () => {
          cleanupCalls++
          entered.resolve()
          await release.promise
          try {
            expect(resourceOpen).toBe(true)
            expect(root.get('acpHostContinuity', false)).toBe(owner)
            // Already admitted cleanup remains legal after new leases have stopped.
            owner.executionOwners.setRecoveryFallback(recovery)
            await owner.settlements.settle(
              'session-a',
              'terminal-a',
              async () => {
                if (!resourceOpen) throw new Error('writer was closed early')
                durable.push('tool result')
              },
              {},
              () => undefined,
              {},
            )
          } finally {
            resourceOpen = false
          }
        })
        const lease = owner.borrow(disposeResources)
        ctx.effect(function* () {
          yield disposeResources
          yield ctx.effect(() => lease.close)
        })
      })
      let consumerClosing: Promise<void> | undefined
      if (first === 'consumer') {
        consumerClosing = Promise.resolve(consumer.dispose())
        await entered.promise
      }
      let closed = false
      const closing = Promise.resolve(root.fiber.dispose()).then(() => {
        closed = true
      })
      await entered.promise
      await drainMicrotasks()
      expect(closed).toBe(false)
      expect(resourceOpen).toBe(true)
      expect(root.get('acpHostContinuity', false)).toBe(owner)
      expect(() => owner.borrow(() => undefined)).toThrow('ACP_HOST_CONTINUITY_CLOSED')
      expect(() => owner.settlements.registerSink('new-profile', {}, {})).toThrow('ACP_LOCAL_SETTLEMENT_CLOSED')
      release.resolve()
      await Promise.all([closing, consumerClosing])
      expect(cleanupCalls).toBe(1)
      expect(durable).toEqual(['tool result'])
      expect(resourceOpen).toBe(false)
      expect(root.get('acpHostContinuity', false)).toBeUndefined()
      expect(owner.executionOwners.getRecoveryFallback('session-a')).toBeUndefined()
    },
  )

  it('drains retained Host calls and their last write after the registry has closed', async () => {
    const owner = new AcpHostContinuity()
    const entered = Promise.withResolvers<void>()
    const releaseCall = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    let pending = true
    let durable: string | undefined
    const completion = releaseCall.promise.then(async () => {
      await owner.settlements.settle(
        'session-a',
        'terminal-a',
        async () => {
          entered.resolve()
          await releaseWrite.promise
          durable = 'saved'
        },
        {},
        () => undefined,
        {},
      )
      pending = false
    })
    owner.borrow(() => {
      owner.executionOwners.retain('session-a', {
        hasPendingHostCalls: () => pending,
        waitForHostCallsSettled: () => completion,
      })
    })
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    await drainMicrotasks()
    expect(closed).toBe(false)
    releaseCall.resolve()
    await entered.promise
    expect(closed).toBe(false)
    releaseWrite.resolve()
    await closing
    expect(durable).toBe('saved')
    expect(pending).toBe(false)
    await expect(owner.settlements.settlePending('session-a', {})).rejects.toThrow('ACP_LOCAL_SETTLEMENT_CLOSED')
  })

  it('stops retry timers at final shutdown and releases retained queues and waiters', async () => {
    vi.useFakeTimers()
    const owner = new AcpHostContinuity()
    const token = {}
    const retire = owner.settlements.registerSink('profile-a', token, {})
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    owner.borrow(async () => {
      entered.resolve()
      await release.promise
      await retire()
    })
    const write = vi.fn(async () => {
      throw new Error('disk offline')
    })
    try {
      const failed = expect(
        owner.settlements.settle('session-a', 'terminal-a', write, token, () => undefined, {}, 'profile-a'),
      ).rejects.toBeInstanceOf(AcpLocalSettlementError)
      await vi.advanceTimersByTimeAsync(60)
      await failed
      expect(vi.getTimerCount()).toBe(1)
      const waiting = expect(owner.settlements.wait('session-a')).rejects.toThrow('ACP_LOCAL_SETTLEMENT_CLOSED')
      const closing = owner.close()
      await entered.promise
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(write).toHaveBeenCalledTimes(3)
      release.resolve()
      await closing
      await waiting
      expect(owner.settlements.status('session-a')).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
      await owner.close()
      vi.useRealTimers()
    }
  })

  it('settles every accepted cleanup and releases state even if a registry cleanup rejects', async () => {
    const owner = new AcpHostContinuity()
    const release = Promise.withResolvers<void>()
    let finished = false
    const failed = owner.borrow(async () => {
      throw new Error('registry close failed')
    })
    owner.borrow(async () => {
      await release.promise
      await owner.settlements.settle(
        'session-a',
        'terminal-a',
        async () => {
          finished = true
        },
        {},
        () => undefined,
        {},
      )
    })
    const closing = owner.close()
    const rejected = expect(closing).rejects.toThrow('ACP Host continuity cleanup failed')
    const failedClose = expect(failed.close()).rejects.toThrow('registry close failed')
    await drainMicrotasks()
    expect(finished).toBe(false)
    release.resolve()
    await Promise.all([rejected, failedClose])
    expect(finished).toBe(true)
    expect(owner.close()).toBe(closing)
    await expect(owner.settlements.settlePending('session-a', {})).rejects.toThrow('ACP_LOCAL_SETTLEMENT_CLOSED')
  })

  it('reuses the named Host service after the adapter module is loaded again', async () => {
    const root = new Context()
    const original = ensureHostContinuity(root)
    original.executionOwners.setRecoveryFallback(recovery)
    vi.resetModules()
    const reloaded = await import('../../../src/host/composition/host-continuity.ts')
    expect(reloaded.AcpHostContinuity).not.toBe(AcpHostContinuity)
    expect(reloaded.ensureHostContinuity(root)).toBe(original)
    expect(reloaded.ensureHostContinuity(root).executionOwners.getRecoveryFallback('session-a')).toEqual(recovery)
    await root.fiber.dispose()
    expect(root.get('acpHostContinuity', false)).toBeUndefined()
  })

  it('withdraws the service even when the final close rejects', async () => {
    const root = new Context()
    const owner = ensureHostContinuity(root)
    const report = vi.spyOn(root.logger, 'error').mockImplementation(() => undefined)
    owner.borrow(async () => {
      throw new Error('registry close failed')
    })
    try {
      await root.fiber.dispose()
      expect(root.get('acpHostContinuity', false)).toBeUndefined()
      expect(report).toHaveBeenCalled()
      await expect(owner.close()).rejects.toThrow('ACP Host continuity cleanup failed')
      await expect(owner.settlements.settlePending('session-a', {})).rejects.toThrow('ACP_LOCAL_SETTLEMENT_CLOSED')
    } finally {
      report.mockRestore()
    }
  })
})
