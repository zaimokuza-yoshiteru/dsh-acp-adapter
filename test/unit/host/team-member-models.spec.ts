import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { AcpBindingData, AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../../src/persistence/sidecar.ts'
import { createMemberModels } from '../../../src/host/teams/member-models.ts'
import { createTeamManagement } from '../../../src/host/teams/management.ts'
import type { AcpConfigOption } from '../../../src/contract/remote.ts'
import { ACP_CURRENT_CONFIG_MODEL_ID, acpDeclaredModelRoute } from '../../../src/contract/model-selection.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function binding(provider = 'acp-demo'): AcpBindingData {
  return {
    provider,
    agentSessionId: 'native-member',
    generation: 1,
    bindingEpoch: 1,
    launchFingerprint: 'launch-1',
  } as unknown as AcpBindingData
}

function session(model = 'model-default', requested = true) {
  const value = {
    seq: 0,
    header: { origin: 'subagent', parentSession: 'lead-1' },
    isOwnSeq: () => true,
    requestHeader: () => (requested ? { config: { provider: 'acp-demo', model } } : undefined),
    append: vi.fn((_type: string, _data: unknown) => {
      value.seq++
    }),
  }
  return value
}

type HarnessOptions = {
  requested?: boolean
  configOptions?: readonly AcpConfigOption[]
  binding?: { status: 'ok'; binding: AcpBindingData } | { status: 'outdated' }
  saved?: { bindingKey: string; model: string; sessionSeq?: number; nativeSelectionKey?: string }
  status?: string
  role?: string
  initialList?: boolean
  deferCreation?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  const agentCtx = new Context()
  contexts.push(ctx, agentCtx)
  const memberSession = session('model-default', options.requested === true)
  let selection = { provider: 'acp-demo', model: 'model-default' }
  const model = {
    current: () => selection,
    select: vi.fn((next: typeof selection) => {
      if (selection.provider === next.provider && selection.model === next.model) return
      selection = next
      memberSession.append('model/selection', next)
    }),
  }
  const agent = {
    id: 'member-1',
    options: { provider: 'acp-demo', model: 'model-default' },
    status: options.status ?? 'idle',
    session: memberSession,
    model,
    ctx: agentCtx,
  } as unknown as Agent
  let live = options.initialList === true ? agent : undefined
  const agents = {
    get: vi.fn((id: string) => (id === agent.id ? live : undefined)),
    list: vi.fn(() => (live === undefined ? [] : [live])),
  }
  const subagents = {
    rootOf: vi.fn((_agent: unknown) => agent),
    namesOf: vi.fn(() => ({ self: 'worker' })),
    listDescendants: vi.fn(async () => [
      { kind: 'child', id: agent.id, parentId: 'lead-1', mode: 'continuable', path: 'worker', label: 'worker' },
    ]),
  }
  if (options.role === 'lead') Object.assign(memberSession.header, { origin: undefined })
  const llm = {
    listModels: vi.fn(async () => [
      { id: 'model-default', name: 'Default' },
      { id: 'model-next', name: 'Next' },
    ]),
    resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
      provider,
      model,
      reasoningEffort: 'medium',
    })),
  }
  const currentBinding = options.binding ?? { status: 'ok' as const, binding: binding() }
  const sidecar = {
    readLatestBinding: vi.fn(async () => currentBinding),
    readMemberModelSelection: vi.fn(async () => options.saved),
    writeMemberModelSelection: vi.fn(async () => undefined),
    clearMemberModelSelection: vi.fn(async () => undefined),
  }
  const adapter = {
    agentSessionSnapshot: vi.fn(async () => ({
      modeWritable: true,
      configOptions: options.configOptions ?? [
        { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'model-default', options: [] },
      ],
    })),
  }
  ctx.provide('llm', llm)
  ctx.provide('agents', agents)
  ctx.provide('subagents', subagents as never)
  ctx.provide('sessionProjections', {
    snapshot: () => ({
      values: {
        modelSelection: { next: selection, lastUsed: memberSession.requestHeader()?.config },
        subagent: { seq: 0, mode: 'continuable', label: 'worker' },
        acpExecution: { externalSubagent: false },
      },
    }),
  })
  const models = createMemberModels(ctx, {
    sidecar: sidecar as unknown as AcpSidecar,
    adapterFor: vi.fn(() => adapter as never),
  })
  const announce = async () => {
    live = agent
    await ctx.serial('agent/created', { agent, source: 'startup' })
  }
  if (options.initialList !== true && options.deferCreation !== true) await announce()
  return { ctx, agentCtx, agent, memberSession, agents, subagents, llm, sidecar, adapter, models, model, announce }
}

describe('createMemberModels()', () => {
  it('restores the committed model after it disappears from discovery while refusing another model', async () => {
    const h = await harness({ requested: true })
    h.model.select({ provider: 'acp-demo', model: 'model-next' })
    const lead = { id: 'lead-1', model: { current: () => ({ provider: 'acp-demo', model: 'model-default' }) } }
    h.agents.get.mockImplementation((id) =>
      id === 'lead-1' ? (lead as never) : id === h.agent.id ? h.agent : undefined,
    )
    h.subagents.rootOf.mockImplementation(() => lead as never)
    h.llm.listModels.mockResolvedValue([{ id: 'model-next', name: 'Next' }])
    const management = createTeamManagement(
      h.ctx,
      (provider) => provider === 'acp-demo',
      async () => 'acp-demo',
      {
        sidecar: h.sidecar as unknown as AcpSidecar,
        adapterFor: () => h.adapter as never,
      },
    )
    await expect(management.models!('lead-1', h.agent.id)).resolves.toMatchObject({
      currentModel: 'model-default',
      pendingModel: 'model-next',
      unavailableReason: 'model-switch',
      models: [
        { id: 'model-next', name: 'Next' },
        { id: 'model-default', name: 'model-default' },
      ],
    })
    await expect(management.selectModel!('lead-1', h.agent.id, 'model-next')).rejects.toMatchObject({
      code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
    })
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    await expect(management.selectModel!('lead-1', h.agent.id, 'model-default')).resolves.toMatchObject({
      currentModel: 'model-default',
      pendingModel: null,
    })
    expect(h.agent.model.current()?.model).toBe('model-default')
    expect(h.sidecar.writeMemberModelSelection).toHaveBeenCalledExactlyOnceWith(
      h.agent.id,
      expect.objectContaining({ model: 'model-default' }),
    )
  })

  it.each([undefined, 'agent-specific'])(
    'does not infer a model from an opaque id with category %s',
    async (category) => {
      const h = await harness({
        configOptions: [
          {
            id: 'model',
            name: 'Agent setting',
            type: 'select',
            currentValue: 'unrelated-agent-value',
            options: [],
            ...(category === undefined ? {} : { category }),
          },
        ],
      })
      h.model.select({ provider: 'acp-demo', model: ACP_CURRENT_CONFIG_MODEL_ID })

      await expect(h.models.facts(h.agent.id, 'acp-demo')).resolves.toMatchObject({
        currentModel: ACP_CURRENT_CONFIG_MODEL_ID,
        pendingModel: null,
      })
    },
  )

  it('uses the current-configuration route when the Agent exposes no model selector', async () => {
    const h = await harness({ configOptions: [] })
    h.model.select({ provider: 'acp-demo', model: ACP_CURRENT_CONFIG_MODEL_ID })

    await expect(h.models.facts(h.agent.id, 'acp-demo')).resolves.toMatchObject({
      currentModel: ACP_CURRENT_CONFIG_MODEL_ID,
      pendingModel: null,
    })
  })

  it.each([ACP_CURRENT_CONFIG_MODEL_ID, 'dsh-acp:model:custom'])(
    'encodes the declared Agent value %s in member facts',
    async (value) => {
      const h = await harness({
        configOptions: [
          { id: 'engine', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [] },
        ],
      })
      const route = acpDeclaredModelRoute(value)
      h.model.select({ provider: 'acp-demo', model: route })

      await expect(h.models.facts(h.agent.id, 'acp-demo')).resolves.toMatchObject({
        currentModel: route,
        pendingModel: null,
      })
      expect(route).not.toBe(ACP_CURRENT_CONFIG_MODEL_ID)
    },
  )

  it('keeps the committed request route ahead of a different reported Agent configuration', async () => {
    const h = await harness({
      requested: true,
      configOptions: [
        {
          id: 'engine',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: ACP_CURRENT_CONFIG_MODEL_ID,
          options: [],
        },
      ],
    })

    await expect(h.models.facts(h.agent.id, 'acp-demo')).resolves.toMatchObject({
      currentModel: 'model-default',
      pendingModel: null,
      unavailableReason: 'model-switch',
    })
  })

  it('rejects an existing member model change before saving intent or changing native selection', async () => {
    const h = await harness({ requested: true })
    await expect(h.models.facts(h.agent.id, 'acp-demo')).resolves.toMatchObject({
      currentModel: 'model-default',
      unavailableReason: 'model-switch',
    })
    await expect(h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})).rejects.toMatchObject({
      code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
    })
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('rejects a model change if the first request finishes between the live cut and the save boundary', async () => {
    const h = await harness()
    vi.spyOn(h.memberSession, 'requestHeader').mockImplementationOnce(() => {
      queueMicrotask(() => {
        h.memberSession.requestHeader = () => ({ config: { provider: 'acp-demo', model: 'model-default' } })
        h.memberSession.append('request', {})
        Object.assign(h.agent, { status: 'idle' })
      })
      return undefined
    })

    await expect(h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})).rejects.toMatchObject({
      code: 'ACP_MODEL_SWITCH_UNAVAILABLE',
    })
    expect(h.memberSession.seq).toBe(1)
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('preserves a native selection changed between the live cut and the save boundary', async () => {
    const h = await harness()
    vi.spyOn(h.memberSession, 'requestHeader').mockImplementationOnce(() => {
      queueMicrotask(() => h.model.select({ provider: 'acp-demo', model: 'newer-choice' }))
      return undefined
    })

    await expect(h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})).rejects.toThrow(
      'ACP_TEAM_MODEL_SELECTION_CHANGED',
    )
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).toHaveBeenCalledOnce()
    expect(h.agent.model.current()?.model).toBe('newer-choice')
  })

  it('rejects a replacement native Session even when its sequence and selection match the observed cut', async () => {
    const h = await harness()
    vi.spyOn(h.memberSession, 'requestHeader').mockImplementationOnce(() => {
      queueMicrotask(() =>
        h.agents.get.mockReturnValue({ ...h.agent, session: session('model-default', false) } as unknown as Agent),
      )
      return undefined
    })

    await expect(h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})).rejects.toThrow(
      'ACP_TEAM_MODEL_SELECTION_CHANGED',
    )
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('rechecks a newly live member after the dormant observation was captured', async () => {
    const h = await harness({ deferCreation: true })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const dispose = vi.fn()
    h.ctx.provide('sessionQuery', {
      observeSession: async () => {
        const observation = {
          cursor: -1,
          projections: { values: { modelSelection: { next: { provider: 'acp-demo', model: 'model-default' } } } },
          [Symbol.dispose]: dispose,
        }
        entered.resolve()
        await release.promise
        return observation
      },
    })
    const saving = h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})
    const rejected = expect(saving).rejects.toMatchObject({ code: 'ACP_MODEL_SWITCH_UNAVAILABLE' })
    await entered.promise
    h.memberSession.requestHeader = () => ({ config: { provider: 'acp-demo', model: 'model-default' } })
    h.memberSession.append('request', {})
    h.agents.get.mockReturnValue(h.agent)
    release.resolve()

    await rejected
    expect(dispose).toHaveBeenCalledOnce()
    expect(h.sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('does not hydrate an old pending model change into an already used member', async () => {
    const current = binding()
    const h = await harness({
      requested: true,
      binding: { status: 'ok', binding: current },
      saved: {
        bindingKey: modeIntentBindingKey(current),
        model: 'model-next',
        sessionSeq: 0,
        nativeSelectionKey: JSON.stringify(['acp-demo', 'model-default', null]),
      },
    })
    expect(h.model.select).not.toHaveBeenCalled()
    expect(h.sidecar.clearMemberModelSelection).not.toHaveBeenCalled()
    expect(await h.models.facts(h.agent.id, 'acp-demo')).toMatchObject({
      currentModel: 'model-default',
      pendingModel: 'model-next',
      unavailableReason: 'model-switch',
    })
    await h.models.save(h.agent.id, 'acp-demo', 'model-default', () => {})
    expect(h.sidecar.writeMemberModelSelection).toHaveBeenCalledWith(
      h.agent.id,
      expect.objectContaining({ model: 'model-default' }),
    )
  })
  it('hydrates the owner selection before creation completes and leaves default resolution to the native loop', async () => {
    const current = binding()
    const { agentCtx, agent, llm, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: {
        bindingKey: modeIntentBindingKey(current),
        model: 'model-next',
        sessionSeq: 0,
        nativeSelectionKey: JSON.stringify(['acp-demo', 'model-default', null]),
      },
    })

    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], variables: {} },
      {},
      async (): Promise<PromptAssembly> => ({ sections: [], contexts: [], tools: [], variables: { preserved: 'yes' } }),
    )
    expect(assembled.variables).toEqual({ preserved: 'yes' })
    expect(agent.model.current()).toEqual({ provider: 'acp-demo', model: 'model-next' })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()

    const routed = await agentCtx.waterfall(
      'agent/request',
      { agent: {} as Agent, turn: 1, step: 0, signal: new AbortController().signal },
      async (): Promise<LlmCallConfig> => ({
        provider: 'acp-demo',
        model: 'model-default',
        reasoningEffort: ReasoningEffortId('high'),
        temperature: 0.2,
      }),
    )
    expect(routed).toEqual({ provider: 'acp-demo', model: 'model-default', reasoningEffort: 'high', temperature: 0.2 })
  })

  it('ignores a selection whose binding is unavailable or belongs to another provider', async () => {
    const old = binding('acp-demo')
    const { agentCtx, llm } = await harness({
      binding: { status: 'ok', binding: binding('acp-other') },
      saved: { bindingKey: modeIntentBindingKey(old), model: 'model-next' },
    })

    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], variables: {} },
      {},
      async (): Promise<PromptAssembly> => ({ sections: [], contexts: [], tools: [], variables: { preserved: 'yes' } }),
    )
    expect(assembled.variables).toEqual({ preserved: 'yes' })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('writes only binding-scoped intent and appends projection without touching a global default', async () => {
    const current = binding()
    const { models, memberSession, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-default' },
    })
    const authorize = vi.fn()

    await models.save('member-1', 'acp-demo', 'model-next', authorize)

    expect(authorize).toHaveBeenCalledOnce()
    expect(sidecar.writeMemberModelSelection).toHaveBeenCalledWith('member-1', {
      bindingKey: modeIntentBindingKey(current),
      model: 'model-next',
      sessionSeq: 0,
      nativeSelectionKey: JSON.stringify(['acp-demo', 'model-default', null]),
    })
    expect(memberSession.append).toHaveBeenCalledWith('model/selection', { provider: 'acp-demo', model: 'model-next' })
  })

  it.each(['agent', 'session', 'selection'] as const)(
    'retains saved intent without applying it after the admitted %s changes at the write await',
    async (replacement) => {
      const h = await harness()
      const replacementSelect = vi.fn()
      h.sidecar.writeMemberModelSelection.mockImplementationOnce(async () => {
        if (replacement === 'agent') {
          const next = { ...h.agent, model: { ...h.agent.model, select: replacementSelect } } as Agent
          h.agents.get.mockImplementation((id) => (id === h.agent.id ? next : undefined))
        } else if (replacement === 'session') {
          Object.assign(h.agent, { session: { ...h.memberSession } })
        } else h.model.select({ provider: 'acp-demo', model: 'model-newer' })
      })
      await expect(h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})).rejects.toThrow(
        'ACP_TEAM_MODEL_SELECTION_CHANGED',
      )
      expect(h.sidecar.writeMemberModelSelection).toHaveBeenCalledOnce()
      expect(h.sidecar.clearMemberModelSelection).not.toHaveBeenCalled()
      expect(replacementSelect).not.toHaveBeenCalled()
      expect(h.agent.model.current()?.model).toBe(replacement === 'selection' ? 'model-newer' : 'model-default')
    },
  )

  it('records native pending selection if an admitted save races with the member starting', async () => {
    const h = await harness()
    h.sidecar.writeMemberModelSelection.mockImplementationOnce(async () => {
      Object.assign(h.agent, { status: 'running' })
    })
    await h.models.save(h.agent.id, 'acp-demo', 'model-next', () => {})
    expect(h.agent.model.current()?.model).toBe('model-next')
    expect(h.memberSession.append).toHaveBeenCalledWith('model/selection', {
      provider: 'acp-demo',
      model: 'model-next',
    })
  })

  it('does not install model selection for a non-teammate created agent', async () => {
    const { agentCtx, llm } = await harness({ role: 'lead' })
    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], variables: {} },
      {},
      async (): Promise<PromptAssembly> => ({ sections: [], contexts: [], tools: [], variables: { preserved: 'yes' } }),
    )
    expect(assembled.variables).toEqual({ preserved: 'yes' })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('holds creation until saved selection resolves and ignores late completion after owner disposal', async () => {
    const current = binding()
    const h = await harness({ deferCreation: true })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ bindingKey: string; model: string }>()
    h.sidecar.readMemberModelSelection.mockImplementation(async () => {
      entered.resolve()
      return await release.promise
    })
    const creation = h.announce()
    await entered.promise
    expect(h.model.select).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
    release.resolve({ bindingKey: modeIntentBindingKey(current), model: 'model-next' })
    await creation
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('does not use the sidecar again after disposal while its binding read was waiting', async () => {
    const h = await harness({ deferCreation: true })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ status: 'ok'; binding: AcpBindingData }>()
    h.sidecar.readLatestBinding.mockImplementation(async () => {
      entered.resolve()
      return await release.promise
    })
    const creation = h.announce()
    await entered.promise
    await h.ctx.fiber.dispose()
    release.resolve({ status: 'ok', binding: binding() })
    await creation
    expect(h.sidecar.readMemberModelSelection).not.toHaveBeenCalled()
    expect(h.model.select).not.toHaveBeenCalled()
  })

  it('preserves a newer owner choice made while binding hydration was waiting', async () => {
    const h = await harness({ deferCreation: true })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ bindingKey: string; model: string }>()
    h.sidecar.readMemberModelSelection.mockImplementation(async () => {
      entered.resolve()
      return await release.promise
    })
    const creation = h.announce()
    await entered.promise
    h.model.select({ provider: 'acp-demo', model: 'newer-choice' })
    release.resolve({ bindingKey: modeIntentBindingKey(binding()), model: 'model-next' })
    await creation
    expect(h.agent.model.current()?.model).toBe('newer-choice')
    expect(h.model.select).toHaveBeenCalledOnce()
  })

  it('preserves the durable owner selection of a member already live when the plugin mounts', async () => {
    const h = await harness({
      initialList: true,
      saved: { bindingKey: modeIntentBindingKey(binding()), model: 'model-next' },
    })
    expect(h.agent.model.current()?.model).toBe('model-default')
    expect(h.sidecar.readMemberModelSelection).not.toHaveBeenCalled()
  })

  it('keeps team permission and busy checks in the real management facade', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const leadSession = session()
    const member = {
      id: 'member-1',
      role: 'teammate',
      status: 'inactive',
      name: 'Member',
      options: { provider: 'acp-demo' },
      session: session('model-default', false),
      ctx: new Context(),
      model: { current: () => ({ provider: 'acp-demo', model: 'model-default' }), select: vi.fn() },
    }
    const lead = {
      id: 'lead-1',
      options: { provider: 'acp-demo' },
      session: leadSession,
      ctx: new Context(),
      model: { current: () => leadSession.requestHeader()!.config },
    }
    contexts.push(member.ctx, lead.ctx)
    const agents = {
      get: vi.fn((id: string) => (id === 'lead-1' ? lead : id === 'member-1' ? member : undefined)),
      list: vi.fn(() => [lead, member]),
    }
    const subagents = {
      rootOf: () => lead,
      namesOf: () => ({ self: 'worker' }),
      listDescendants: async () => [
        { kind: 'child', id: member.id, parentId: lead.id, mode: 'continuable', path: 'worker' },
      ],
    }
    const llm = {
      listModels: vi.fn(async () => [{ id: 'model-next', name: 'Next' }]),
      resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
        provider,
        model,
      })),
    }
    ctx.provide('agents', agents)
    ctx.provide('subagents', subagents as never)
    ctx.provide('sessionProjections', {
      snapshot: () => ({
        values: {
          subagent: { seq: 0, mode: 'continuable' },
          acpExecution: { externalSubagent: false },
          modelSelection: { next: null },
        },
      }),
    } as never)
    ctx.provide('llm', llm)
    let bindingReads = 0
    const sidecar = {
      readLatestBinding: vi.fn(async () => {
        bindingReads++
        if (bindingReads >= 2) member.status = 'running'
        return { status: 'ok' as const, binding: binding() }
      }),
      readMemberModelSelection: vi.fn(async () => undefined),
      writeMemberModelSelection: vi.fn(async () => undefined),
      clearMemberModelSelection: vi.fn(async () => undefined),
    }
    const adapter = {
      agentSessionSnapshot: vi.fn(async () => ({
        modeWritable: true,
        configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
      })),
    }
    const management = createTeamManagement(
      ctx,
      (provider) => provider === 'acp-demo',
      async () => 'acp-demo',
      { sidecar: sidecar as unknown as AcpSidecar, adapterFor: () => adapter as never },
    )

    if (management.selectModel === undefined) throw new Error('missing selectModel helper')
    await expect(management.selectModel('lead-1', 'member-1', 'model-next')).rejects.toThrow('ACP_TEAM_MEMBER_BUSY')
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })
})
