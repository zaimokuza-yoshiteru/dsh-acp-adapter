import { describe, expect, it, vi } from 'vitest'
import {
  CrossBackendTransactionController,
  resolveCrossBackendLocation,
} from '../../../src/client/data/cross-backend-controller.ts'
import type {
  CrossBackendOperations,
  CrossBackendTicket,
} from '../../../src/client/data/cross-backend-controller.ts'

const source = { provider: 'deepseek', model: 'deepseek-chat' }
const target = { provider: 'acp-codex', model: 'gpt-5.6-mini' }

function ticket(): CrossBackendTicket {
  return {
    key: 'session-1\u0000acp-codex\u0000gpt-5.6-mini',
    sourceSessionId: 'session-1',
    sourceSelection: source,
    targetSelection: target,
    location: { workspaceId: 'workspace-1' },
  }
}

function operations(order: string[], overrides: Partial<CrossBackendOperations> = {}): CrossBackendOperations {
  return {
    restoreSource: vi.fn(async () => { order.push('restore'); return { ok: true } }),
    createDestination: vi.fn(async ({ sessionId }) => { order.push(`create:${sessionId}`); return { published: true } }),
    selectDestination: vi.fn(async () => { order.push('select'); return { ok: true } }),
    openDestination: vi.fn(async () => { order.push('open'); return { ok: true } }),
    ...overrides,
  }
}

describe('CrossBackendTransactionController', () => {
  it('resolves workspace before cwd, and falls back to cwd only when ungrouped', () => {
    expect(resolveCrossBackendLocation('s1', [{ workspaceId: 'w', sessionIds: ['s1'] }], '/tmp/project'))
      .toEqual({ workspaceId: 'w' })
    expect(resolveCrossBackendLocation('s1', [], '/tmp/project')).toEqual({ cwd: '/tmp/project' })
    expect(resolveCrossBackendLocation('s1', [], undefined)).toBeUndefined()
  })

  it('restores source before create/select/open; official destination select is last default mutation', async () => {
    const order: string[] = []
    const ops = operations(order)
    const result = await new CrossBackendTransactionController().confirm(ticket(), ops)
    expect(result.ok).toBe(true)
    expect(order).toEqual([
      'restore',
      expect.stringMatching(/^create:session-/),
      'select',
      'open',
    ])
  })

  it('does not create a second destination when create/select/open fails and is retried', async () => {
    const order: string[] = []
    let createAttempt = 0
    let selectAttempt = 0
    let openAttempt = 0
    const ops = operations(order, {
      createDestination: vi.fn(async ({ sessionId }) => {
        createAttempt += 1
        order.push(`create:${sessionId}`)
        return { published: true }
      }),
      selectDestination: vi.fn(async () => {
        selectAttempt += 1
        order.push('select')
        return selectAttempt === 1 ? { ok: false, message: 'temporary select failure' } : { ok: true }
      }),
      openDestination: vi.fn(async () => {
        openAttempt += 1
        order.push('open')
        return openAttempt === 1 ? { ok: false, message: 'temporary open failure' } : { ok: true }
      }),
    })
    const controller = new CrossBackendTransactionController()
    const first = await controller.confirm(ticket(), ops)
    expect(first.ok).toBe(false)
    const firstId = first.ok ? '' : first.failure.destinationSessionId
    const second = await controller.confirm(ticket(), ops)
    expect(second.ok).toBe(false)
    const third = await controller.confirm(ticket(), ops)
    expect(third.ok).toBe(true)
    expect(createAttempt).toBe(1)
    expect(selectAttempt).toBe(2)
    expect(openAttempt).toBe(2)
    expect(third.ok ? third.destinationSessionId : '').toBe(firstId)
  })

  it('cancel only restores source and keeps destination untouched', async () => {
    const order: string[] = []
    const ops = operations(order)
    const result = await new CrossBackendTransactionController().cancel(ticket(), ops)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['restore'])
    expect(ops.createDestination).not.toHaveBeenCalled()
  })

  it('keeps the modal decision retryable when source restore fails', async () => {
    const order: string[] = []
    const ops = operations(order, {
      restoreSource: vi.fn(async () => ({ ok: false, message: 'restore rejected' })),
    })
    const result = await new CrossBackendTransactionController().confirm(ticket(), ops)
    expect(result).toEqual({ ok: false, failure: { phase: 'restore-source', message: 'restore rejected', destinationSessionId: expect.any(String) } })
    expect(ops.createDestination).not.toHaveBeenCalled()
  })
})
