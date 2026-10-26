import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type * as acp from '@agentclientprotocol/sdk'
import AcpPermissionPolicy, {
  type AcpExternalPolicyDecision,
  type AcpExternalPolicyRequest,
} from '../../../src/host/composition/external-permission-policy.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function facts(): acp.RequestPermissionRequest {
  return {
    sessionId: 'external-session',
    toolCall: {
      toolCallId: 'same-call',
      kind: 'execute',
      rawInput: { command: 'fixture-only', nested: { value: 'original' } },
    },
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  }
}

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(AcpPermissionPolicy)
  const session = Session.create(SessionId(`policy-${contexts.length}`))
  const agent = { ctx, session, id: session.id, status: 'running' } as Agent
  const request: AcpExternalPolicyRequest = { agent, requestId: 'request-1', profile: 'antigravity', params: facts() }
  return { ctx, fiber, agent, request, service: ctx.acpPermissionPolicy }
}

describe('explicit ACP machine policy contract', () => {
  it('exposes the real Agent and recursively readonly authorization facts', () => {
    expectTypeOf<AcpExternalPolicyRequest['agent']>().toEqualTypeOf<Agent>()
    if (false) {
      const request = {} as AcpExternalPolicyRequest
      // @ts-expect-error policy contributors cannot replace authorization facts
      request.params.sessionId = 'changed'
      // @ts-expect-error policy contributors cannot append authorization options
      request.params.options.push({ optionId: 'new', kind: 'allow_once', name: 'New' })
      // @ts-expect-error nested option identity is also readonly
      request.params.options[0]!.optionId = 'changed'
    }
  })

  it('has no default decision and never invokes the legacy approval chain', async () => {
    const f = await fixture()
    const legacy = vi.fn()
    f.ctx.on('approval/request', legacy)
    expect(await f.service.evaluate(f.request)).toBe('not-applicable')
    expect(legacy).not.toHaveBeenCalled()
  })

  it.each(['allow-once', 'deny-once', 'not-applicable', 'cancelled', 'failed'] as const)(
    'preserves the declared %s decision without mapping option IDs',
    async (decision) => {
      const f = await fixture()
      f.ctx.on('dsh-acp/permission-policy', async () => decision)
      expect(await f.service.evaluate(f.request)).toBe(decision)
    },
  )

  it.each(['allow-always', '', undefined, null, true, { outcome: 'allow-once' }])(
    'fails closed for invalid provider result %j',
    async (decision) => {
      const f = await fixture()
      f.ctx.on('dsh-acp/permission-policy', async () => decision as AcpExternalPolicyDecision)
      expect(await f.service.evaluate(f.request)).toBe('failed')
    },
  )

  it('contains provider exceptions without exposing their details', async () => {
    const f = await fixture()
    f.ctx.on('dsh-acp/permission-policy', () => {
      throw new Error('private provider diagnostic')
    })
    expect(await f.service.evaluate(f.request)).toBe('failed')
  })

  it('captures JSON facts synchronously before dispatch while preserving live Agent identity', async () => {
    const f = await fixture()
    const original = facts()
    const request = { ...f.request, params: original }
    let captured: AcpExternalPolicyRequest | undefined
    f.ctx.on('dsh-acp/permission-policy', async (input) => {
      captured = input
      return 'allow-once'
    })
    const pending = f.service.evaluate(request)
    request.profile = 'devin'
    request.requestId = 'changed'
    original.options[0]!.optionId = 'changed'
    ;(original.toolCall.rawInput as { nested: { value: string } }).nested.value = 'changed'
    expect(await pending).toBe('allow-once')
    expect(captured?.agent).toBe(f.agent)
    expect(Object.isFrozen(f.agent)).toBe(false)
    expect(captured).toMatchObject({
      profile: 'antigravity',
      requestId: 'request-1',
      params: {
        options: [{ optionId: 'once' }, { optionId: 'always' }, { optionId: 'deny' }],
        toolCall: { rawInput: { nested: { value: 'original' } } },
      },
    })
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured?.params)).toBe(true)
    expect(Object.isFrozen(captured?.params.options)).toBe(true)
    expect(Object.isFrozen(captured?.params.options[0])).toBe(true)
    expect(Object.isFrozen(captured?.params.toolCall.rawInput)).toBe(true)
  })

  it('cannot mutate the policy snapshot or original nested request', async () => {
    const f = await fixture()
    f.ctx.on('dsh-acp/permission-policy', async (request) => {
      ;(request.params.toolCall.rawInput as { nested: { value: string } }).nested.value = 'changed'
      return 'allow-once'
    })
    expect(await f.service.evaluate(f.request)).toBe('failed')
    expect(f.request.params.toolCall.rawInput).toMatchObject({ nested: { value: 'original' } })
  })

  it.each([new Map([['value', 'mutable']]), () => 'not JSON'])(
    'rejects facts that cannot provide an immutable JSON snapshot',
    async (rawInput) => {
      const f = await fixture()
      const provider = vi.fn(async (): Promise<AcpExternalPolicyDecision> => 'allow-once')
      f.ctx.on('dsh-acp/permission-policy', provider)
      expect(
        await f.service.evaluate({ ...f.request, params: { ...facts(), toolCall: { toolCallId: 'bad', rawInput } } }),
      ).toBe('failed')
      expect(provider).not.toHaveBeenCalled()
    },
  )

  it('uses registration order and explicit next delegation, without a global deny override', async () => {
    const f = await fixture()
    const order: string[] = []
    f.ctx.on('dsh-acp/permission-policy', async (_request, next) => {
      order.push('defer')
      return next()
    })
    const removeAllow = f.ctx.on('dsh-acp/permission-policy', async () => {
      order.push('allow')
      return 'allow-once'
    })
    f.ctx.on('dsh-acp/permission-policy', async () => {
      order.push('deny')
      return 'deny-once'
    })
    expect(await f.service.evaluate(f.request)).toBe('allow-once')
    expect(order).toEqual(['defer', 'allow'])
    removeAllow()
    order.length = 0
    expect(await f.service.evaluate(f.request)).toBe('deny-once')
    expect(order).toEqual(['defer', 'deny'])
  })

  it('preserves Cordis prepend priority and explicit not-applicable as a terminal abstention', async () => {
    const f = await fixture()
    const allow = vi.fn(async (): Promise<AcpExternalPolicyDecision> => 'allow-once')
    f.ctx.on('dsh-acp/permission-policy', allow)
    f.ctx.on('dsh-acp/permission-policy', async () => 'not-applicable', { prepend: true })
    expect(await f.service.evaluate(f.request)).toBe('not-applicable')
    expect(allow).not.toHaveBeenCalled()
  })

  it('routes policy contributors by actual Agent scope, including ancestors and excluding siblings', async () => {
    const f = await fixture()
    const other = { ...f.agent, id: SessionId('other') } as Agent
    const ancestor = {}
    const parentScope = createScope(f.ctx, ancestor)
    const targetScope = createScope(f.ctx, f.agent, { parent: ancestor })
    const siblingScope = createScope(f.ctx, other, { parent: ancestor })
    const seen: string[] = []
    parentScope.ctx.on('dsh-acp/permission-policy', async (request, next) => {
      expect(request.agent).toBe(f.agent)
      seen.push('ancestor')
      return next()
    })
    targetScope.ctx.on('dsh-acp/permission-policy', async (request) => {
      expect(request.agent).toBe(f.agent)
      seen.push('target')
      return 'deny-once'
    })
    siblingScope.ctx.on('dsh-acp/permission-policy', async () => {
      seen.push('sibling')
      return 'allow-once'
    })
    expect(await f.service.evaluate(f.request)).toBe('deny-once')
    expect(seen).toEqual(['ancestor', 'target'])
  })

  it('keeps concurrent requests with equal call IDs isolated', async () => {
    const f = await fixture()
    const second = { ...f.agent, id: SessionId('second') } as Agent
    const firstGate = Promise.withResolvers<AcpExternalPolicyDecision>()
    const secondGate = Promise.withResolvers<AcpExternalPolicyDecision>()
    const firstStarted = Promise.withResolvers<void>()
    const secondStarted = Promise.withResolvers<void>()
    f.ctx.on('dsh-acp/permission-policy', async (request) => {
      if (request.agent === f.agent) {
        firstStarted.resolve()
        return firstGate.promise
      }
      expect(request.agent).toBe(second)
      secondStarted.resolve()
      return secondGate.promise
    })
    const first = f.service.evaluate(f.request)
    const other = f.service.evaluate({ ...f.request, agent: second, requestId: 'request-2' })
    await Promise.all([firstStarted.promise, secondStarted.promise])
    secondGate.resolve('deny-once')
    expect(await other).toBe('deny-once')
    firstGate.resolve('allow-once')
    expect(await first).toBe('allow-once')
  })

  it('does not dispatch a request already cancelled before evaluation', async () => {
    const f = await fixture()
    const provider = vi.fn(async (): Promise<AcpExternalPolicyDecision> => 'allow-once')
    f.ctx.on('dsh-acp/permission-policy', provider)
    expect(await f.service.evaluate({ ...f.request, signal: AbortSignal.abort() })).toBe('cancelled')
    expect(provider).not.toHaveBeenCalled()
  })

  it('does not dispatch when cancellation occurs before the queued callback', async () => {
    const f = await fixture()
    const provider = vi.fn(async (): Promise<AcpExternalPolicyDecision> => 'allow-once')
    f.ctx.on('dsh-acp/permission-policy', provider)
    const controller = new AbortController()
    const pending = f.service.evaluate({ ...f.request, signal: controller.signal })
    controller.abort()
    expect(await pending).toBe('cancelled')
    expect(provider).not.toHaveBeenCalled()
  })

  it('cancels immediately and ignores a provider that later allows', async () => {
    const f = await fixture()
    const gate = Promise.withResolvers<AcpExternalPolicyDecision>()
    const started = Promise.withResolvers<AbortSignal | undefined>()
    f.ctx.on('dsh-acp/permission-policy', async (request) => {
      started.resolve(request.signal)
      return gate.promise
    })
    const controller = new AbortController()
    const pending = f.service.evaluate({ ...f.request, signal: controller.signal })
    const signal = await started.promise
    controller.abort()
    expect(await pending).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
    gate.resolve('allow-once')
  })

  it('service disposal cancels accepted callers and waits for cooperative provider cleanup', async () => {
    const f = await fixture()
    const started = Promise.withResolvers<AbortSignal | undefined>()
    const cleanup = Promise.withResolvers<AcpExternalPolicyDecision>()
    f.ctx.on('dsh-acp/permission-policy', async (request) => {
      started.resolve(request.signal)
      return cleanup.promise
    })
    const pending = f.service.evaluate(f.request)
    const signal = await started.promise
    let disposed = false
    const disposal = f.fiber.dispose().then(() => {
      disposed = true
    })
    expect(await pending).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    expect(await f.service.evaluate(f.request)).toBe('cancelled')
    cleanup.resolve('allow-once')
    await disposal
    expect(disposed).toBe(true)
  })
})
