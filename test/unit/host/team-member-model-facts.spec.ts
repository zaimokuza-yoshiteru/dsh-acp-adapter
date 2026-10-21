import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { installTeamMemberModelFacts } from '../../../src/host/teams/member-model-tools.ts'
import { readMemberRequestModel } from '../../../src/host/teams/member-model-facts.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class RosterPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: process.cwd(), timeoutMs: 10_000 }
  }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    const value = await request.bindings[0]!.functions.list_agents!({})
    return { logs: [], value }
  }
}

const memberSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

async function harness(mode: 'native' | 'ptc' = 'native', project = true) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode })
  if (mode === 'ptc') await ctx.plugin(RosterPtcRuntime)
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() } as never)
  const agent = { id: 'lead', ctx, session: { append: vi.fn(), header: { cwd: process.cwd() } } } as unknown as Agent
  const rows: TeamMemberView[] = [
    { id: 'lead' as never, name: 'lead', role: 'lead', status: 'inactive', model: 'lead-model', diagnostics: [] },
    { id: 'child' as never, name: 'worker', role: 'teammate', status: 'inactive', model: 'model-a', diagnostics: [] },
  ]
  const publicRows = () => rows.map(({ id: _id, name, ...row }) => ({ target: name, ...row }))
  const membership = { root: agent, id: 'lead', role: 'lead' }
  const teams = { tryMembership: () => membership, listMembers: () => structuredClone(rows) }
  ctx.provide('agentTeams', teams as never)
  const readModel = vi.fn(async (id: string): Promise<{ currentModel: string } | undefined> =>
    id === 'child' ? { currentModel: 'model-b' } : undefined,
  )
  const projectFiber = await ctx.plugin((scope) => {
    if (project) installTeamMemberModelFacts(scope, readModel)
  })
  const execute = vi.fn(async () => publicRows())
  ctx.tools.register(
    defineTool({
      name: 'list_agents',
      description: 'Roster model facts fixture using the native canonical member fields.',
      parameters: {},
      output: {
        schema: { type: 'array', items: memberSchema },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute,
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'spawn_teammate',
      description: 'Return one created member.',
      parameters: { name: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { member: { ...memberSchema, required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ member: publicRows()[1]! }),
    }),
  )
  const invoke = (name = mode === 'ptc' ? RUN_CODE_NAME : 'list_agents', args = {}) =>
    ctx.tools.execute({
      name,
      arguments:
        name === RUN_CODE_NAME
          ? { code: 'return await tools.list_agents({})', description: 'Read current Team member model facts' }
          : args,
      agent,
      callId: ToolCallId('model-facts'),
      signal: new AbortController().signal,
    })
  return { ctx, agent, rows, membership, readModel, execute, invoke, projectFiber }
}

describe('native Team model facts', () => {
  it('reproduces the constructor-model mismatch without the adapter projection', async () => {
    const { invoke } = await harness('native', false)
    const result = await invoke()
    expect(result.isError).toBe(false)
    if (result.isError) throw result.error
    expect(result.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'worker', model: 'model-a' })]),
    )
  })

  it.each(['native', 'ptc'] as const)(
    'returns requested model B to %s consumers without mutating the roster',
    async (mode) => {
      const { invoke, rows } = await harness(mode)
      const result = await invoke()
      if (result.isError) throw result.error
      expect(result.isError).toBe(false)
      const values = mode === 'ptc' ? (result.value as { result: unknown }).result : result.value
      expect(values).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'worker', model: 'model-b' })]))
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/"model":\s*"model-b"/) })])
      expect(rows[1]?.model).toBe('model-a')
    },
  )

  it('projects a successful native spawn row and leaves Lead facts unchanged', async () => {
    const { invoke } = await harness()
    expect(await invoke('spawn_teammate', { name: 'worker' })).toMatchObject({
      isError: false,
      value: { member: { target: 'worker', model: 'model-b' } },
    })
    expect(await invoke()).toMatchObject({
      isError: false,
      value: [expect.objectContaining({ model: 'lead-model' }), expect.objectContaining({ model: 'model-b' })],
    })
  })

  it('does not rewrite a same-name tool with different roster facts', async () => {
    const { execute, invoke, readModel } = await harness()
    execute.mockResolvedValue([
      { target: 'other-business', role: 'teammate', status: 'inactive', model: 'custom', diagnostics: [] },
    ])
    expect(await invoke()).toMatchObject({ isError: false, value: [{ target: 'other-business', model: 'custom' }] })
    expect(readModel).not.toHaveBeenCalled()
  })

  it('retains unbound rows or ACP rows with no known request model', async () => {
    const { invoke, readModel } = await harness()
    readModel.mockImplementation(async () => undefined)
    expect(await invoke()).toMatchObject({
      isError: false,
      value: expect.arrayContaining([expect.objectContaining({ model: 'model-a' })]),
    })
  })

  it('preserves an original tool error without observing model facts', async () => {
    const { execute, invoke, readModel } = await harness()
    execute.mockRejectedValueOnce(new Error('native roster unavailable'))
    expect(await invoke()).toMatchObject({ isError: true })
    expect(readModel).not.toHaveBeenCalled()
  })

  it.each(['block', 'content', 'value'] as const)('preserves a later %s policy decision', async (kind) => {
    const { ctx, invoke, readModel } = await harness()
    const decision: PostToolDecision =
      kind === 'block'
        ? { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
        : kind === 'content'
          ? { kind: 'accept', content: [{ type: 'text', text: 'custom content' }] }
          : { kind: 'accept', value: [] }
    ctx.on('tools/post-execute', async () => decision)
    const result = await invoke()
    expect(result.isError).toBe(kind === 'block')
    expect(readModel).not.toHaveBeenCalled()
    if (kind === 'content') expect(result.content).toEqual([{ type: 'text', text: 'custom content' }])
    if (kind === 'value') expect(result).toMatchObject({ value: [] })
  })

  it('keeps successful original output when observation fails or becomes stale', async () => {
    const { invoke, readModel, rows } = await harness()
    readModel.mockRejectedValueOnce(new Error('projection unavailable'))
    expect(await invoke()).toMatchObject({
      isError: false,
      value: expect.arrayContaining([expect.objectContaining({ model: 'model-a' })]),
    })
    readModel.mockImplementation(async (id) => {
      rows[1] = { ...rows[1]!, status: 'running' }
      return id === 'child' ? { currentModel: 'model-b' } : undefined
    })
    expect(await invoke()).toMatchObject({
      isError: false,
      value: expect.arrayContaining([expect.objectContaining({ model: 'model-a' })]),
    })
  })

  it('removes the correction when its owning plugin is disposed', async () => {
    const { invoke, projectFiber } = await harness()
    await projectFiber.dispose()
    expect(await invoke()).toMatchObject({
      isError: false,
      value: expect.arrayContaining([expect.objectContaining({ model: 'model-a' })]),
    })
  })

  it('does not publish an observation which outlives its owning plugin', async () => {
    const { invoke, readModel, projectFiber } = await harness()
    const entered = Promise.withResolvers<void>()
    const resumed = Promise.withResolvers<{ currentModel: string }>()
    readModel.mockImplementation(async (id) => {
      if (id !== 'child') return undefined
      entered.resolve()
      return await resumed.promise
    })
    const result = invoke()
    await entered.promise
    await projectFiber.dispose()
    resumed.resolve({ currentModel: 'model-b' })
    expect(await result).toMatchObject({
      isError: false,
      value: expect.arrayContaining([expect.objectContaining({ model: 'model-a' })]),
    })
  })

  it('reads actual use rather than pending intent and retains/releases a cold projection', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const session = { requestHeader: () => ({ config: { provider: 'acp-demo', model: 'model-a' } }) }
    const sessions = { get: vi.fn(() => session as never) }
    ctx.provide('sessions', sessions as never)
    ctx.provide('sessionProjections', {
      stateOf: () => ({
        lastUsed: { provider: 'acp-demo', model: 'model-b' },
        pending: { provider: 'acp-demo', model: 'model-c' },
      }),
    } as never)
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
