import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AcpRemoteService } from '../../../src/remote/service.ts'
import type { AcpToolApprovalPolicySnapshot } from '../../../src/contract/remote.ts'

function setup() {
  let allowed = true
  let current: AcpToolApprovalPolicySnapshot = {
    sessionId: 'session',
    policy: 'auto',
    source: 'session',
    editable: true,
  }
  const listeners = new Set<() => void>()
  const read = vi.fn(async () => current)
  const write = vi.fn(async (_sessionId: string, policy: 'auto' | 'ask') => {
    current = { ...current, policy }
    return current
  })
  const notify = vi.fn(() => {
    for (const listener of listeners) listener()
  })
  const service = new AcpRemoteService(new Context(), {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    resolveLiveAgent: () => undefined,
    agentSessionChanges: { canRead: (id) => allowed && id === 'session', subscribe: () => () => {} },
    toolApprovalPolicy: { read, write },
    toolApprovalPolicyChanges: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      notify,
    },
  })
  return {
    service,
    read,
    write,
    notify,
    listeners,
    allow: (value: boolean) => {
      allowed = value
    },
  }
}

describe('host-owned DSH tool approval policy Remote', () => {
  it('authorizes reads and writes, validates the enum, and notifies policy followers', async () => {
    const state = setup()
    await expect(state.service.toolApprovalPolicy('foreign')).rejects.toThrow('not authorized')
    await expect(state.service.toolApprovalPolicy('session')).resolves.toMatchObject({
      policy: 'auto',
      source: 'session',
      editable: true,
    })
    await expect(state.service.setToolApprovalPolicy('session', { policy: 'ask' })).resolves.toMatchObject({
      policy: 'ask',
    })
    expect(state.write).toHaveBeenCalledWith('session', 'ask')
    expect(state.notify).toHaveBeenCalledOnce()
    await expect(state.service.setToolApprovalPolicy('session', { policy: 'invalid' as 'ask' })).rejects.toThrow(
      'Invalid DSH tool approval policy',
    )
    state.allow(false)
    await expect(state.service.setToolApprovalPolicy('session', { policy: 'auto' })).rejects.toThrow('not authorized')
  })

  it('opens with a fresh snapshot, follows updates, and rechecks ownership after wake', async () => {
    const state = setup()
    const abort = new AbortController()
    const iterator = state.service.toolApprovalPolicyFollow('session', abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'opened', snapshot: { policy: 'auto' } },
      done: false,
    })
    const next = iterator.next()
    state.write('session', 'ask').then(() => state.notify())
    await expect(next).resolves.toMatchObject({ value: { type: 'changed', snapshot: { policy: 'ask' } }, done: false })
    const pending = iterator.next()
    state.allow(false)
    state.notify()
    await expect(pending).rejects.toThrow('not authorized')
    expect(state.listeners.size).toBe(0)
    abort.abort()
  })
})
