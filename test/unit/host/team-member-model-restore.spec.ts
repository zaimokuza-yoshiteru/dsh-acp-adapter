import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentModel, modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { AcpBindingData, AcpMemberModelSelection, AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../../src/persistence/sidecar.ts'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { createMemberModels } from '../../../src/host/teams/member-models.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const route = { provider: 'acp-demo', model: 'model-a' }
  await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const empty = Session.create(SessionId('model-cold-member'))
  const source = Session.create(empty.id, [], { ...empty.header, origin: 'subagent', parentSession: SessionId('root') })
  source.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'member' })
  const sourceModel = new AgentModel(projection.readerFor(source), source, route)
  const used = (model: string) =>
    source.append('request/header', {
      header: { config: { provider: route.provider, model } },
      reason: source.requestHeader() === undefined ? 'initial' : 'change',
    })
  const binding = {
    provider: route.provider,
    agentSessionId: 'acp-model-member',
    generation: 1,
    bindingEpoch: 1,
    launchFingerprint: 'launch',
  } as unknown as AcpBindingData
  let saved: AcpMemberModelSelection | undefined
  const sidecar = {
    readLatestBinding: vi.fn(async () => ({ status: 'ok', binding })),
    readMemberModelSelection: vi.fn(async () => saved),
    writeMemberModelSelection: vi.fn(async (_id: string, value: AcpMemberModelSelection) => {
      saved = value
    }),
    clearMemberModelSelection: vi.fn(async (_id: string, value: AcpMemberModelSelection) => {
      if (JSON.stringify(saved) === JSON.stringify(value)) saved = undefined
    }),
  }
  ctx.provide('llm', { listModels: async () => [] })
  // Query is a retained, immutable cut of the actual Session/projection. It never activates an Agent.
  const observe = vi.fn(async () => {
    const session = ctx.sessions.get(source.id) ?? source
    return {
      cursor: session.seq - 1,
      projections: ctx.sessionProjections.snapshot(session),
      events: session.snapshotEvents(),
      [Symbol.dispose]() {},
    }
  })
  ctx.provide('sessionQuery', { observeSession: observe })
  const models = createMemberModels(ctx, {
    sidecar: sidecar as unknown as AcpSidecar,
    adapterFor: () => ({ agentSessionSnapshot: async () => ({ modeWritable: true }) }) as never,
  })
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush)
  const restore = (seed = source.snapshotEvents()) => {
    const restored = Session.create(source.id, seed, source.header)
    const beforePublication = restored.seq
    const detachSession = ctx.sessions.enter(restored)
    ctx.sessions.announce(restored)
    // Native Session publication does not invalidate a dormant intent's cut.
    expect(restored.seq).toBe(beforePublication)
    const model = new AgentModel(projection.readerFor(restored), restored, route)
    const agent = { id: restored.id, ctx, session: restored, model, options: route, status: 'idle' } as unknown as Agent
    const detachAgent = ctx.agents.enter(agent)
    return {
      agent,
      model,
      restored,
      announce: () => ctx.agents.announce(agent, 'resume'),
      dispose: () => {
        detachAgent()
        detachSession()
      },
    }
  }
  return {
    ctx,
    models,
    source,
    sourceModel,
    observe,
    used,
    route,
    sidecar,
    flush,
    restore,
    intent: (model: string, sessionSeq?: number): AcpMemberModelSelection => ({
      bindingKey: modeIntentBindingKey(binding),
      model,
      ...(sessionSeq === undefined
        ? {}
        : { sessionSeq, nativeSelectionKey: JSON.stringify([route.provider, sourceModel.current()?.model, null]) }),
    }),
    get saved() {
      return saved
    },
    set saved(value: AcpMemberModelSelection | undefined) {
      saved = value
    },
  }
}

describe('native teammate model restoration', () => {
  it.each(['pending', 'used'] as const)(
    'preserves a native %s choice against an ambiguous legacy sidecar',
    async (state) => {
      const h = await harness()
      h.used('model-a')
      h.saved = h.intent('model-a')
      h.sourceModel.select({ provider: h.route.provider, model: 'model-b' })
      if (state === 'used') h.used('model-b')
      const restored = h.restore()
      const seq = restored.restored.seq
      await restored.announce()
      expect(restored.model.current()?.model).toBe('model-b')
      expect(restored.restored.seq).toBe(seq)
      expect(h.flush).not.toHaveBeenCalled()
      expect(await h.models.facts(h.source.id, h.route.provider)).toMatchObject({
        currentModel: state === 'used' ? 'model-b' : 'model-a',
        pendingModel: state === 'used' ? null : 'model-b',
      })
    },
  )

  it('persists dormant intent without activation, then consumes it after native publication and flush', async () => {
    const h = await harness()
    h.sourceModel.select(h.route)
    await h.models.save(h.source.id, h.route.provider, 'model-b', () => {})
    expect(h.ctx.agents.get(h.source.id)).toBeUndefined()
    expect(h.saved).toEqual(h.intent('model-b', h.source.seq))
    const restored = h.restore()
    expect(h.saved?.sessionSeq).toBe(restored.restored.firstLiveSeq)
    await restored.announce()
    expect(h.sidecar.readMemberModelSelection).toHaveBeenCalled()
    expect(h.ctx.agents.get(h.source.id)).toBe(restored.agent)
    expect(restored.model.current()?.model).toBe('model-b')
    expect(h.flush).toHaveBeenCalledOnce()
    expect(h.saved).toBeUndefined()
  })

  it('rejects an obsolete exact cut after a native A to B to A sequence', async () => {
    const h = await harness()
    h.sourceModel.select(h.route)
    await h.models.save(h.source.id, h.route.provider, 'model-c', () => {})
    h.sourceModel.select({ provider: h.route.provider, model: 'model-b' })
    h.sourceModel.select(h.route)
    const restored = h.restore()
    await restored.announce()
    expect(restored.model.current()?.model).toBe('model-a')
    expect(h.flush).not.toHaveBeenCalled()
    expect(await h.models.facts(h.source.id, h.route.provider)).toMatchObject({ pendingModel: 'model-a' })
  })

  it.each(['model', 'request', 'activity'] as const)(
    'rejects a non-marker %s suffix even when the model value is unchanged',
    async (event) => {
      const h = await harness()
      h.sourceModel.select(h.route)
      await h.models.save(h.source.id, h.route.provider, 'model-b', () => {})
      if (event === 'model') h.source.append('model/selection', h.route)
      else if (event === 'request') h.used('model-a')
      else {
        h.source.append('turn/start', { turn: 1 })
        h.source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }
      const restored = h.restore()
      await restored.announce()
      expect(restored.model.current()?.model).toBe('model-a')
      expect(h.flush).not.toHaveBeenCalled()
    },
  )

  it('rechecks native ownership and sequence after the suffix observation awaits', async () => {
    const h = await harness()
    h.sourceModel.select(h.route)
    await h.models.save(h.source.id, h.route.provider, 'model-b', () => {})
    const restored = h.restore()
    const observed = await h.observe()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.observe.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return observed
    })
    const announcing = restored.announce()
    await entered.promise
    restored.model.select({ provider: h.route.provider, model: 'model-c' })
    release.resolve()
    await announcing
    expect(restored.model.current()?.model).toBe('model-c')
    expect(h.flush).not.toHaveBeenCalled()
  })

  it.each(['select', 'flush'] as const)('retains the exact pending intent when native %s fails', async (failure) => {
    const h = await harness()
    h.sourceModel.select(h.route)
    const intent = h.intent('model-b', h.source.seq)
    h.saved = intent
    const restored = h.restore()
    if (failure === 'select')
      vi.spyOn(restored.model, 'select').mockImplementation(() => {
        throw new Error('select failed')
      })
    else h.flush.mockRejectedValueOnce(new Error('flush failed'))
    await expect(restored.announce()).rejects.toThrow(`${failure} failed`)
    expect(h.saved).toEqual(intent)
    expect(h.sidecar.clearMemberModelSelection).not.toHaveBeenCalled()
  })

  it('retries an unapplied intent after a failed activation persisted its restore marker', async () => {
    const h = await harness()
    h.sourceModel.select(h.route)
    await h.models.save(h.source.id, h.route.provider, 'model-b', () => {})
    const pending = h.saved
    const first = h.restore()
    // AgentLoop persists this constructor suffix before agent/created dispatch.
    const persisted = first.restored.snapshotEvents()
    expect(persisted.at(-1)?.type).toBe('session/end-seed')
    vi.spyOn(first.model, 'select').mockImplementationOnce(() => {
      throw new Error('activation failed')
    })
    await expect(first.announce()).rejects.toThrow('activation failed')
    first.dispose()
    expect(h.saved).toEqual(pending)

    const second = h.restore(persisted)
    expect(second.restored.seq).toBe(persisted.length)
    expect(second.restored.firstLiveSeq).toBe(second.restored.seq)
    await second.announce()
    expect(second.model.current()?.model).toBe('model-b')
    expect(h.saved).toBeUndefined()
  })

  it('does not consume a newer intent written while native flush is pending', async () => {
    const h = await harness()
    h.sourceModel.select(h.route)
    h.saved = h.intent('model-b', h.source.seq)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.flush.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })
    const restored = h.restore()
    const announcing = restored.announce()
    await entered.promise
    const newer = h.intent('model-c', restored.restored.seq)
    h.saved = newer
    release.resolve()
    await announcing
    expect(h.saved).toEqual(newer)
  })
})
