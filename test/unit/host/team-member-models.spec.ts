import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  return {
    requestHeader: () => ({ config: { provider: 'acp-demo', model } }),
    append: vi.fn(),
  }
}

function modelControl(current: { provider: string; model: string } | undefined) {
  return { current: vi.fn(() => current), select: vi.fn() }
}

type HarnessOptions = {
  binding?: { status: 'ok'; binding: AcpBindingData } | { status: 'outdated' }
  saved?: { bindingKey: string; model: string }
  status?: string
  role?: string
  initialList?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  const agentCtx = new Context()
  contexts.push(ctx, agentCtx)
  const memberSession = session()
  const model = modelControl({ provider: 'acp-demo', model: 'model-default' })
  const agent = {
    id: 'member-1',
    options: { provider: 'acp-demo', model: 'model-default' },
    status: options.status ?? 'idle',
    session: memberSession,
    ctx: agentCtx,
    model,
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
  }
  const currentBinding = options.binding ?? { status: 'ok' as const, binding: binding() }
  const sidecar = {
    readLatestBinding: vi.fn(async () => currentBinding),
    readMemberModelSelection: vi.fn(async () => options.saved),
    writeMemberModelSelection: vi.fn(async () => undefined),
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
  const models = createMemberModels(ctx, {
    sidecar: sidecar as unknown as AcpSidecar,
    adapterFor: vi.fn(() => adapter as never),
  })
  if (options.initialList !== true) {
    live = agent
    // Native creation awaits serial listeners before releasing queued input.
    await ctx.serial('agent/created', { agent, source: 'startup' } as never)
  }
  return { ctx, agentCtx, agent, memberSession, model, agents, teams, llm, sidecar, adapter, models }
}

describe('createMemberModels()', () => {
  it('records a valid binding-scoped selection through the Agent model API before the first step', async () => {
    const current = binding()
    const { model, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-next' },
    })

    expect(model.select).toHaveBeenCalledExactlyOnceWith({ provider: 'acp-demo', model: 'model-next' })
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })

  it('ignores a selection whose binding is unavailable or belongs to another provider', async () => {
    const old = binding('acp-demo')
    const { model } = await harness({
      binding: { status: 'ok', binding: binding('acp-other') },
      saved: { bindingKey: modeIntentBindingKey(old), model: 'model-next' },
    })

    expect(model.select).not.toHaveBeenCalled()
  })

  it('writes only binding-scoped intent and records the model through the Agent', async () => {
    const current = binding()
    const { models, model, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-default' },
    })
    const authorize = vi.fn()

    await models.save('member-1', 'acp-demo', 'model-next', authorize)

    expect(authorize).toHaveBeenCalledOnce()
    expect(sidecar.writeMemberModelSelection).toHaveBeenCalledWith('member-1', {
      bindingKey: modeIntentBindingKey(current),
      model: 'model-next',
    })
    expect(model.select).toHaveBeenLastCalledWith({ provider: 'acp-demo', model: 'model-next' })
  })

  it('does not hydrate a non-teammate created agent', async () => {
    const { model } = await harness({ role: 'lead' })
    expect(model.select).not.toHaveBeenCalled()
  })

  it.each(['valid', 'outdated', 'rebound'] as const)(
    'projects only current request facts while the ACP binding stays %s',
    async (state) => {
      const { ctx, agent, teams, sidecar, memberSession } = await harness()
      memberSession.requestHeader = () => ({ config: { provider: 'acp-demo', model: 'model-used' } })
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
      model: modelControl({ provider: 'acp-demo', model: 'model-default' }),
    }
    const lead = {
      id: 'lead-1',
      options: { provider: 'acp-demo' },
      session: leadSession,
      ctx: new Context(),
      model: modelControl({ provider: 'acp-demo', model: 'model-default' }),
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
    }
    ctx.provide('agents', agents)
    ctx.provide('agentTeams', teams)
    ctx.provide('llm', llm)
    const sidecar = {
      readLatestBinding: vi.fn(async () => ({ status: 'ok' as const, binding: binding() })),
      readMemberModelSelection: vi.fn(async () => undefined),
      writeMemberModelSelection: vi.fn(async () => undefined),
    }
    const adapter = {
      agentSessionSnapshot: vi.fn(async () => ({
        modeWritable: true,
        configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
      })),
    }
    let providerReads = 0
    const readBindingProvider = vi.fn(async () => {
      providerReads++
      if (providerReads >= 3) member.status = 'running'
      return 'acp-demo'
    })
    const management = createTeamManagement(ctx, (provider) => provider === 'acp-demo', readBindingProvider, {
      sidecar: sidecar as unknown as AcpSidecar,
      adapterFor: () => adapter as never,
    })

    if (management.selectModel === undefined) throw new Error('missing selectModel helper')
    await expect(management.selectModel('lead-1', 'member-1', 'model-next')).rejects.toThrow('ACP_TEAM_MEMBER_BUSY')
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })
})
