import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createDshToolBridge, createDshToolBridgeKey } from '../../../src/host/tools/bridge.ts'
import { installStepToolAdmissions } from '../../../src/host/tools/step-tool-admissions.ts'
import type { AcpMcpLease } from '../../../src/runtime/session/mcp-lease.ts'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

class BindingProbeRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  readonly visible: string[][] = []
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(request: PtcRunRequest) {
    const functions = request.bindings[0]!.functions
    this.visible.push(Object.keys(functions))
    const value = functions.conditional === undefined ? 'not admitted' : await functions.conditional({})
    return { logs: [], value }
  }
}

class BridgeAdapter extends LlmAdapter {
  run?: (options: GenerateOptions) => Promise<void>
  failure: unknown
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      await this.run?.(options)
    } catch (error) {
      this.failure = error
      throw error
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(mode: 'native' | 'ptc' = 'native') {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  const toolsFiber = await ctx.plugin(ToolsService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() } as never)
  if (mode === 'ptc') await ctx.plugin(BindingProbeRuntime)
  ctx.tools.setExecutor(mode === 'native' ? new NativeToolExecutor(ctx) : new PtcExecutor(ctx))
  const readAdmission = installStepToolAdmissions(ctx)
  const key = createDshToolBridgeKey(readAdmission)
  const predicate = vi.fn(() => enabled)
  const execute = vi.fn(async () => 'ran')
  let enabled = true
  const unregister = ctx.tools.register(
    defineTool({
      name: 'conditional',
      description: 'Conditional fixture tool.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute,
    }),
    { when: predicate },
  )
  const absent = vi.fn(() => false)
  ctx.tools.register(
    defineTool({
      name: 'never',
      description: 'Never admitted.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => {
        throw new Error('unadmitted tool executed')
      },
    }),
    { when: absent },
  )
  const adapter = new BridgeAdapter()
  ctx.llm.registerAdapter(['bridge-step'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`step-${mode}`), { provider: 'bridge-step', model: 'fixture' })
  const connect = async (options: GenerateOptions) => {
    const lease = await createDshToolBridge(
      ctx,
      agent.id,
      { mcpCapabilities: { http: true } },
      undefined,
      async () => 'auto',
      undefined,
      options.tools,
      readAdmission,
    )
    if (lease === undefined) throw new Error('Expected an admitted MCP directory')
    cleanups.push(() => lease.close())
    const server = lease.servers[0]!
    if (!('url' in server)) throw new Error('Expected HTTP MCP')
    const client = new Client({ name: 'step-admission', version: '1' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    return { lease, client }
  }
  const send = async () => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'run' }] }))
    await agent.whenIdle()
    if (adapter.failure !== undefined) throw adapter.failure
  }
  return {
    ctx,
    toolsFiber,
    agent,
    adapter,
    connect,
    send,
    readAdmission,
    key,
    execute,
    predicate,
    absent,
    unregister,
    disable: () => {
      enabled = false
    },
  }
}

describe('Host admission reaches the MCP executor', () => {
  it.each(['native', 'ptc'] as const)(
    'borrows the exact %s step admission without repeating conditions or restarting a stable directory',
    async (mode) => {
      const f = await fixture(mode)
      const prepared: ResolvedToolSet[] = []
      f.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        if (context.toolSet !== undefined) prepared.push(context.toolSet)
        return next()
      })
      const executedSets: Array<ResolvedToolSet | undefined> = []
      f.ctx.on('tools/pre-execute', async (exec, next) => {
        executedSets.push(exec.toolSet)
        return next()
      })
      let connection: Awaited<ReturnType<typeof f.connect>> | undefined
      let directoryKey: unknown
      let calls = 0
      f.adapter.run = async (options) => {
        calls++
        const admission = f.readAdmission(f.agent)!
        expect(admission.isActive()).toBe(true)
        expect(admission.toolSet).toBe(prepared.at(-1))
        if (connection === undefined) {
          connection = await f.connect(options)
          directoryKey = f.key(f.ctx, f.agent.id, options.tools)
        }
        const { lease, client } = connection
        if (calls === 1 || mode === 'ptc') {
          lease.beginPrompt(options.signal!)
          expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
            mode === 'ptc' ? 'run_code' : 'conditional',
          ])
          const result = await client.callTool({
            name: mode === 'ptc' ? 'run_code' : 'conditional',
            arguments:
              mode === 'ptc' ? { code: 'probe admitted bindings', description: 'Probe admitted bindings' } : {},
          })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
          lease.endPrompt({ stopReason: 'end_turn' })
          await lease.drainPrompt?.()
        } else {
          expect(options.tools ?? []).toEqual([])
          expect(f.key(f.ctx, f.agent.id, options.tools)).toBeUndefined()
          lease.beginPrompt(options.signal!)
          // The step no longer admits this tool: the call is refused without reaching the executor.
          expect(await client.callTool({ name: 'conditional', arguments: {} })).toMatchObject({
            isError: true,
            content: [{ type: 'text', text: 'ACP_TEAM_TOOL_UNAVAILABLE' }],
          })
          lease.endPrompt()
          await lease.drainPrompt?.()
        }
        if (mode === 'ptc') expect(f.key(f.ctx, f.agent.id, options.tools)).toBe(directoryKey)
      }
      await f.send()
      expect(calls).toBe(1)
      expect(f.readAdmission(f.agent)?.isActive()).toBe(false)
      expect(f.execute).toHaveBeenCalledOnce()
      f.disable()
      await f.send()
      expect(calls).toBe(2)
      expect(f.predicate).toHaveBeenCalledTimes(2)
      expect(f.absent).toHaveBeenCalledTimes(2)
      expect(f.execute).toHaveBeenCalledOnce()
      expect(executedSets.every((set) => prepared.includes(set!))).toBe(true)
      if (mode === 'ptc') expect((f.ctx.ptcRuntime as BindingProbeRuntime).visible).toEqual([['conditional'], []])
    },
  )

  it('drains accepted native work before closing its capability', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.execute.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return 'settled'
    })
    let lease: AcpMcpLease | undefined
    f.adapter.run = async (options) => {
      const connection = await f.connect(options)
      lease = connection.lease
      lease.beginPrompt(options.signal!)
      const accepted = connection.client.callTool({ name: 'conditional', arguments: {} })
      await entered.promise
      const closing = lease.close()
      let closed = false
      void closing.then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(closed).toBe(false)
      release.resolve()
      await accepted
      await closing
      expect(f.execute).toHaveBeenCalledOnce()
    }
    await f.send()
    expect(lease?.signal.aborted).toBe(true)
  })

  it('rebinds calls and approval fences when one ACP prompt spans Host steps, retaining its idle directory', async () => {
    const f = await fixture()
    const remotePrompt = new AbortController()
    let connection: Awaited<ReturnType<typeof f.connect>> | undefined
    let priorPermission: Parameters<NonNullable<AcpMcpLease['inspectPermission']>>[0] | undefined
    const sets: Array<ResolvedToolSet | undefined> = []
    f.ctx.on('tools/pre-execute', async (exec, next) => {
      sets.push(exec.toolSet)
      return next()
    })
    let segments = 0
    f.adapter.run = async (options) => {
      segments++
      if (connection === undefined) {
        connection = await f.connect(options)
        connection.lease.beginPrompt(remotePrompt.signal)
      } else {
        expect(connection.lease.validatePermissionDecision?.(priorPermission!)).toBe(false)
      }
      const { lease, client } = connection
      const permission = {
        sessionId: 'remote',
        toolCall: { toolCallId: `permission-${segments}`, name: `mcp__${lease.servers[0]!.name}__conditional` },
        options: [{ optionId: 'once', kind: 'allow_once' as const, name: 'Once' }],
      }
      expect((await lease.inspectPermission?.(permission))?.reason).toBe('auto-approved')
      expect(lease.validatePermissionDecision?.(permission)).toBe(true)
      priorPermission = permission
      expect((await client.callTool({ name: 'conditional', arguments: {} })).isError).not.toBe(true)
      if (segments === 2) {
        lease.endPrompt({ stopReason: 'end_turn' })
        await lease.drainPrompt?.()
      }
    }
    await f.send()
    const idle = connection!
    expect(idle.lease.validatePermissionDecision?.(priorPermission!)).toBe(false)
    const unregister = f.ctx.tools.register(
      defineTool({
        name: 'unrelated',
        description: 'Unrelated registration.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'unrelated',
      }),
    )
    expect((await idle.client.listTools()).tools.map(({ name }) => name)).toEqual(['conditional'])
    expect(idle.lease.signal.aborted).toBe(false)
    unregister()
    await f.send()
    expect(segments).toBe(2)
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(sets).toHaveLength(2)
    expect(sets[0]).not.toBe(sets[1])
  })

  it('keeps the injected tools provider until accepted work has settled on provider unload', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let bodySettled = false
    let lease: AcpMcpLease | undefined
    f.execute.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      bodySettled = true
      return 'settled'
    })
    f.adapter.run = async (options) => {
      const connection = await f.connect(options)
      lease = connection.lease
      lease.beginPrompt(options.signal!)
      expect((await connection.client.callTool({ name: 'conditional', arguments: {} })).isError).toBe(true)
    }
    const turn = f.send()
    await entered.promise
    let disposed = false
    const disposing = f.toolsFiber.dispose().then(() => {
      disposed = true
    })
    try {
      await vi.waitFor(() => expect(lease?.signal.aborted).toBe(true))
      expect(disposed).toBe(false)
      expect(bodySettled).toBe(false)
    } finally {
      release.resolve()
    }
    await turn
    await disposing
    expect(bodySettled).toBe(true)
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it.each([
    { closeTransportFirst: false, owner: 'provider' },
    { closeTransportFirst: true, owner: 'provider' },
    { closeTransportFirst: true, owner: 'root' },
  ] as const)(
    'retains accepted settlement past transport grace ($owner, prior close $closeTransportFirst)',
    async ({ closeTransportFirst, owner }) => {
      const f = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const releaseAdapter = Promise.withResolvers<void>()
      const feedback = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'late native settlement' }],
      })
      let bodySettled = false
      let resultSettled = false
      let resourceClosed = false
      f.toolsFiber.ctx.effect(() => () => {
        resourceClosed = true
      })
      let lease: AcpMcpLease | undefined
      f.execute.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        expect(resourceClosed).toBe(false)
        bodySettled = true
        return 'settled after grace'
      })
      f.toolsFiber.ctx.on('tools/post-execute', async (_exec, _result, next) => {
        const decision = await next()
        expect(resourceClosed).toBe(false)
        resultSettled = true
        return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), feedback] }
      })
      f.adapter.run = async (options) => {
        const connection = await f.connect(options)
        lease = connection.lease
        lease.beginPrompt(options.signal!)
        // The socket may close at its grace deadline while native settlement
        // remains owned by the tools consumer. Transport success is not proof
        // that an accepted native call has finished.
        await connection.client.callTool({ name: 'conditional', arguments: {} }).catch(() => undefined)
        // Keep the native turn available for the final inbox acknowledgement.
        await releaseAdapter.promise
      }
      const turn = f.send()
      await entered.promise
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let disposing: Promise<void> | undefined
      let disposed = false
      try {
        if (closeTransportFirst) {
          const transportClosing = lease!.close(1)
          await vi.advanceTimersByTimeAsync(25)
          await transportClosing
          expect(lease!.hasPendingCalls?.()).toBe(true)
        }
        disposing = (owner === 'root' ? f.ctx.fiber.dispose() : f.toolsFiber.dispose()).then(() => {
          disposed = true
        })
        await vi.advanceTimersByTimeAsync(30_000)
        expect(lease!.signal.aborted).toBe(true)
        expect(disposed).toBe(false)
        expect(bodySettled).toBe(false)
        expect(resultSettled).toBe(false)
        expect(resourceClosed).toBe(false)
        expect(lease!.hasPendingCalls?.()).toBe(true)
      } finally {
        release.resolve()
        vi.useRealTimers()
        await lease?.waitForCallsSettled?.()
        releaseAdapter.resolve()
      }
      await turn
      await disposing
      expect(bodySettled).toBe(true)
      expect(resultSettled).toBe(true)
      expect(resourceClosed).toBe(true)
      expect(lease!.hasPendingCalls?.()).toBe(false)
      expect(
        f.agent.session
          .snapshotEvents()
          .flatMap((event) => (event.type === 'agent/inbox/spliced' ? event.data.inserted : []))
          .filter((message) => message.id === feedback.id),
      ).toHaveLength(1)
      expect(f.execute).toHaveBeenCalledOnce()
    },
  )

  it('retains partial-batch feedback and stops dependent calls after an internal executor failure', async () => {
    const f = await fixture()
    const feedback = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'settled context' }],
    })
    let failedLease: AcpMcpLease | undefined
    let attempted = false
    f.adapter.run = async (options) => {
      if (attempted) return
      attempted = true
      const { lease, client } = await f.connect(options)
      failedLease = lease
      lease.beginPrompt(options.signal!)
      const execute = vi.spyOn(f.ctx.tools, 'execute').mockImplementationOnce(async () => {
        throw new ToolBatchExecutionError(new Error('internal batch failure'), {
          results: [],
          additionalContexts: [feedback],
          concluded: false,
        })
      })
      try {
        const first = await client.callTool({ name: 'conditional', arguments: {} })
        expect(first).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'Tool batch execution failed: internal batch failure' }],
        })
        const second = await client.callTool({ name: 'conditional', arguments: {} })
        expect(second.isError).toBe(true)
        expect(execute).toHaveBeenCalledOnce()
        expect(f.agent.inbox.nextStep.filter((message) => message.id === feedback.id)).toHaveLength(1)
        lease.endPrompt({ stopReason: 'end_turn' })
        await expect(lease.drainPrompt?.()).rejects.toMatchObject({ code: 'ACP_HOST_TOOL_RECONCILIATION_REQUIRED' })
        expect(() => lease.beginPrompt(options.signal!)).toThrow('ACP_HOST_TOOL_RECONCILIATION_REQUIRED')
      } finally {
        execute.mockRestore()
      }
    }
    await f.send()
    expect(failedLease).toBeDefined()
    expect(f.execute).not.toHaveBeenCalled()
  })
})
