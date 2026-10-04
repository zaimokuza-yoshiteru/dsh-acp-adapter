import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  assertHostExecutionQuiescent,
  clearHostExecutionOwners,
  getSharedRecoveryFallback,
  retainHostExecutionOwner,
  setSharedRecoveryFallback,
} from '../../../src/host/composition/host-execution-owners.ts'

describe('Host execution owner registry', () => {
  it('shares pending owners across child contexts and isolates separate roots with the same session id', async () => {
    const root = new Context()
    const child = root.extend({})
    const otherRoot = new Context()
    let pending = true
    let resolve!: () => void
    const settled = new Promise<void>((done) => (resolve = done))
    const owner = {
      hasPendingHostCalls: () => pending,
      waitForHostCallsSettled: () => settled,
    }

    retainHostExecutionOwner(root, 'same-session', owner)

    expect(() => assertHostExecutionQuiescent(child, 'same-session')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    expect(() => assertHostExecutionQuiescent(otherRoot, 'same-session')).not.toThrow()
    pending = false
    resolve()
    await settled
    await Promise.resolve()
    expect(() => assertHostExecutionQuiescent(child, 'same-session')).not.toThrow()
  })

  it('archives retained feedback and releases the active gate without changing feedback evidence', async () => {
    const root = new Context()
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

    setSharedRecoveryFallback(root, recoveryState)
    retainHostExecutionOwner(root, 'feedback-session', owner)
    await Promise.resolve()

    expect(getSharedRecoveryFallback(root, 'feedback-session')).toEqual(recoveryState)
    expect(() => assertHostExecutionQuiescent(root, 'feedback-session')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')
    expect(() => assertHostExecutionQuiescent(root, 'feedback-session', true)).not.toThrow()
    clearHostExecutionOwners(root, 'feedback-session')

    expect(retained).toBe(true)
    expect(uncommitted).toBe(true)
    expect(() => assertHostExecutionQuiescent(root, 'feedback-session')).not.toThrow()
    expect(getSharedRecoveryFallback(root, 'feedback-session')).toEqual(recoveryState)
  })

  it('releases a rejected settlement observer once later public facts show the call settled', async () => {
    const root = new Context()
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

    retainHostExecutionOwner(root, 'observer-race', owner)
    reject(new Error('settlement observer rejected while the call was pending'))
    await Promise.resolve()
    expect(() => assertHostExecutionQuiescent(root, 'observer-race')).toThrow('ACP_HOST_EXECUTION_STILL_ACTIVE')

    pending = false
    uncommitted = false
    expect(() => assertHostExecutionQuiescent(root, 'observer-race')).not.toThrow()
  })
})
