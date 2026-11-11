import { describe, expect, it } from 'vitest'
import { HostExecutionOwners } from '../../../src/host/composition/host-execution-owners.ts'

describe('Host execution owner registry', () => {
  it.each(['hasUncommittedHostFeedback', 'hasRetainedHostFeedback'] as const)(
    'does not certify final shutdown while %s remains after calls have drained',
    async (fact) => {
      const owners = new HostExecutionOwners()
      owners.retain('unsettled-session', {
        hasPendingHostCalls: () => false,
        [fact]: () => true,
        waitForHostCallsSettled: async () => undefined,
      })
      await expect(owners.close()).rejects.toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    },
  )

  it('isolates owners with the same session id', async () => {
    const root = new HostExecutionOwners()
    const otherRoot = new HostExecutionOwners()
    let pending = true
    let resolve!: () => void
    const settled = new Promise<void>((done) => (resolve = done))
    const owner = {
      hasPendingHostCalls: () => pending,
      waitForHostCallsSettled: () => settled,
    }

    root.retain('same-session', owner)

    expect(() => root.assertQuiescent('same-session')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    expect(() => otherRoot.assertQuiescent('same-session')).not.toThrow()
    pending = false
    resolve()
    await settled
    await Promise.resolve()
    expect(() => root.assertQuiescent('same-session')).not.toThrow()
  })

  it('releases the active gate after recovery without changing the retired owner feedback', async () => {
    const root = new HostExecutionOwners()
    let uncommitted = true
    let retained = true
    const owner = {
      hasPendingHostCalls: () => false,
      hasUncommittedHostFeedback: () => uncommitted,
      hasRetainedHostFeedback: () => retained,
      waitForHostCallsSettled: async () => undefined,
    }
    const recoveryState = {
      dshSessionId: 'feedback-session',
      kind: 'reconciliation-required' as const,
      cause: 'load-failed',
      detail: 'feedback commit uncertain',
      updatedAt: 1,
    }

    root.setRecoveryFallback(recoveryState)
    root.retain('feedback-session', owner)
    await Promise.resolve()

    expect(root.getRecoveryFallback('feedback-session')).toEqual(recoveryState)
    expect(() => root.assertQuiescent('feedback-session')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    expect(() => root.assertQuiescent('feedback-session', true)).not.toThrow()
    root.clear('feedback-session')

    expect(retained).toBe(true)
    expect(uncommitted).toBe(true)
    expect(() => root.assertQuiescent('feedback-session')).not.toThrow()
    expect(root.getRecoveryFallback('feedback-session')).toEqual(recoveryState)
  })

  it('releases a rejected settlement observer once later public facts show the call settled', async () => {
    const root = new HostExecutionOwners()
    let pending = true
    let uncommitted = false
    let reject!: (error: Error) => void
    const observed = new Promise<void>((_resolve, rejectPromise) => (reject = rejectPromise))
    const owner = {
      hasPendingHostCalls: () => pending,
      hasUncommittedHostFeedback: () => uncommitted,
      hasRetainedHostFeedback: () => uncommitted,
      waitForHostCallsSettled: () => observed,
    }

    root.retain('observer-race', owner)
    reject(new Error('settlement observer rejected while the call was pending'))
    await Promise.resolve()
    expect(() => root.assertQuiescent('observer-race')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')

    pending = false
    uncommitted = false
    expect(() => root.assertQuiescent('observer-race')).not.toThrow()
  })

  it('keeps a newer owner gate when an explicitly cleared owner finishes later', async () => {
    const owners = new HostExecutionOwners()
    const oldWait = Promise.withResolvers<void>()
    const newWait = Promise.withResolvers<void>()
    let oldFeedback = true
    let pending = true
    owners.retain('session-a', {
      hasPendingHostCalls: () => false,
      hasRetainedHostFeedback: () => oldFeedback,
      waitForHostCallsSettled: () => oldWait.promise,
    })
    owners.clear('session-a')
    owners.retain('session-a', {
      hasPendingHostCalls: () => pending,
      waitForHostCallsSettled: () => newWait.promise,
    })
    oldFeedback = false
    oldWait.resolve()
    await oldWait.promise
    expect(() => owners.assertQuiescent('session-a')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    pending = false
    newWait.resolve()
    await owners.close()
  })
})
