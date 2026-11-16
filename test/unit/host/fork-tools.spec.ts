import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { installAcpForkTools } from '../../../src/host/composition/fork-tools.ts'

const contexts: Context[] = []
const pendingReleases: Array<() => void> = []
afterEach(async () => {
  // A deferred registration keeps its effect setup pending; release it before
  // fiber disposal or the hook waits for a promise no test will resolve.
  for (const release of pendingReleases.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class ForkTestPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = async () => ({ logs: [] })
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1_000 }
  }
  run(request: PtcRunRequest): Promise<PtcRunResult> {
    return this.behavior(request)
  }
}

async function harness(mode: 'native' | 'ptc' = 'native', projections: 'real' | 'deferred' = 'real') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  // A deferred registry keeps the fork projection unregistered until the test
  // releases it, exposing the activation window the guard must fail closed in.
  const projectionHandles: Array<{ dispose: () => Promise<void> }> = []
  let releaseRegistration: (() => void) | undefined
  const releaseProjectionRegistration = (): void => {
    const release = releaseRegistration
    releaseRegistration = undefined
    release?.()
  }
  if (projections === 'real') await ctx.plugin(SessionProjectionRegistry)
  else {
    pendingReleases.push(releaseProjectionRegistration)
    ctx.provide('sessionProjections', {
      register: () =>
        new Promise((resolve) => {
          const handle = {
            stateOf: () => ({ completed: false, active: false }),
            readerFor: () => () => ({ completed: false, active: false }),
            dispose: vi.fn(async () => undefined),
          }
          projectionHandles.push(handle)
          releaseRegistration = () => resolve(handle as never)
        }),
    } as never)
  }
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  if (mode === 'ptc') {
    ctx.provide('workingDirectory', {
      defaultDirectory: process.cwd(),
      get: () => process.cwd(),
      ensure: async () => process.cwd(),
    })
    await ctx.plugin(ForkTestPtcRuntime)
    await ctx.plugin(PtcToolExecutor, {})
  } else {
    await ctx.plugin(NativeToolExecutor)
  }
  const activeAgents = new Map<SessionId, Agent>()
  ctx.provide('agents', { list: () => [...activeAgents.values()] })
  const bodies = {
    subagent_fork: vi.fn(async () => 'created'),
    subagent: vi.fn(async () => 'fresh'),
    spawn_teammate: vi.fn(async () => 'created'),
  }
  const register = (name: keyof typeof bodies, owner = ctx) =>
    owner.tools.register(
      defineTool({
        name,
        description: `Delegate using ${name}.`,
        parameters: {
          context: { type: 'string' },
          ...(name === 'subagent_fork'
            ? { provider: { type: 'string' as const }, model: { type: 'string' as const } }
            : {}),
        },
        output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
        execute: bodies[name],
      }),
    )
  const removeFork = register('subagent_fork')
  register('subagent')
  register('spawn_teammate')
  const mount = () =>
    ctx.plugin(
      Object.assign((child: Context) => installAcpForkTools(child), { inject: ['tools', 'sessionProjections'] }),
    )
  const agent = async (provider = 'acp-demo') => {
    const session = ctx.sessions.create(SessionId(`fork-tools-${Math.random()}`))
    session.append('request/header', { header: { config: { provider, model: 'test' } }, reason: 'initial' })
    const key = { id: session.id, session, options: { provider, model: 'test' }, status: 'running' } as Agent
    await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          const scope = createScope(inner, key)
          Object.assign(key, { ctx: scope.ctx })
        },
        { inject: ['tools', 'systemPrompt'] },
      ),
    )
    activeAgents.set(key.id, key)
    await ctx.serial('agent/created', { agent: key, source: 'new' } as never)
    return key
  }
  const completed = (owner: Agent) => {
    owner.session.append('turn/start', { turn: 1 })
    owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    owner.session.append('turn/start', { turn: 2 })
  }
  const execute = async (owner: Agent, name: string, args = {}) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`${name}-call`), name, arguments: JSON.stringify(args) }],
      agent: owner,
      signal: new AbortController().signal,
    })
    const settled = batch.results[0]
    if (settled === undefined) throw new Error('missing tool result')
    return settled.result
  }
  return {
    ctx,
    bodies,
    register,
    removeFork,
    mount,
    agent,
    completed,
    execute,
    projectionHandles,
    releaseRegistration: releaseProjectionRegistration,
  }
}

describe('ACP fork tool admission', () => {
  it('rejects an explicit ACP target before the body while fresh delegations remain available', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    const result = await h.execute(acp, 'subagent_fork', { provider: 'acp-demo', model: 'test' })
    expect(result.isError).toBe(true)
    expect(h.bodies.subagent_fork).not.toHaveBeenCalled()
    expect((await h.execute(acp, 'subagent')).isError).toBe(false)
  })

  it('keeps the complete tool schema in native assembly for routes decided by its own preflight', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    expect(h.ctx.tools.schemas(acp).map((tool) => tool.name)).toContain('subagent_fork')
    expect((await h.ctx.systemPrompt.assemble({ scope: acp, agent: acp })).tools.map((tool) => tool.name)).toContain(
      'subagent_fork',
    )
  })

  it('leaves empty seeds and idle calls to the provider final boundary check', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    acp.session.append('turn/start', { turn: 1 })
    const args = { provider: 'acp-demo', model: 'test' }
    expect((await h.execute(acp, 'subagent_fork', args)).isError).toBe(false)
    acp.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await h.execute(acp, 'subagent_fork', args)).isError).toBe(false)
    expect((await h.execute(acp, 'spawn_teammate', { context: 'fresh' })).isError).toBe(false)
  })

  it('applies target checks to scoped definitions while preserving their native route parameters', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.register('subagent_fork', acp.ctx)
    h.completed(acp)
    expect((await h.execute(acp, 'subagent_fork', { provider: 'acp-demo', model: 'test' })).isError).toBe(true)
    expect(h.bodies.subagent_fork).not.toHaveBeenCalled()
    expect((await h.execute(acp, 'subagent_fork', { provider: 'deepseek', model: 'native' })).isError).toBe(false)
  })

  it('mounts and removes the execution guard without retaining per-agent schema masks', async () => {
    const h = await harness()
    const acp = await h.agent()
    h.completed(acp)
    const args = { provider: 'acp-demo', model: 'test' }
    const plugin = await h.mount()
    expect((await h.execute(acp, 'subagent_fork', args)).isError).toBe(true)
    await plugin.dispose()
    expect((await h.execute(acp, 'subagent_fork', args)).isError).toBe(false)
    await h.mount()
    expect((await h.execute(acp, 'subagent_fork', args)).isError).toBe(true)
  })

  it('retains target admission when inherited and scoped definitions are replaced', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    h.removeFork()
    h.register('subagent_fork')
    expect(h.ctx.tools.schemas(acp).map((tool) => tool.name)).toContain('subagent_fork')
    const removeScoped = h.register('subagent_fork', acp.ctx)
    expect((await h.execute(acp, 'subagent_fork', { provider: 'acp-demo', model: 'test' })).isError).toBe(true)
    removeScoped()
    expect((await h.execute(acp, 'subagent_fork', { provider: 'deepseek', model: 'native' })).isError).toBe(false)
  })

  it('rejects an ACP target until the fork projection is registered', async () => {
    const h = await harness('native', 'deferred')
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    const result = await h.execute(acp, 'subagent_fork', { provider: 'acp-demo', model: 'test' })
    expect(result.isError).toBe(true)
    expect(h.bodies.subagent_fork).not.toHaveBeenCalled()
    h.releaseRegistration()
  })

  it('releases the fork projection when the guard is removed', async () => {
    const h = await harness('native', 'deferred')
    const plugin = await h.mount()
    h.releaseRegistration()
    await plugin.dispose()
    expect(h.projectionHandles[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('preserves the PTC SDK and checks the explicit target through real nested dispatch', async () => {
    const h = await harness('ptc')
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    const assembly = await h.ctx.systemPrompt.assemble({ scope: acp, agent: acp })
    const sdk = assembly.sections.find((section) => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('subagent_fork')
    const runtime = h.ctx.ptcRuntime as ForkTestPtcRuntime
    runtime.behavior = async (request) => {
      await expect(
        request.bindings[0]!.functions.subagent_fork!({ provider: 'acp-demo', model: 'test' }),
      ).rejects.toThrow('ACP_DELEGATED_FORK_UNAVAILABLE')
      expect(h.bodies.subagent_fork).not.toHaveBeenCalled()
      await expect(
        request.bindings[0]!.functions.subagent_fork!({ provider: 'deepseek', model: 'native' }),
      ).resolves.toBe('created')
      return { logs: [], value: 'checked' }
    }
    const result = await h.execute(acp, 'run_code', {
      code: 'await tools.subagent_fork({ provider: "deepseek", model: "native" })',
      description: 'Check fork target admission',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ logs: [], result: 'checked' })
    expect(h.bodies.subagent_fork).toHaveBeenCalledOnce()
  })
})

describe('fork target route admission', () => {
  it('keeps explicit native child routes visible and executable from an ACP parent', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    expect(h.ctx.tools.schemas(acp).map((tool) => tool.name)).toContain('subagent_fork')
    expect((await h.execute(acp, 'subagent_fork', { provider: 'deepseek', model: 'native' })).isError).toBe(false)
    expect(h.bodies.subagent_fork).toHaveBeenCalledOnce()
  })

  it('does not infer a configured child route from its ACP parent when arguments omit provider', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    h.bodies.subagent_fork.mockResolvedValue('configured native route')
    const result = await h.execute(acp, 'subagent_fork')
    expect(result).toMatchObject({ isError: false, value: 'configured native route' })
  })

  it('rejects an explicit ACP child route from a native active parent with a completed prefix', async () => {
    const h = await harness()
    await h.mount()
    const native = await h.agent('deepseek')
    h.completed(native)
    expect((await h.execute(native, 'subagent_fork', { provider: 'acp-demo', model: 'test' })).isError).toBe(true)
    expect(h.bodies.subagent_fork).not.toHaveBeenCalled()
  })

  it('does not guess a Teams tool configured fork provider from its ACP caller', async () => {
    const h = await harness()
    await h.mount()
    const acp = await h.agent()
    h.completed(acp)
    h.bodies.spawn_teammate.mockResolvedValue('configured native team route')
    expect(await h.execute(acp, 'spawn_teammate', { context: 'fork' })).toMatchObject({
      isError: false,
      value: 'configured native team route',
    })
  })
})
