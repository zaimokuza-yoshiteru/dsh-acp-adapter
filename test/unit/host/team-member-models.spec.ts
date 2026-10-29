import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { AcpBindingData, AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../../src/persistence/sidecar.ts'
import { createMemberModels } from '../../../src/host/teams/member-models.ts'
import { createTeamManagement } from '../../../src/host/teams/management.ts'

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

function session(model = 'model-default') {
  const value = {
    seq: 0,
    requestHeader: () => ({ config: { provider: 'acp-demo', model } }),
    append: vi.fn((_type: string, _data: unknown) => {
      value.seq++
    }),
  }
  return value
}

type HarnessOptions = {
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
  const memberSession = session()
  let selection = memberSession.requestHeader().config
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
  const teams = {
    tryMembership: vi.fn(() => ({ role: options.role ?? 'teammate', root: agent, id: agent.id })),
    listMembers: vi.fn(() => [
      {
        id: agent.id,
        name: 'worker',
        role: 'teammate',
        status: 'inactive',
        model: 'model-default',
        diagnostics: [],
      },
    ]),
  }
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
      configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
    })),
  }
  ctx.provide('llm', llm)
  ctx.provide('agents', agents)
  ctx.provide('agentTeams', teams)
  ctx.provide('sessionProjections', {
    snapshot: () => ({
      values: { modelSelection: { next: selection, lastUsed: memberSession.requestHeader().config } },
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
  return { ctx, agentCtx, agent, memberSession, agents, teams, llm, sidecar, adapter, models, model, announce }
}

describe('createMemberModels()', () => {
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

  it.each(['valid', 'outdated', 'rebound'] as const)(
    'projects only current request facts while the ACP binding stays %s',
    async (state) => {
      const { ctx, agent, teams, sidecar } = await harness()
      agent.session.requestHeader = (() => ({
        config: { provider: 'acp-demo', model: 'model-used' },
      })) as typeof agent.session.requestHeader
      if (state === 'outdated') sidecar.readLatestBinding.mockResolvedValue({ status: 'outdated' })
      if (state === 'rebound') {
        sidecar.readLatestBinding
          .mockResolvedValueOnce({ status: 'ok', binding: binding() })
          .mockResolvedValueOnce({ status: 'ok', binding: { ...binding(), bindingEpoch: 2 } })
      }
      const value = teams.listMembers().map(({ id: _id, name, ...row }) => ({ target: name, ...row }))
      const decision = await ctx.waterfall(
        'tools/post-execute',
        { name: 'list_agents', arguments: {}, agent, signal: new AbortController().signal } as never,
        { isError: false, value, content: [] } as never,
        async () => ({ kind: 'accept' as const }),
      )
      expect(decision).toEqual(
        state === 'valid' ? { kind: 'accept', value: [{ ...value[0], model: 'model-used' }] } : { kind: 'accept' },
      )
      expect(agent.options.model).toBe('model-default')
      expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
    },
  )

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
      session: session(),
      ctx: new Context(),
      model: { current: () => ({ provider: 'acp-demo', model: 'model-default' }), select: vi.fn() },
    }
    const lead = {
      id: 'lead-1',
      options: { provider: 'acp-demo' },
      session: leadSession,
      ctx: new Context(),
      model: { current: () => leadSession.requestHeader().config },
    }
    contexts.push(member.ctx, lead.ctx)
    const agents = {
      get: vi.fn((id: string) => (id === 'lead-1' ? lead : id === 'member-1' ? member : undefined)),
      list: vi.fn(() => [lead, member]),
    }
    const teams = {
      tryMembership: vi.fn((agent: unknown) => (agent === lead ? { role: 'lead' } : { role: 'teammate' })),
      listMembers: vi.fn(() => [member]),
    }
    const llm = {
      listModels: vi.fn(async () => [{ id: 'model-next', name: 'Next' }]),
      resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
        provider,
        model,
      })),
    }
    ctx.provide('agents', agents)
    ctx.provide('agentTeams', teams)
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
