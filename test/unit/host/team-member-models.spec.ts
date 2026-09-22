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
  return {
    requestHeader: () => ({ config: { provider: 'acp-demo', model } }),
    append: vi.fn(),
  }
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
  const agent = {
    id: 'member-1',
    options: { provider: 'acp-demo', model: 'model-default' },
    status: options.status ?? 'idle',
    session: memberSession,
    ctx: agentCtx,
  } as unknown as Agent
  let live = options.initialList === true ? agent : undefined
  const agents = {
    get: vi.fn((id: string) => id === agent.id ? live : undefined),
    list: vi.fn(() => live === undefined ? [] : [live]),
  }
  const teams = {
    tryMembership: vi.fn(() => ({ role: options.role ?? 'teammate' })),
  }
  const llm = {
    listModels: vi.fn(async () => [{ id: 'model-default', name: 'Default' }, { id: 'model-next', name: 'Next' }]),
    resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({
      provider, model, reasoningEffort: 'medium',
    })),
  }
  const currentBinding = options.binding ?? { status: 'ok' as const, binding: binding() }
  const sidecar = {
    readLatestBinding: vi.fn(async () => currentBinding),
    readMemberModelSelection: vi.fn(async () => options.saved),
    writeMemberModelSelection: vi.fn(async () => undefined),
  }
  const adapter = { agentSessionSnapshot: vi.fn(async () => ({
    modeWritable: true,
    configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
  })) }
  ctx.provide('llm', llm)
  ctx.provide('agents', agents)
  ctx.provide('agentTeams', teams)
  const models = createMemberModels(ctx, {
    sidecar: sidecar as unknown as AcpSidecar,
    adapterFor: vi.fn(() => adapter as never),
  })
  if (options.initialList !== true) {
    live = agent
    ctx.emit('agent/created', { agent, source: 'startup' })
  }
  return { ctx, agentCtx, agent, memberSession, agents, teams, llm, sidecar, adapter, models }
}

describe('createMemberModels()', () => {
  it('hydrates the native helper from a valid binding and resolves the selected model defaults', async () => {
    const current = binding()
    const { agentCtx, llm, sidecar } = await harness({
      binding: { status: 'ok', binding: current },
      saved: { bindingKey: modeIntentBindingKey(current), model: 'model-next' },
    })

    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble', { sections: [], contexts: [], tools: [], variables: {} }, {},
      async (): Promise<PromptAssembly> => ({ sections: [], contexts: [], tools: [], variables: { preserved: 'yes' } }),
    )
    expect(assembled.variables).toMatchObject({ preserved: 'yes', provider: 'acp-demo', model: 'model-next' })
    expect(llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'acp-demo', model: 'model-next' })
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()

    const routed = await agentCtx.waterfall(
      'agent/request', { agent: {} as Agent, turn: 1, step: 0, signal: new AbortController().signal },
      async (): Promise<LlmCallConfig> => ({ provider: 'acp-demo', model: 'model-default', reasoningEffort: ReasoningEffortId('high'), temperature: 0.2 }),
    )
    expect(routed).toEqual({ provider: 'acp-demo', model: 'model-next', reasoningEffort: 'medium', temperature: 0.2 })
  })

  it('ignores a selection whose binding is unavailable or belongs to another provider', async () => {
    const old = binding('acp-demo')
    const { agentCtx, llm } = await harness({
      binding: { status: 'ok', binding: binding('acp-other') },
      saved: { bindingKey: modeIntentBindingKey(old), model: 'model-next' },
    })

    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble', { sections: [], contexts: [], tools: [], variables: {} }, {},
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
      bindingKey: modeIntentBindingKey(current), model: 'model-next',
    })
    expect(memberSession.append).toHaveBeenCalledWith('model/selection', { provider: 'acp-demo', model: 'model-next' })
  })

  it('does not install model selection for a non-teammate created agent', async () => {
    const { agentCtx, llm } = await harness({ role: 'lead' })
    const assembled = await agentCtx.waterfall(
      'system-prompt/assemble', { sections: [], contexts: [], tools: [], variables: {} }, {},
      async (): Promise<PromptAssembly> => ({ sections: [], contexts: [], tools: [], variables: { preserved: 'yes' } }),
    )
    expect(assembled.variables).toEqual({ preserved: 'yes' })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('keeps team permission and busy checks in the real management facade', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const leadSession = session()
    const member = { id: 'member-1', role: 'teammate', status: 'inactive', name: 'Member', options: { provider: 'acp-demo' }, session: session(), ctx: new Context() }
    const lead = { id: 'lead-1', options: { provider: 'acp-demo' }, session: leadSession, ctx: new Context() }
    contexts.push(member.ctx, lead.ctx)
    const agents = {
      get: vi.fn((id: string) => id === 'lead-1' ? lead : id === 'member-1' ? member : undefined),
      list: vi.fn(() => [lead, member]),
    }
    const teams = {
      tryMembership: vi.fn((agent: unknown) => agent === lead ? { role: 'lead' } : { role: 'teammate' }),
      listMembers: vi.fn(() => [member]),
    }
    const llm = {
      listModels: vi.fn(async () => [{ id: 'model-next', name: 'Next' }]),
      resolveCallConfig: vi.fn(async ({ provider, model }: { provider: string; model: string }) => ({ provider, model })),
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
    }
    const adapter = { agentSessionSnapshot: vi.fn(async () => ({
      modeWritable: true,
      configOptions: [{ id: 'model', type: 'select', currentValue: 'model-default' }],
    })) }
    const management = createTeamManagement(
      ctx,
      provider => provider === 'acp-demo',
      async () => 'acp-demo',
      { sidecar: sidecar as unknown as AcpSidecar, adapterFor: () => adapter as never },
    )

    if (management.selectModel === undefined) throw new Error('missing selectModel helper')
    await expect(management.selectModel('lead-1', 'member-1', 'model-next')).rejects.toThrow('ACP_TEAM_MEMBER_BUSY')
    expect(sidecar.writeMemberModelSelection).not.toHaveBeenCalled()
  })
})
