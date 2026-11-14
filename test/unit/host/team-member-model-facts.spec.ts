import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readMemberRequestModel } from '../../../src/host/teams/member-model-facts.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('native member request model facts', () => {
  it('reads actual use rather than pending intent and retains/releases a cold projection', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const session = { requestHeader: () => ({ config: { provider: 'acp-demo', model: 'model-b' } }) }
    const sessions = { get: vi.fn(() => session as never) }
    ctx.provide('sessions', sessions as never)
    expect(await readMemberRequestModel(ctx, 'child', 'acp-demo')).toBe('model-b')
    sessions.get.mockReturnValue(undefined as never)
    const dispose = vi.fn()
    const observeSession = vi.fn(async () => ({
      projections: {
        values: {
          modelSelection: {
            lastUsed: { provider: 'acp-demo', model: 'model-b' },
            next: { provider: 'acp-demo', model: 'model-c' },
          },
        },
      },
      [Symbol.dispose]: dispose,
    }))
    ctx.provide('sessionQuery', { observeSession } as never)
    expect(await readMemberRequestModel(ctx, 'child', 'acp-demo')).toBe('model-b')
    expect(dispose).toHaveBeenCalledOnce()
    expect(await readMemberRequestModel(ctx, 'child', 'acp-other')).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
