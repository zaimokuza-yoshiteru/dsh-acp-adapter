import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RequestPermissionRequest, CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createTeamBridge, teamBridgeKey } from '../../../src/host/teams/bridge.ts'
import { installLiveDiagnosticTrace } from '../../../src/contract/live-diagnostic-trace.ts'
import type { LiveDiagnosticEvent } from '../../../src/contract/live-diagnostic-trace.ts'

const cleanup: Array<() => Promise<unknown>> = []
const diagnosticRemovers: Array<() => void> = []

class BridgeFakePtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(_request: PtcRunRequest): Promise<PtcRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

function createFeedbackSession(source: unknown = { kind: 'user' }): Session {
  const session = Session.create(SessionId('lead'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'user/message',
    createUserMessage({ source: source as never, content: [{ type: 'text', text: 'original prompt' }] }),
    { surfaceOp: 'append' },
  )
  return session
}

function restoreFeedbackSession(
  source: Session,
  events: readonly unknown[] = source.snapshotEvents(),
  header: Session['header'] = source.header,
  eventState: 'detached' | 'shared-frozen' = 'shared-frozen',
): Session {
  return Session.fromRestore(
    SessionId('lead'),
    events as Parameters<typeof Session.fromRestore>[1],
    header,
    source.inheritedEventCount,
    eventState,
  )
}

afterEach(async () => {
  for (const remove of diagnosticRemovers.splice(0)) remove()
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  )
})

it('records actual MCP-to-Host execution correlation and isolates a throwing trace sink', async () => {
  const events: LiveDiagnosticEvent[] = []
  const remove = installLiveDiagnosticTrace(
    Object.assign(
      (event: LiveDiagnosticEvent) => {
        events.push(event)
      },
      {
        id: (kind: string, value: unknown) =>
          `h:${createHmac('sha256', 'unit-test-key')
            .update(`${kind}:${JSON.stringify(value)}`)
            .digest('hex')
            .slice(0, 24)}`,
        fingerprint: (kind: string, value: unknown) => {
          const canonical = JSON.stringify(value)
          return {
            hmac: `h:${createHmac('sha256', 'unit-test-key').update(`${kind}:${canonical}`).digest('hex').slice(0, 24)}`,
            bytes: Buffer.byteLength(canonical),
            complete: true,
          }
        },
      },
    ),
  )
  diagnosticRemovers.push(remove)
  const fixture = await setup(undefined, [], true, 'teammate')
  fixture.lease.beginPrompt(new AbortController().signal)
  const result = await fixture.client.callTool({
    name: 'send_message',
    arguments: { target: 'lead', message: 'private test body' },
  })
  expect(result.isError).not.toBe(true)
  expect(fixture.execute).toHaveBeenCalledTimes(1)
  const secondResult = await fixture.client.callTool({
    name: 'send_message',
    arguments: { target: 'lead', message: 'private test body' },
  })
  expect(secondResult.isError).not.toBe(true)
  const bridgeEvents = events as unknown as Array<{
    type: string
    hostCallId?: string
    mcpRequestId?: string
    resultStatus?: string
    handlerIsError?: boolean
    clientReceiptStatus?: string
  }>
  const starts = bridgeEvents.filter((event) => event.type === 'host-execute/start')
  const settled = bridgeEvents.filter((event) => event.type === 'host-execute/settled')
  const returned = bridgeEvents.filter((event) => event.type === 'mcp-handler/returned')
  expect(starts).toHaveLength(2)
  expect(starts[0]?.hostCallId).toBeDefined()
  expect(starts[0]?.hostCallId).not.toBe(starts[1]?.hostCallId)
  expect(starts[0]?.mcpRequestId).not.toBe(starts[1]?.mcpRequestId)
  expect(settled).toHaveLength(2)
  expect(returned).toHaveLength(2)
  for (let index = 0; index < starts.length; index++) {
    expect(settled[index]).toMatchObject({ hostCallId: starts[index]?.hostCallId, resultStatus: 'success' })
    expect(returned[index]).toMatchObject({
      hostCallId: starts[index]?.hostCallId,
      handlerIsError: false,
      clientReceiptStatus: 'unavailable',
    })
  }

  remove()
  const removeThrowing = installLiveDiagnosticTrace(
    Object.assign(
      () => {
        throw new Error('private sink failure')
      },
      {
        id: (kind: string, value: unknown) =>
          `h:${createHmac('sha256', 'unit-test-key')
            .update(`${kind}:${JSON.stringify(value)}`)
            .digest('hex')
            .slice(0, 24)}`,
        fingerprint: (kind: string, value: unknown) => {
          const canonical = JSON.stringify(value)
          return {
            hmac: `h:${createHmac('sha256', 'unit-test-key').update(`${kind}:${canonical}`).digest('hex').slice(0, 24)}`,
            bytes: Buffer.byteLength(canonical),
            complete: true,
          }
        },
      },
    ),
  )
  diagnosticRemovers.push(removeThrowing)
  const thirdResult = await fixture.client.callTool({
    name: 'send_message',
    arguments: { target: 'lead', message: 'private test body' },
  })
  expect(thirdResult.isError).not.toBe(true)
  expect(fixture.execute).toHaveBeenCalledTimes(3)
})

async function setup(
  wireProfile?: string,
  registeredTools: readonly string[] = [],
  hasTeams = true,
  role: 'lead' | 'teammate' = 'lead',
  policy?: () => Promise<'auto' | 'ask'>,
  onPolicyContextChange?: () => void,
  withSession = false,
  initialSession?: Session,
) {
  const createInbox = () => ({
    nextStep: [] as ReturnType<typeof createUserMessage>[],
    nextTurn: [] as ReturnType<typeof createUserMessage>[],
  })
  const session = withSession
    ? (initialSession ?? createFeedbackSession())
    : { seq: 0, snapshotEvents: vi.fn(() => [] as readonly unknown[]) }
  const agent = {
    id: 'lead',
    ...(withSession ? { session } : {}),
    inbox: createInbox(),
    steer: vi.fn(),
    inject: vi.fn(),
  }
  let currentAgent = agent
  const rootAgent =
    role === 'teammate' ? { id: 'team-root', inbox: createInbox(), steer: vi.fn(), inject: vi.fn() } : agent
  const names = [
    ...registeredTools,
    ...(hasTeams
      ? [
          'spawn_teammate',
          'send_message',
          'list_agents',
          'wait_agent',
          'interrupt_agent',
          'team_task_create',
          'team_task_list',
          'team_task_get',
          'team_task_update',
        ]
      : []),
  ]
  const definitions = new Map<string, any>(
    names.map((name) => [
      name,
      {
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
      },
    ]),
  )
  const hidden = new Set<string>()
  const membership = { current: { role, id: 'member-1', root: rootAgent } }
  const execute = vi.fn(async (input) => ({ content: [{ type: 'text', text: input.name }], isError: false }))
  const services: Record<string, unknown> = {
    agentTeams: {
      tryMembership: (value: unknown) =>
        value === rootAgent
          ? { role: 'lead', id: 'member-1', root: rootAgent }
          : value === agent
            ? membership.current
            : undefined,
    },
    agents: { get: (id: string) => (id === 'lead' ? agent : id === 'team-root' ? rootAgent : undefined) },
    tools: {
      schemas: (scope: unknown) =>
        scope === agent ? [...definitions.values()].filter((definition) => !hidden.has(definition.name)) : [],
      get: (name: string, scope: unknown) => (scope === agent && !hidden.has(name) ? definitions.get(name) : undefined),
      executionMode: () => ({ kind: 'exclusive' }),
      execute,
    },
  }
  if (withSession) services.sessions = { get: (id: string) => (id === 'lead' ? currentAgent.session : undefined) }
  const listeners = new Map<string, (...args: any[]) => void>()
  if (!hasTeams) delete services.agentTeams
  const getService = (name: string) => services[name]
  const rootContext = { get: getService }
  const ctx = {
    get: getService,
    root: rootContext,
    on: (name: string, listener: (...args: any[]) => void) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  const schemas = [...definitions.values()].map((definition) => ({
    name: definition.name,
    description: definition.description ?? definition.name,
    parameters: definition.parameters,
  }))
  const lease = (await createTeamBridge(
    ctx,
    'lead',
    { mcpCapabilities: { http: true } },
    wireProfile,
    policy ?? (async () => 'auto'),
    onPolicyContextChange,
    schemas,
  ))!
  cleanup.push(() => lease.close())
  const server = lease.servers[0]!
  if (!('url' in server)) throw new Error('Expected HTTP')
  const client = new Client({ name: 'fixture', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  cleanup.push(() => client.close())
  const tools = (await client.listTools()).tools
  const name = (tools.find((tool) => tool.name === 'list_agents') ?? tools[0])!.name
  const permission = (toolName?: string): RequestPermissionRequest => ({
    sessionId: 'acp',
    toolCall: {
      toolCallId: 'permission',
      ...(toolName === undefined
        ? {}
        : { name: toolName.startsWith('mcp__') ? toolName : `mcp__${server.name}__${toolName}` }),
    },
    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }],
  })
  return {
    ctx,
    services,
    execute,
    definitions,
    agent,
    session,
    lease,
    server,
    client,
    tools,
    name,
    permission,
    listeners,
    hidden,
    membership,
    replaceCurrentAgent: (replacement: typeof agent) => {
      currentAgent = replacement
      services.agents = {
        get: (id: string) => (id === 'lead' ? currentAgent : id === 'team-root' ? rootAgent : undefined),
      }
    },
  }
}

async function rawMcp(server: { url: string }, message: Record<string, unknown>, protocolVersion?: string) {
  return await fetch(server.url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  })
}

describe('session-owned native Teams MCP bridge', () => {
  it('keeps real ToolRuntime exclusive calls behind pending calls and ahead of later parallel calls', async () => {
    const dsh = new CordisContext()
    const systemPromptFiber = await dsh.plugin(SystemPrompt, {})
    const runtimeFiber = await dsh.plugin(ToolRuntime)
    cleanup.push(async () => {
      await runtimeFiber.dispose()
      await systemPromptFiber.dispose()
    })
    const started: string[] = []
    const phases = [
      'first',
      'parallel-peer',
      'exclusive',
      'later',
      'exclusive-for-mutation',
      'mutable-queued',
      'after-mutable',
      'exclusive-old-generation',
      'queued-old-generation',
      'new-generation',
    ]
    const gates = new Map(phases.map((name) => [name, Promise.withResolvers<void>()]))
    const entered = new Map(phases.map((name) => [name, Promise.withResolvers<void>()]))
    let mutableExclusive = false
    dsh.tools.register(
      defineTool({
        name: 'work',
        description: 'Run a gated test operation.',
        parameters: { phase: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        isConcurrencySafe: (args) => {
          const phase = (args as { phase?: unknown }).phase
          if (phase === 'mutable-queued') return !mutableExclusive
          return typeof phase !== 'string' || !phase.startsWith('exclusive')
        },
        execute: async (args) => {
          const phase = (args as { phase: string }).phase
          started.push(phase)
          entered.get(phase)?.resolve()
          await gates.get(phase)?.promise
          return phase
        },
      }),
    )
    const agent = {
      id: 'scheduled-agent',
      inbox: { nextStep: [] },
      session: { header: { cwd: process.cwd() }, append: vi.fn() },
      steer: vi.fn(),
    }
    const assembly = await dsh.systemPrompt.assemble({ scope: agent as never })
    const bridgeCtx = {
      on: (name: string, listener: (...args: unknown[]) => void) => dsh.on(name as never, listener as never),
      get: (name: string) => {
        if (name === 'agents') return { get: (id: string) => (id === agent.id ? agent : undefined) }
        if (name === 'agentTeams' || name === 'attachments') return undefined
        return dsh.get(name as never)
      },
    } as unknown as Context
    const lease = (await createTeamBridge(
      bridgeCtx,
      agent.id,
      { mcpCapabilities: { http: true } },
      undefined,
      async () => 'auto',
      undefined,
      assembly.tools,
    ))!
    cleanup.push(() => lease.close())
    const server = lease.servers[0]!
    if (!('url' in server)) throw new Error('Expected HTTP')
    const client = new Client({ name: 'execution-mode-barrier', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    cleanup.push(() => client.close())
    const prompt = new AbortController()
    lease.beginPrompt(prompt.signal)

    const first = client.callTool({ name: 'work', arguments: { phase: 'first' } })
    await entered.get('first')!.promise
    const parallelPeer = client.callTool({ name: 'work', arguments: { phase: 'parallel-peer' } })
    await entered.get('parallel-peer')!.promise
    const exclusive = client.callTool({ name: 'work', arguments: { phase: 'exclusive' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toEqual(['first', 'parallel-peer'])
    const later = client.callTool({ name: 'work', arguments: { phase: 'later' } })
    gates.get('first')!.resolve()
    gates.get('parallel-peer')!.resolve()
    await entered.get('exclusive')!.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toEqual(['first', 'parallel-peer', 'exclusive'])
    gates.get('exclusive')!.resolve()
    await entered.get('later')!.promise
    gates.get('later')!.resolve()
    expect(
      (await Promise.all([first, parallelPeer, exclusive, later])).every((result) => result.isError !== true),
    ).toBe(true)

    const exclusiveForMutation = client.callTool({
      name: 'work',
      arguments: { phase: 'exclusive-for-mutation' },
    })
    await entered.get('exclusive-for-mutation')!.promise
    const mutableQueued = client.callTool({ name: 'work', arguments: { phase: 'mutable-queued' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    mutableExclusive = true
    const afterMutable = client.callTool({ name: 'work', arguments: { phase: 'after-mutable' } })
    gates.get('exclusive-for-mutation')!.resolve()
    await entered.get('mutable-queued')!.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started.slice(-2)).toEqual(['exclusive-for-mutation', 'mutable-queued'])
    gates.get('mutable-queued')!.resolve()
    await entered.get('after-mutable')!.promise
    gates.get('after-mutable')!.resolve()
    expect(
      (await Promise.all([exclusiveForMutation, mutableQueued, afterMutable])).every((r) => r.isError !== true),
    ).toBe(true)

    prompt.abort()
    lease.endPrompt()
    await lease.drainPrompt?.()
    const oldPrompt = new AbortController()
    lease.beginPrompt(oldPrompt.signal)
    const exclusiveOldGeneration = client.callTool({
      name: 'work',
      arguments: { phase: 'exclusive-old-generation' },
    })
    await entered.get('exclusive-old-generation')!.promise
    const queuedOldGeneration = client.callTool({
      name: 'work',
      arguments: { phase: 'queued-old-generation' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    oldPrompt.abort()
    lease.endPrompt()
    gates.get('exclusive-old-generation')!.resolve()
    await exclusiveOldGeneration
    const staleResult = await queuedOldGeneration
    expect(staleResult.isError).toBe(true)
    await lease.drainPrompt?.()
    const newPrompt = new AbortController()
    lease.beginPrompt(newPrompt.signal)
    const newGeneration = client.callTool({ name: 'work', arguments: { phase: 'new-generation' } })
    await entered.get('new-generation')!.promise
    expect(started.slice(-2)).toEqual(['exclusive-old-generation', 'new-generation'])
    gates.get('new-generation')!.resolve()
    expect((await newGeneration).isError).not.toBe(true)
    newPrompt.abort()
    lease.endPrompt()
    expect(
      dsh.tools.executionMode({
        callId: 'mode-check' as never,
        name: 'work',
        arguments: { phase: 'exclusive' },
        agent: agent as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'exclusive' })
  })

  it('reports terminal evidence only after real successful concludesTurn execution', async () => {
    const dsh = new CordisContext()
    const systemPromptFiber = await dsh.plugin(SystemPrompt, {})
    const runtimeFiber = await dsh.plugin(ToolRuntime)
    cleanup.push(async () => {
      await runtimeFiber.dispose()
      await systemPromptFiber.dispose()
    })
    dsh.tools.register(
      defineTool({
        name: 'structured_output',
        description: 'Return structured output.',
        parameters: { value: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: () => [] },
        execute: async (_args, exec) => {
          exec.concludeTurn()
          return 'captured'
        },
      }),
    )
    const agent = {
      id: 'terminal-agent',
      inbox: { nextStep: [] },
      session: { header: { cwd: process.cwd() }, append: vi.fn() },
      steer: vi.fn(),
    }
    const assembly = await dsh.systemPrompt.assemble({ scope: agent as never })
    const bridgeCtx = {
      on: (name: string, listener: (...args: unknown[]) => void) => dsh.on(name as never, listener as never),
      get: (name: string) => {
        if (name === 'agents') return { get: (id: string) => (id === agent.id ? agent : undefined) }
        if (name === 'agentTeams' || name === 'attachments') return undefined
        return dsh.get(name as never)
      },
    } as unknown as Context
    const lease = (await createTeamBridge(
      bridgeCtx,
      agent.id,
      { mcpCapabilities: { http: true } },
      undefined,
      async () => 'auto',
      undefined,
      assembly.tools,
    ))!
    cleanup.push(() => lease.close())
    const server = lease.servers[0]!
    if (!('url' in server)) throw new Error('Expected HTTP')
    const client = new Client({ name: 'concludes-turn-evidence', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    cleanup.push(() => client.close())
    const onTurnConcluded = vi.fn()
    const prompt = new AbortController()
    lease.beginPrompt(prompt.signal, undefined, undefined, onTurnConcluded)
    const result = await client.callTool({ name: 'structured_output', arguments: { value: 'ok' } })
    expect(result.isError).not.toBe(true)
    expect(onTurnConcluded).toHaveBeenCalledOnce()
    prompt.abort()
    lease.endPrompt()
  })

  it('reports only successfully returned prompt-scoped Host tool results as completion evidence', async () => {
    const fixture = await setup()
    cleanup.push(() => fixture.lease.close())
    const prompt = new AbortController()
    const onSuccessfulToolResult = vi.fn()
    fixture.lease.beginPrompt(prompt.signal, undefined, undefined, undefined, undefined, onSuccessfulToolResult)
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'successful result' }],
      isError: false,
    } as never)
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'failed result' }],
      isError: true,
    } as never)

    const successful = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(successful.isError).not.toBe(true)
    expect(onSuccessfulToolResult).toHaveBeenCalledOnce()

    const failed = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(failed.isError).toBe(true)
    expect(onSuccessfulToolResult).toHaveBeenCalledOnce()
    prompt.abort()
    fixture.lease.endPrompt()
  })

  it('does not report a successful Host result after its prompt generation has ended', async () => {
    const fixture = await setup()
    cleanup.push(() => fixture.lease.close())
    const prompt = new AbortController()
    const onSuccessfulToolResult = vi.fn()
    fixture.lease.beginPrompt(prompt.signal, undefined, undefined, undefined, undefined, onSuccessfulToolResult)
    type ToolResult = Awaited<ReturnType<typeof fixture.execute>>
    let settle!: (result: ToolResult) => void
    fixture.execute.mockImplementationOnce(
      () =>
        new Promise<ToolResult>((resolve) => {
          settle = resolve
        }),
    )
    const call = fixture.client.callTool({ name: 'list_agents', arguments: {} })
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())

    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    settle({ content: [{ type: 'text', text: 'late result' }], isError: false } as ToolResult)
    await expect(call).resolves.toMatchObject({ isError: false })
    expect(onSuccessfulToolResult).not.toHaveBeenCalled()
  })

  it('waits for dispatched Host execution after end_turn and preserves ordinary Stop', async () => {
    const run = async (
      stopReason: 'end_turn' | 'stop',
      result: { content: Array<{ type: 'text'; text: string }>; isError: boolean; error?: unknown },
      externallyAborted = false,
      stopAfterTerminal = false,
    ) => {
      const fixture = await setup()
      const promptSignal = new AbortController()
      fixture.lease.beginPrompt(promptSignal.signal)
      type ToolResult = Awaited<ReturnType<typeof fixture.execute>>
      let settle!: (value: ToolResult) => void
      fixture.execute.mockImplementationOnce(
        () =>
          new Promise<ToolResult>((resolve) => {
            settle = resolve
          }),
      )
      const call = fixture.client.callTool({ name: 'list_agents', arguments: {} })
      await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())
      if (externallyAborted) promptSignal.abort(new Error('user stop'))
      fixture.lease.endPrompt({ stopReason, externallyAborted })
      if (stopReason === 'end_turn' && !externallyAborted)
        expect(fixture.execute.mock.calls[0]?.[0].signal.aborted).toBe(false)
      if (stopAfterTerminal) promptSignal.abort(new Error('user stop while draining'))
      if (externallyAborted || stopAfterTerminal) expect(fixture.execute.mock.calls[0]?.[0].signal.aborted).toBe(true)
      settle(result)
      await call
      return fixture.lease.drainPrompt?.()
    }

    await expect(
      run('end_turn', {
        content: [{ type: 'text', text: 'not dispatched' }],
        isError: true,
        error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } },
      }),
    ).rejects.toMatchObject({ code: 'ACP_HOST_TOOL_NOT_DISPATCHED' })
    await expect(
      run('end_turn', { content: [{ type: 'text', text: 'executed' }], isError: false }),
    ).resolves.toBeUndefined()
    await expect(
      run(
        'stop',
        {
          content: [{ type: 'text', text: 'cancelled before dispatch' }],
          isError: true,
          error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } },
        },
        true,
      ),
    ).resolves.toBeUndefined()
    await expect(
      run(
        'end_turn',
        {
          content: [{ type: 'text', text: 'cancelled while draining' }],
          isError: true,
          error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } },
        },
        false,
        true,
      ),
    ).resolves.toBeUndefined()
  })

  it('reports a naturally cancelled queued call as not dispatched after the running call settles', async () => {
    const fixture = await setup()
    fixture.lease.beginPrompt(new AbortController().signal)
    type ToolResult = Awaited<ReturnType<typeof fixture.execute>>
    let settleRunning!: (value: ToolResult) => void
    fixture.execute.mockImplementationOnce(
      () =>
        new Promise<ToolResult>((resolve) => {
          settleRunning = resolve
        }),
    )

    const running = fixture.client.callTool({ name: 'list_agents', arguments: {} })
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())
    const queued = fixture.client.callTool({ name: 'list_agents', arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))

    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    const queuedResult = await queued
    expect(queuedResult.isError).toBe(true)
    expect(fixture.execute).toHaveBeenCalledOnce()
    settleRunning({ content: [{ type: 'text', text: 'running call completed' }], isError: false } as ToolResult)

    await expect(running).resolves.toMatchObject({ isError: false })
    await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
      code: 'ACP_HOST_TOOL_NOT_DISPATCHED',
    })
    expect(() => fixture.lease.beginPrompt(new AbortController().signal)).not.toThrow()
    fixture.lease.endPrompt()
    await expect(fixture.lease.drainPrompt?.()).resolves.toBeUndefined()
  })

  it('does not abort an already-dispatched Host body when the ACP prompt ends naturally', async () => {
    const fixture = await setup()
    const prompt = new AbortController()
    fixture.lease.beginPrompt(prompt.signal)
    type ToolResult = Awaited<ReturnType<typeof fixture.execute>>
    let settle!: (value: ToolResult) => void
    fixture.execute.mockImplementationOnce(
      () =>
        new Promise<ToolResult>((resolve) => {
          settle = resolve
        }),
    )

    const call = fixture.client.callTool({ name: 'list_agents', arguments: {} })
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())
    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    expect(fixture.execute.mock.calls[0]?.[0].signal.aborted).toBe(false)
    settle({ content: [{ type: 'text', text: 'completed after terminal response' }], isError: false } as ToolResult)

    await expect(call).resolves.toMatchObject({ isError: false })
    await expect(fixture.lease.drainPrompt?.()).resolves.toBeUndefined()
  })

  it('returns repeat-tool feedback immediately without exposing the original reminder context', async () => {
    const { lease, client, execute, agent } = await setup()
    lease.beginPrompt(new AbortController().signal)
    const reminder = createUserMessage({
      source: { kind: 'repeat-tool-reminder' } as never,
      content: [{ type: 'text', text: 'PRIVATE_REPEAT_REMINDER_BODY' }],
    })
    execute.mockImplementationOnce(
      async () =>
        ({
          content: [{ type: 'text', text: 'tool result' }],
          isError: false,
          additionalContexts: [reminder],
        }) as never,
    )

    const result = await client.callTool({ name: 'list_agents', arguments: {} })
    const returnedText = result.content.map((item) => ('text' in item ? item.text : '')).join('')

    expect(agent.inject).toHaveBeenCalledWith(reminder)
    expect(agent.steer).not.toHaveBeenCalled()
    expect(returnedText).toContain('tool result\n\nDSH has queued feedback because this tool was repeated')
    expect(returnedText).toContain('Stop repeating the tool call')
    expect(returnedText).toContain('end this ACP response now')
    expect(returnedText).not.toContain('PRIVATE_REPEAT_REMINDER_BODY')
  })

  it('isolates a throwing policy subscriber after injecting tool feedback', async () => {
    const subscriber = vi.fn(() => {
      throw new Error('subscriber failed')
    })
    const fixture = await setup(undefined, [], true, 'lead', undefined, subscriber)
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'native feedback' }],
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })

    expect(result.isError).not.toBe(true)
    expect(fixture.agent.inject).toHaveBeenCalledWith(context)
    expect(subscriber).toHaveBeenCalledOnce()
  })

  it('retains feedback without retry when acceptance cannot be proven', async () => {
    const fixture = await setup()
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'retained feedback' }],
    })
    fixture.agent.inject.mockImplementationOnce(() => {
      throw new Error('inject failed but this Agent exposes no acceptance evidence')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(fixture.agent.inject).toHaveBeenCalledOnce()
    const executionCountAfterFailure = fixture.execute.mock.calls.length
    expect(() => fixture.lease.beginPrompt(new AbortController().signal)).toThrowError(
      expect.objectContaining({ code: 'ACP_HOST_GENERATION_STILL_ACTIVE' }),
    )
    const rejectedFollowup = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(rejectedFollowup.isError).toBe(true)
    expect(fixture.execute).toHaveBeenCalledTimes(executionCountAfterFailure)
    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
      remoteOutcomeKnown: true,
    })
    expect(fixture.lease.hasUncommittedFeedback?.()).toBe(true)
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(true)
    await expect(fixture.lease.flushHostFeedback?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })
    expect(fixture.agent.inject).toHaveBeenCalledOnce()
    expect(fixture.lease.hasUncommittedFeedback?.()).toBe(true)
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(true)
  })

  it('retries retained feedback through an Agent restored from the same native Session prefix', async () => {
    const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true)
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'retained feedback for the same session' }],
    })
    fixture.agent.inject.mockImplementation(() => {
      throw new Error('transient inject failure')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    const replacement = {
      id: 'lead',
      session: restoreFeedbackSession(fixture.session as Session),
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    fixture.replaceCurrentAgent(replacement as never)

    await fixture.lease.flushHostFeedback?.()
    expect(replacement.inject).toHaveBeenCalledWith(context)
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(false)
  })

  it('retries continuity proof from the original append-only Session after one snapshot read fails', async () => {
    const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true)
    const originalSession = fixture.session as Session
    const nativeSnapshot = originalSession.snapshotEvents.bind(originalSession)
    let failBaselineReadOnce = true
    vi.spyOn(originalSession, 'snapshotEvents').mockImplementation(
      (from = SessionLogOffset(0), to = originalSession.seq) => {
        if (from === SessionLogOffset(0) && to === SessionLogOffset(3) && failBaselineReadOnce) {
          failBaselineReadOnce = false
          throw new Error('temporary native snapshot read failure')
        }
        return nativeSnapshot(from, to)
      },
    )
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'retained feedback after temporary proof failure' }],
    })
    fixture.agent.inject.mockImplementation(() => {
      throw new Error('inject remains unconfirmed')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(fixture.agent.inject).toHaveBeenCalledTimes(2)
    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })

    const replacement = {
      id: 'lead',
      session: restoreFeedbackSession(originalSession),
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    fixture.replaceCurrentAgent(replacement as never)
    await fixture.lease.flushHostFeedback?.()

    expect(replacement.inject).toHaveBeenCalledWith(context)
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(false)
  })

  it('does not reinject feedback already present in a restored native Session', async () => {
    const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true)
    const originalSession = fixture.session as Session
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'commit before observer failure' }],
    })
    const nativeSnapshot = originalSession.snapshotEvents.bind(originalSession)
    const originalBoundary = originalSession.seq
    vi.spyOn(originalSession, 'snapshotEvents').mockImplementation(
      (from = SessionLogOffset(0), to = originalSession.seq) => {
        if (from === originalBoundary && to > from) return []
        return nativeSnapshot(from, to)
      },
    )
    fixture.agent.inject.mockImplementationOnce(() => {
      originalSession.append('user/message', context as never, { surfaceOp: 'append' })
      throw new Error('post-commit observer failed')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(fixture.agent.inject).toHaveBeenCalledOnce()
    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })

    const replacement = {
      id: 'lead',
      session: restoreFeedbackSession(originalSession),
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    fixture.replaceCurrentAgent(replacement as never)
    await fixture.lease.flushHostFeedback?.()

    expect(replacement.inject).not.toHaveBeenCalled()
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(false)
  })

  it.each(['prefix', 'header'] as const)(
    'rejects a same-id same-sequence restored Session with a different %s',
    async (difference) => {
      const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true)
      const originalSession = fixture.session as Session
      fixture.lease.beginPrompt(new AbortController().signal)
      const context = createUserMessage({
        source: { kind: 'test' } as never,
        content: [{ type: 'text', text: 'retained feedback across restart' }],
      })
      fixture.agent.inject.mockImplementation(() => {
        throw new Error('inject remains unconfirmed')
      })
      fixture.execute.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'tool result' }],
        isError: false,
        additionalContexts: [context],
      } as never)

      const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
      expect(result.isError).toBe(true)
      fixture.lease.endPrompt({ stopReason: 'end_turn' })
      await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
        code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
      })

      const events = originalSession.snapshotEvents().map((event) => structuredClone(event))
      let header = originalSession.header
      if (difference === 'prefix') {
        const openingIndex = events.findIndex((event) => event.type === 'turn/start')
        const opening = events[openingIndex] as SessionEvent<'turn/start'>
        events[openingIndex] = { ...opening, time: opening.time + 1 }
      } else header = { ...originalSession.header, cwd: '/different-native-session-header' }
      const differentSession = restoreFeedbackSession(originalSession, events, header, 'detached')
      expect(differentSession.id).toBe(originalSession.id)
      expect(differentSession.seq).toBe(originalSession.seq + 1)
      const replacement = {
        id: 'lead',
        session: differentSession,
        inbox: { nextStep: [], nextTurn: [] },
        steer: vi.fn(),
        inject: vi.fn(),
      }
      fixture.replaceCurrentAgent(replacement as never)

      await expect(fixture.lease.flushHostFeedback?.()).rejects.toMatchObject({
        code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
      })
      expect(replacement.inject).not.toHaveBeenCalled()
      expect(fixture.lease.hasRetainedFeedback?.()).toBe(true)
    },
  )

  it('hashes own __proto__ JSON fields when validating restored session history', async () => {
    const leftSource = JSON.parse('{"kind":"user","metadata":{"__proto__":{"marker":"left"}}}')
    const rightSource = JSON.parse('{"kind":"user","metadata":{"__proto__":{"marker":"right"}}}')
    const originalSession = createFeedbackSession(leftSource)
    const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true, originalSession)
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'retained feedback with JSON extension' }],
    })
    fixture.agent.inject.mockImplementation(() => {
      throw new Error('inject remains unconfirmed')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)
    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    fixture.lease.endPrompt({ stopReason: 'end_turn' })
    await expect(fixture.lease.drainPrompt?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })

    const events = originalSession.snapshotEvents().map((event) => structuredClone(event))
    const userEventIndex = events.findLastIndex((event) => event.type === 'user/message')
    const userEvent = events[userEventIndex] as SessionEvent<'user/message'>
    events[userEventIndex] = { ...userEvent, data: { ...userEvent.data, source: rightSource as never } }
    const differentSession = restoreFeedbackSession(originalSession, events, originalSession.header, 'detached')
    expect(differentSession.id).toBe(originalSession.id)
    expect(differentSession.seq).toBe(originalSession.seq + 1)
    const replacement = {
      id: 'lead',
      session: differentSession,
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    fixture.replaceCurrentAgent(replacement as never)
    await expect(fixture.lease.flushHostFeedback?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })
    expect(replacement.inject).not.toHaveBeenCalled()
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(true)
  })

  it('never sends retained feedback to an Agent with a different native Session', async () => {
    const fixture = await setup(undefined, [], true, 'lead', undefined, undefined, true)
    fixture.lease.beginPrompt(new AbortController().signal)
    const context = createUserMessage({
      source: { kind: 'test' } as never,
      content: [{ type: 'text', text: 'retained feedback for the original session' }],
    })
    fixture.agent.inject.mockImplementation(() => {
      throw new Error('transient inject failure')
    })
    fixture.execute.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool result' }],
      isError: false,
      additionalContexts: [context],
    } as never)

    const result = await fixture.client.callTool({ name: 'list_agents', arguments: {} })
    expect(result.isError).toBe(true)
    const replacement = {
      id: 'lead',
      session: { seq: 0, snapshotEvents: vi.fn(() => []) },
      inbox: { nextStep: [], nextTurn: [] },
      steer: vi.fn(),
      inject: vi.fn(),
    }
    fixture.replaceCurrentAgent(replacement as never)

    await expect(fixture.lease.flushHostFeedback?.()).rejects.toMatchObject({
      code: 'ACP_HOST_FEEDBACK_COMMIT_FAILED',
    })
    expect(replacement.inject).not.toHaveBeenCalled()
    expect(fixture.lease.hasRetainedFeedback?.()).toBe(true)
  })

  it('defers wait_agent before Host execution when a Team message is queued for the caller', async () => {
    const events: LiveDiagnosticEvent[] = []
    const remove = installLiveDiagnosticTrace(
      Object.assign(
        (event: LiveDiagnosticEvent) => {
          events.push(event)
        },
        {
          id: () => `h:${'a'.repeat(24)}`,
          fingerprint: () => ({ hmac: `h:${'b'.repeat(24)}`, bytes: 0, complete: true }),
        },
      ),
    )
    diagnosticRemovers.push(remove)
    const { lease, client, execute, agent } = await setup()
    lease.beginPrompt(new AbortController().signal)
    const queuedReply = createUserMessage({
      source: { kind: 'team-message' } as never,
      content: [{ type: 'text', text: 'PRIVATE_QUEUED_TEAM_REPLY' }],
    })
    agent.inbox.nextStep.push(queuedReply)

    const result = await client.callTool({ name: 'wait_agent', arguments: { timeout_ms: 60_000 } })
    const returnedText = result.content.map((item) => ('text' in item ? item.text : '')).join('\n')

    expect(result.isError).toBe(true)
    expect(returnedText).toContain('A Team message is already queued for this caller')
    expect(returnedText).toContain('DSH did not execute wait_agent')
    expect(returnedText).toContain('End this ACP response now')
    expect(returnedText).not.toContain('no-active-peer')
    expect(returnedText).not.toContain('PRIVATE_QUEUED_TEAM_REPLY')
    expect(execute).not.toHaveBeenCalled()
    expect(agent.inbox.nextStep).toEqual([queuedReply])
    expect(
      events.filter((event) => event.type === 'host-execute/start' || event.type === 'host-execute/settled'),
    ).toEqual([])
    expect(events.map((event) => event.type)).not.toContain('team-message/receipt')
    expect(events.find((event) => event.type === 'mcp-handler/returned')).toMatchObject({
      type: 'mcp-handler/returned',
      tool: 'wait_agent',
      resultStatus: 'error',
      handlerIsError: true,
      inboxSnapshotStage: 'before-host-call',
      nextStepTeamMessageCount: 1,
    })
    expect(events.find((event) => event.type === 'mcp-handler/returned')).not.toHaveProperty('hostCallId')
  })

  it('executes wait_agent normally when no Team message is queued', async () => {
    const { lease, client, execute } = await setup()
    lease.beginPrompt(new AbortController().signal)

    const result = await client.callTool({ name: 'wait_agent', arguments: { timeout_ms: 1 } })

    expect(result.isError).not.toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ name: 'wait_agent' })
  })

  it('accepts the legacy initialize revision over Node Streamable HTTP', async () => {
    const { server, lease } = await setup()
    lease.beginPrompt(new AbortController().signal)
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'legacy-wire-fixture', version: '1' },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ result: { protocolVersion: '2025-03-26' } })
    const listed = await rawMcp(server, { id: 2, method: 'tools/list', params: {} }, '2025-03-26')
    expect(await listed.json()).toMatchObject({
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'list_agents' })]) },
    })
    const called = await rawMcp(
      server,
      { id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } },
      '2025-03-26',
    )
    expect(await called.json()).toMatchObject({
      result: { isError: false, content: [{ type: 'text', text: 'list_agents' }] },
    })
  })
  it('applies the resolved host policy to all exact DSH tools and fails closed on missing policy or ambiguous options', async () => {
    const auto = await setup(undefined, ['file_write'], false, 'lead', async () => 'auto')
    auto.lease.beginPrompt(new AbortController().signal)
    const write = auto.tools[0]!.name
    const decision = await auto.lease.inspectPermission!(auto.permission(write))
    expect(decision).toMatchObject({
      reason: 'auto-approved',
      toolName: 'file_write',
      response: { outcome: { outcome: 'selected', optionId: 'yes' } },
    })
    const ambiguous = await auto.lease.inspectPermission!({
      ...auto.permission(write),
      options: [
        { optionId: 'same', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'same', kind: 'allow_always', name: 'Always' },
      ],
    })
    expect(ambiguous).toMatchObject({ reason: 'allow-once-unavailable' })
    const emptyOption = await auto.lease.inspectPermission!({
      ...auto.permission(write),
      options: [{ optionId: '', kind: 'allow_once', name: 'Allow once' }],
    })
    expect(emptyOption).toMatchObject({ reason: 'allow-once-unavailable' })
    const oversizedOption = await auto.lease.inspectPermission!({
      ...auto.permission(write),
      options: [{ optionId: 'x'.repeat(513), kind: 'allow_once', name: 'Allow once' }],
    })
    expect(oversizedOption).toMatchObject({ reason: 'allow-once-unavailable' })
    const oversizedToolCall = await auto.lease.inspectPermission!({
      ...auto.permission(write),
      toolCall: {
        ...auto.permission(write).toolCall,
        toolCallId: 'x'.repeat(513),
      },
    })
    expect(oversizedToolCall).toMatchObject({ reason: 'allow-once-unavailable' })

    const ask = await setup(undefined, ['file_write'], false, 'lead', async () => 'ask')
    ask.lease.beginPrompt(new AbortController().signal)
    expect(await ask.lease.inspectPermission!(ask.permission(ask.tools[0]!.name))).toMatchObject({
      reason: 'approval-required',
    })

    const unavailable = await setup(undefined, ['file_write'], false, 'lead', async () => {
      throw new Error('storage unavailable')
    })
    unavailable.lease.beginPrompt(new AbortController().signal)
    expect(
      await unavailable.lease.inspectPermission!(unavailable.permission(unavailable.tools[0]!.name)),
    ).toMatchObject({
      reason: 'policy-unavailable',
      response: { outcome: { outcome: 'cancelled' } },
    })
  })
  it('snapshots the plugin default at bridge admission and follows the current Lead value for teammates', async () => {
    let pluginDefault: 'auto' | 'ask' = 'auto'
    const policies = new Map<string, 'auto' | 'ask'>()
    const resolver = (sessionId: string) => async (): Promise<'auto' | 'ask'> => {
      if (!policies.has(sessionId)) policies.set(sessionId, pluginDefault)
      return policies.get(sessionId)!
    }
    const lead = await setup(undefined, ['file_write'], true, 'lead', resolver('lead'))
    pluginDefault = 'ask'
    lead.lease.beginPrompt(new AbortController().signal)
    const first = await lead.lease.inspectPermission!(lead.permission('file_write'))
    expect(first.reason).toBe('auto-approved')
    policies.set('lead', 'ask')
    expect((await lead.lease.inspectPermission!(lead.permission('file_write'))).reason).toBe('approval-required')

    const member = await setup(undefined, ['send_message'], true, 'teammate', async () => policies.get('lead')!)
    member.lease.beginPrompt(new AbortController().signal)
    expect((await member.lease.inspectPermission!(member.permission('send_message'))).reason).toBe('approval-required')
  })
  it('automatically approves scoped DSH tools when Auto is selected, without enabling unregistered Agent tools', async () => {
    const { ctx, client, lease, name, permission, tools, execute, definitions } = await setup(
      undefined,
      ['project_lookup'],
      false,
    )
    expect(tools).toHaveLength(1)
    expect(name).toBe('project_lookup')
    lease.beginPrompt(new AbortController().signal)
    expect((await lease.permission(permission(name)))?.outcome).toEqual({ outcome: 'selected', optionId: 'yes' })
    await client.callTool({ name, arguments: { query: 'test' } })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project_lookup', arguments: { query: 'test' } }),
    )
    expect((await client.callTool({ name: 'bash' })).isError).toBe(true)
    const schemas = [{ name: 'project_lookup', description: 'project_lookup', parameters: { type: 'object' } }]
    const key = teamBridgeKey(ctx, 'lead', schemas)
    expect(teamBridgeKey(ctx, 'lead', schemas)).toBe(key)
    definitions.set('project_lookup', { name: 'project_lookup' })
    expect(teamBridgeKey(ctx, 'lead', schemas)).not.toBe(key)
    await expect(client.callTool({ name })).rejects.toThrow()
  })
  it('does not retain the legacy Team auto-approval when no host policy resolver is wired', async () => {
    const fixture = await setup(undefined, ['file_write'], false)
    const lease = (await createTeamBridge(
      fixture.ctx,
      'lead',
      { mcpCapabilities: { http: true } },
      undefined,
      undefined,
      undefined,
      [...fixture.definitions.values()].map((definition) => ({
        name: definition.name,
        description: definition.description ?? definition.name,
        parameters: definition.parameters,
      })),
    ))!
    cleanup.push(() => lease.close())
    lease.beginPrompt(new AbortController().signal)
    const server = lease.servers[0]!
    const decision = await lease.inspectPermission!({
      ...fixture.permission(),
      toolCall: { toolCallId: 'unconfigured-policy', name: `mcp__${server.name}__file_write` },
    })
    expect(decision).toMatchObject({ reason: 'approval-required' })
    expect(decision.response).toBeUndefined()
  })
  it('discovers added tools on reconnection and revokes a removed or restricted capability', async () => {
    const { ctx, lease, client, name, hidden, definitions, listeners } = await setup(undefined, ['present'], false)
    const beforeSchemas = [{ name: 'present', description: 'present', parameters: { type: 'object', properties: {} } }]
    const before = teamBridgeKey(ctx, 'lead', beforeSchemas)
    definitions.set('new_plugin', { name: 'new_plugin', description: 'New plugin', parameters: { type: 'object' } })
    const nextSchemas = [
      ...beforeSchemas,
      { name: 'new_plugin', description: 'New plugin', parameters: { type: 'object' } },
    ]
    expect(teamBridgeKey(ctx, 'lead', nextSchemas)).not.toBe(before)
    // New tools join the next connection; the current advertised capability stays stable.
    expect((await client.listTools()).tools).toHaveLength(1)
    const next = (await createTeamBridge(
      ctx,
      'lead',
      { mcpCapabilities: { http: true } },
      undefined,
      undefined,
      undefined,
      nextSchemas,
    ))!
    cleanup.push(() => next.close())
    const nextServer = next.servers[0]!
    if (!('url' in nextServer)) throw new Error('Expected HTTP')
    const nextClient = new Client({ name: 'next', version: '1' })
    await nextClient.connect(new StreamableHTTPClientTransport(new URL(nextServer.url)))
    cleanup.push(() => nextClient.close())
    expect((await nextClient.listTools()).tools.map((tool) => tool.name)).toEqual(['new_plugin', 'present'])
    hidden.add('present')
    listeners.get('tools/change')!()
    expect(next.signal.aborted).toBe(true)
    lease.beginPrompt(new AbortController().signal)
    await expect(client.callTool({ name })).rejects.toThrow()
  })

  it('does not expose global tools hidden from this agent or team tools to non-members', async () => {
    const { ctx, definitions, hidden, services } = await setup(undefined, ['present', 'spawn_teammate'], false)
    hidden.add('present')
    expect(await createTeamBridge(ctx, 'lead', {})).toBeUndefined()
    expect(definitions.has('present')).toBe(true)
    expect((services.tools as { schemas(scope?: unknown): unknown[] }).schemas()).toEqual([])
  })
  it('publishes only model-visible schemas and invalidates the key when those schemas change', async () => {
    const fixture = await setup(undefined, ['file_read', 'file_write'], false)
    const readSchema = { name: 'file_read', description: 'Visible read', parameters: { type: 'object' } }
    const firstKey = teamBridgeKey(fixture.ctx, 'lead', [readSchema])
    expect(teamBridgeKey(fixture.ctx, 'lead', [readSchema])).toBe(firstKey)
    expect(teamBridgeKey(fixture.ctx, 'lead', [{ ...readSchema, description: 'Changed schema' }])).not.toBe(firstKey)
    expect(teamBridgeKey(fixture.ctx, 'lead', undefined)).toBeUndefined()
    const lease = (await createTeamBridge(
      fixture.ctx,
      'lead',
      { mcpCapabilities: { http: true } },
      undefined,
      undefined,
      undefined,
      [readSchema],
    ))!
    cleanup.push(() => lease.close())
    const server = lease.servers[0]!
    if (!('url' in server)) throw new Error('Expected HTTP')
    const client = new Client({ name: 'visible-schema', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    cleanup.push(() => client.close())
    expect((await client.listTools()).tools.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: 'file_read', description: 'Visible read' },
    ])
  })
  it.each(['native', 'ptc', 'both'] as const)(
    'uses official assembled %s schemas as the bridge directory and preserves ToolRuntime execution limits',
    async (mode) => {
      const dsh = new CordisContext()
      const systemPromptFiber = await dsh.plugin(SystemPrompt, {})
      const ptcFiber = mode === 'native' ? undefined : await dsh.plugin(BridgeFakePtcRuntime)
      const runtimeFiber = await dsh.plugin(ToolRuntime, { mode })
      cleanup.push(async () => {
        await runtimeFiber.dispose()
        await ptcFiber?.dispose()
        await systemPromptFiber.dispose()
      })
      const runtime = dsh.tools
      let executions = 0
      dsh.tools.register(
        defineTool({
          name: 'file_read',
          description: 'Read a file.',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: () => {
            executions += 1
            return Promise.resolve('read')
          },
        }),
      )
      const agent = {
        id: 'assembled-agent',
        inbox: { nextStep: [] },
        session: { header: { cwd: process.cwd() }, append: vi.fn() },
        steer: vi.fn(),
      }
      const assembly = await dsh.systemPrompt.assemble({ scope: agent as never })
      const expected =
        mode === 'native' ? ['file_read'] : mode === 'ptc' ? [RUN_CODE_NAME] : ['file_read', RUN_CODE_NAME]
      expect(assembly.tools.map((schema) => schema.name).sort()).toEqual([...expected].sort())
      const bridgeCtx = {
        on: (name: string, listener: (...args: unknown[]) => void) => dsh.on(name as never, listener as never),
        get: (name: string) => {
          if (name === 'agents') return { get: (id: string) => (id === agent.id ? agent : undefined) }
          if (name === 'agentTeams' || name === 'attachments') return undefined
          return dsh.get(name as never)
        },
      } as unknown as Context
      const lease = (await createTeamBridge(
        bridgeCtx,
        agent.id,
        { mcpCapabilities: { http: true } },
        undefined,
        async () => 'auto',
        undefined,
        assembly.tools,
      ))!
      cleanup.push(() => lease.close())
      const server = lease.servers[0]!
      if (!('url' in server)) throw new Error('Expected HTTP')
      const client = new Client({ name: `official-${mode}`, version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
      cleanup.push(() => client.close())
      const listed = (await client.listTools()).tools.map((schema) => schema.name).sort()
      expect(listed).toEqual([...expected].sort())
      const instructions = client.getInstructions() ?? ''
      expect(instructions).toContain('Tools and skills discovered in DSH context')
      expect(instructions).toContain("do not route them through the Agent's native skill invocation")
      expect(lease.instructions).toContain('Tools and skills discovered in DSH context')
      expect(lease.instructions).toContain("do not route them through the Agent's native skill invocation")
      if (mode === 'native') {
        expect(instructions).toContain('No DSH skill-loading entry point is listed')
        expect(lease.instructions).toContain('No DSH skill-loading entry point is listed')
      } else {
        expect(instructions).toContain(`call it inside "${RUN_CODE_NAME}"`)
        expect(instructions).toContain('host-provided SDK instructions')
        expect(instructions).toContain('do not invent a direct skill tool')
        expect(lease.instructions).toContain(`call it inside "${RUN_CODE_NAME}"`)
        expect(lease.instructions).toContain('host-provided SDK instructions')
      }
      lease.beginPrompt(new AbortController().signal)
      const result = await runtime.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`bridge-${mode}`),
        name: 'file_read',
        arguments: { path: '/tmp/file' },
        agent: agent as never,
      })
      if (mode === 'ptc') {
        expect(result.isError).toBe(true)
        expect(executions).toBe(0)
      } else {
        expect(result.isError).toBe(false)
        expect(executions).toBe(1)
        const mcpResult = await client.callTool({ name: 'file_read', arguments: { path: '/tmp/file' } })
        expect(mcpResult, JSON.stringify(mcpResult)).toMatchObject({ isError: false })
        expect(executions).toBe(2)
      }
    },
  )

  it('routes DSH skill-catalog entries through the listed skill tool and reports a missing entry point', async () => {
    const withSkill = await setup(undefined, ['skill'], false)
    const skillInstructions = withSkill.client.getInstructions() ?? ''
    expect(skillInstructions).toContain('The DSH MCP tool "skill" is listed')
    expect(skillInstructions).toContain('through that tool using its exact tools/list schema and names')
    expect(skillInstructions).toContain("do not route them through the Agent's native skill invocation")
    expect(withSkill.lease.instructions).toContain('The DSH MCP tool "skill" is listed')

    const withoutSkill = await setup(undefined, ['file_read'], false)
    const missingInstructions = withoutSkill.client.getInstructions() ?? ''
    expect(missingInstructions).toContain('No DSH skill-loading entry point is listed')
    expect(missingInstructions).toContain('explain that this DSH connection has no listed skill entry point')
    expect(withoutSkill.lease.instructions).toContain('No DSH skill-loading entry point is listed')
  })

  it('keeps correlated Codex MCP approvals manual when Ask is selected', async () => {
    const { lease, name, server } = await setup('codex', ['project_lookup'], false, 'lead', async () => 'ask')
    lease.beginPrompt(new AbortController().signal)
    const call = {
      toolCallId: 'custom',
      rawInput: { server: server.name, tool: name },
      _meta: { is_mcp_tool_call: true },
    }
    expect(
      await lease.elicitation!(
        {
          sessionId: 'acp',
          mode: 'form',
          message: 'Approve',
          toolCallId: 'custom',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call' },
        } as CreateElicitationRequest,
        call,
      ),
    ).toBeUndefined()
  })
  it('stays absent without a tool runtime or a live session', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(await createTeamBridge(ctx, 'lead', {})).toBeUndefined()
    const fixture = await setup()
    expect(await createTeamBridge(fixture.ctx, 'another', {})).toBeUndefined()
  })
  it('exports nine upstream schemas, dispatches exact identity, and rejects fork and unadvertised tool names', async () => {
    const { lease, client, tools, name, execute, agent } = await setup()
    expect(tools).toHaveLength(9)
    expect((await client.callTool({ name })).isError).toBe(true)
    lease.beginPrompt(new AbortController().signal)
    expect((await client.callTool({ name })).content).toEqual([{ type: 'text', text: 'list_agents' }])
    expect(execute.mock.calls[0]![0].agent).toBe(agent)
    expect((await client.callTool({ name: 'bash', arguments: { command: 'echo no' } })).isError).toBe(true)
    const spawn = tools.find((tool) => tool.name === 'spawn_teammate')!
    expect((await client.callTool({ name: spawn.name, arguments: { context: 'fork' } })).isError).toBe(true)
    for (const override of [
      { model: 'other' },
      { provider: 'acp-other' },
      { agent: 'other' },
      { reasoningEffort: 'high' },
    ]) {
      expect((await client.callTool({ name: spawn.name, arguments: { context: 'fresh', ...override } })).isError).toBe(
        true,
      )
    }
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('only suppresses approval for this live bridge identity; titles and old connections do not grant permission', async () => {
    const { lease, server, name, permission } = await setup()
    expect(await lease.permission(permission(name))).toBeUndefined()
    lease.beginPrompt(new AbortController().signal)
    expect((await lease.permission(permission(`mcp__${server.name}__${name}`)))?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    })
    expect(
      (
        await lease.permission({
          ...permission(),
          toolCall: { toolCallId: 'devin', _meta: { 'cognition.ai/toolName': `mcp__${server.name}__${name}` } },
        })
      )?.outcome,
    ).toEqual({ outcome: 'selected', optionId: 'yes' })
    expect(
      await lease.permission({ ...permission(), toolCall: { toolCallId: 'bare', name: 'list_agents' } }),
    ).toBeUndefined()
    const raw = { toolCallId: 'display', name: `mcp__${server.name}__${name}`, title: name }
    expect(lease.presentTool!(raw).title).toBe('list_agents')
    expect(raw.title).toBe(name)
    expect(lease.presentTool!({ toolCallId: 'display', title: 'Updated transport label' }).title).toBe('list_agents')
    expect(
      await lease.permission({
        ...permission(),
        toolCall: { toolCallId: 'fake', title: name, rawInput: { command: name } },
      }),
    ).toBeUndefined()
    const other = await setup()
    expect(await other.lease.permission(permission(name))).toBeUndefined()
    lease.endPrompt()
    expect(await lease.permission(permission(name))).toBeUndefined()
  })
  it('recognizes only CodeBuddy deferred inputs bound to this live bridge and presents their native tool', async () => {
    const { lease, server, tools, permission } = await setup('codebuddy', ['project_lookup'])
    lease.beginPrompt(new AbortController().signal)
    const nativeName = tools.find((tool) => tool.name === 'project_lookup')!.name
    const input = { query: 'known project' }
    const wrapped: RequestPermissionRequest = {
      ...permission(),
      toolCall: {
        toolCallId: 'deferred-valid',
        name: 'DeferExecuteTool',
        rawInput: { toolName: `mcp__${server.name}__${nativeName}`, params: input },
      },
    }
    expect(await lease.inspectPermission!(wrapped)).toMatchObject({
      reason: 'auto-approved',
      toolName: nativeName,
      identitySource: 'codebuddy-deferred-input',
      structuredIdentityPresent: true,
    })
    expect(await lease.permission(wrapped)).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(lease.presentTool!(wrapped.toolCall)).toEqual({
      ...wrapped.toolCall,
      name: nativeName,
      title: nativeName,
      rawInput: input,
    })
    expect(wrapped.toolCall.rawInput).toEqual({ toolName: `mcp__${server.name}__${nativeName}`, params: input })

    const noName = {
      ...wrapped,
      toolCall: {
        toolCallId: 'deferred-no-name',
        rawInput: { toolName: `mcp__${server.name}__${nativeName}`, params: input },
      },
    }
    expect(await lease.inspectPermission!(noName)).toMatchObject({ reason: 'auto-approved' })
    const qualifiedName = {
      ...wrapped,
      toolCall: {
        toolCallId: 'deferred-qualified-name',
        name: `mcp__${server.name}__${nativeName}`,
        rawInput: { toolName: `mcp__${server.name}__${nativeName}`, params: input },
      },
    }
    expect(await lease.inspectPermission!(qualifiedName)).toMatchObject({ reason: 'auto-approved' })
    const directQualifiedName = {
      ...permission(`mcp__${server.name}__${nativeName}`),
      toolCall: { toolCallId: 'direct-qualified', name: `mcp__${server.name}__${nativeName}` },
    }
    expect(await lease.inspectPermission!(directQualifiedName)).toMatchObject({
      reason: 'auto-approved',
      toolName: nativeName,
      identitySource: 'name',
    })
    const codexMetadataOnly = {
      ...permission(),
      toolCall: {
        toolCallId: 'codex-shape-only',
        rawInput: { server: server.name, tool: nativeName },
        _meta: { is_mcp_tool_call: true },
      },
    }
    expect(await lease.inspectPermission!(codexMetadataOnly)).toMatchObject({ reason: 'identity-unmatched' })
  })

  it('keeps CodeBuddy Ask and fails closed for generic, foreign, malformed, conflicting, unknown, or stale identities', async () => {
    const ask = await setup('codebuddy', ['project_lookup'], false, 'lead', async () => 'ask')
    ask.lease.beginPrompt(new AbortController().signal)
    const name = ask.tools.find((tool) => tool.name === 'project_lookup')!.name
    const deferred = (serverName: string, params: unknown = {}) => ({
      ...ask.permission(),
      toolCall: {
        toolCallId: 'deferred',
        name: 'DeferExecuteTool',
        rawInput: { toolName: `mcp__${serverName}__${name}`, params },
      },
    })
    const valid = deferred(ask.server.name)
    expect(await ask.lease.inspectPermission!(valid)).toMatchObject({
      reason: 'approval-required',
      toolName: name,
      identitySource: 'codebuddy-deferred-input',
    })
    expect(await ask.lease.permission(valid)).toBeUndefined()

    const generic = await setup(undefined, ['project_lookup'], false)
    generic.lease.beginPrompt(new AbortController().signal)
    const genericWrapper = {
      ...generic.permission(),
      toolCall: {
        toolCallId: 'generic-wrapper',
        name: 'DeferExecuteTool',
        rawInput: { toolName: `mcp__${generic.server.name}__${name}`, params: {} },
      },
    }
    expect(await generic.lease.inspectPermission!(genericWrapper)).toMatchObject({ reason: 'identity-unmatched' })
    expect(await generic.lease.permission(genericWrapper)).toBeUndefined()

    expect(await ask.lease.inspectPermission!(deferred('another_server'))).toMatchObject({
      reason: 'identity-unmatched',
    })
    expect(await ask.lease.inspectPermission!(deferred(ask.server.name, null))).toMatchObject({
      reason: 'identity-unmatched',
    })
    const conflict = deferred(ask.server.name) as RequestPermissionRequest
    conflict.toolCall._meta = { claudeCode: { toolName: 'mcp__other__project_lookup' } }
    expect(await ask.lease.inspectPermission!(conflict)).toMatchObject({ reason: 'identity-unmatched' })
    const nameConflict = {
      ...valid,
      toolCall: {
        ...valid.toolCall,
        name: 'mcp__other__project_lookup',
      },
    }
    expect(await ask.lease.inspectPermission!(nameConflict)).toMatchObject({ reason: 'identity-unmatched' })
    const codexMetaConflict = {
      ...valid,
      toolCall: {
        ...valid.toolCall,
        _meta: { is_mcp_tool_call: true },
        rawInput: {
          toolName: `mcp__${ask.server.name}__${name}`,
          params: {},
          server: 'other',
          tool: name,
        },
      },
    }
    expect(await ask.lease.inspectPermission!(codexMetaConflict)).toMatchObject({ reason: 'identity-unmatched' })

    const unknown = {
      ...ask.permission(),
      toolCall: {
        toolCallId: 'deferred-unknown',
        name: 'DeferExecuteTool',
        rawInput: { toolName: `mcp__${ask.server.name}__not_registered`, params: {} },
      },
    }
    expect(await ask.lease.inspectPermission!(unknown)).toMatchObject({ reason: 'invalid-tool-name' })
    expect(
      await ask.lease.permission({
        ...unknown,
        options: [
          { optionId: 'allow-id', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-id', kind: 'reject_once', name: 'Reject once' },
        ],
      }),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-id' } })

    ask.lease.endPrompt()
    expect(await ask.lease.inspectPermission!(valid)).toMatchObject({ reason: 'inactive-prompt' })
    expect(await ask.lease.permission(valid)).toBeUndefined()
  })
  it('uses identical native names while binding each connection to its own caller', async () => {
    const one = await setup('devin'),
      two = await setup('devin')
    expect(one.server.name).toBe('dsh')
    expect(two.server.name).toBe('dsh')
    expect(one.name).toBe('list_agents')
    expect(two.name).toBe(one.name)
    for (const fixture of [one, two]) {
      fixture.lease.beginPrompt(new AbortController().signal)
      expect((await fixture.lease.permission(fixture.permission('send_message')))?.outcome.outcome).toBe('selected')
      await fixture.client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'hello' } })
      expect(fixture.execute.mock.calls[0]![0].agent).toBe(fixture.agent)
    }
    expect(one.agent).not.toBe(two.agent)
    await one.lease.close()
    expect(await one.lease.permission(one.permission('send_message'))).toBeUndefined()
    expect(
      (await two.client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'still alive' } }))
        .isError,
    ).toBe(false)
  })
  it('reports only a successful nonempty teammate message to its own lead during the same prompt', async () => {
    const { lease, client, execute } = await setup('devin', [], true, 'teammate')
    const report = vi.fn()
    lease.beginPrompt(new AbortController().signal, report)
    await client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'Done' } })
    expect(report).toHaveBeenCalledTimes(1)
    await client.callTool({ name: 'send_message', arguments: { target: 'peer', message: 'Done' } })
    await client.callTool({ name: 'send_message', arguments: { target: 'lead', message: '   ' } })
    execute.mockResolvedValueOnce({ content: [{ type: 'text', text: 'failed' }], isError: true })
    await client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'Not queued' } })
    expect(report).toHaveBeenCalledTimes(1)

    const lead = await setup('devin')
    const leadReport = vi.fn()
    lead.lease.beginPrompt(new AbortController().signal, leadReport)
    await lead.client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'Done' } })
    expect(leadReport).not.toHaveBeenCalled()

    const changing = await setup('devin', [], true, 'teammate')
    const changingReport = vi.fn()
    changing.lease.beginPrompt(new AbortController().signal, changingReport)
    changing.execute.mockImplementationOnce(async () => {
      changing.membership.current.role = 'lead'
      return { content: [{ type: 'text', text: 'queued' }], isError: false }
    })
    await changing.client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'Done' } })
    expect(changingReport).not.toHaveBeenCalled()

    let release!: (result: { content: Array<{ type: 'text'; text: string }>; isError: boolean }) => void
    let started!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
          started()
        }),
    )
    const prompt = new AbortController()
    const oldPromptReport = vi.fn()
    lease.endPrompt()
    lease.beginPrompt(prompt.signal, oldPromptReport)
    const late = client.callTool({ name: 'send_message', arguments: { target: 'lead', message: 'Late completion' } })
    await executionStarted
    lease.endPrompt()
    const nextReport = vi.fn()
    expect(() => lease.beginPrompt(prompt.signal, nextReport)).toThrowError(
      expect.objectContaining({ code: 'ACP_HOST_GENERATION_STILL_ACTIVE' }),
    )
    release({ content: [{ type: 'text', text: 'queued' }], isError: false })
    await late.catch(() => undefined)
    await lease.drainPrompt?.()
    lease.beginPrompt(prompt.signal, nextReport)
    expect(oldPromptReport).not.toHaveBeenCalled()
    expect(nextReport).not.toHaveBeenCalled()
  })
  it('recognizes exact Devin MCP labels but never repairs malformed tool names into approval authority', async () => {
    const { lease, tools, permission, client, execute } = await setup('devin', ['bash', 'jira_get_issue'])
    lease.beginPrompt(new AbortController().signal)
    const wait = tools.find((tool) => tool.name === 'wait_agent')!.name
    const shell = tools.find((tool) => tool.name === 'bash')!.name
    const request = (title: string) => ({ ...permission(), toolCall: { toolCallId: title, title } })
    expect((await lease.permission(request(`Calling ${wait} from dsh`)))?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    })
    expect((await lease.permission(request(`Calling ${shell} from dsh`)))?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'yes',
    })
    expect(await lease.inspectPermission!(request(`Calling ${wait} from dsh`))).toMatchObject({
      reason: 'auto-approved',
      toolName: 'wait_agent',
      identitySource: 'devin-title',
    })
    expect(await lease.inspectPermission!(request(`Calling ${shell} from dsh`))).toMatchObject({
      reason: 'auto-approved',
      toolName: 'bash',
    })
    const masked: RequestPermissionRequest = request(`Calling ${wait} from dsh`)
    masked.toolCall.name = 'unmatched-structured-name'
    expect(await lease.inspectPermission!(masked)).toMatchObject({
      reason: 'identity-unmatched',
      identitySource: 'name',
      structuredIdentityPresent: true,
      titleMatchesCurrentTool: true,
    })
    expect(await lease.permission(masked)).toBeUndefined()
    const kanbanName = 'jira_get_issue'
    const kanbanCall: RequestPermissionRequest = {
      ...permission(),
      toolCall: { toolCallId: 'kanban-bare-name', name: kanbanName, title: `Calling ${kanbanName} from dsh` },
    }
    expect(await lease.inspectPermission!(kanbanCall)).toMatchObject({
      reason: 'auto-approved',
      toolName: kanbanName,
      identitySource: 'devin-title',
      structuredIdentityPresent: true,
    })
    expect(await lease.permission(kanbanCall)).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(
      await lease.inspectPermission!({ ...kanbanCall, toolCall: { toolCallId: 'bare-only', name: kanbanName } }),
    ).toMatchObject({ reason: 'identity-unmatched', identitySource: 'name' })
    expect(
      await lease.inspectPermission!({
        ...kanbanCall,
        toolCall: { ...kanbanCall.toolCall, toolCallId: 'name-conflict', name: 'bash' },
      }),
    ).toMatchObject({ reason: 'identity-unmatched', identitySource: 'name' })
    expect(
      await lease.inspectPermission!({
        ...kanbanCall,
        toolCall: {
          ...kanbanCall.toolCall,
          toolCallId: 'other-mcp',
          name: 'mcp__other__jira_get_issue',
        },
      }),
    ).toMatchObject({ reason: 'identity-unmatched', identitySource: 'name' })
    expect(
      await lease.inspectPermission!({
        ...kanbanCall,
        toolCall: {
          ...kanbanCall.toolCall,
          toolCallId: 'conflicting-devin-meta',
          _meta: { 'cognition.ai/toolName': 'mcp__other__jira_get_issue' },
        },
      }),
    ).toMatchObject({ reason: 'identity-unmatched', identitySource: 'devin-meta' })
    expect(
      await lease.inspectPermission!({
        ...kanbanCall,
        toolCall: {
          ...kanbanCall.toolCall,
          toolCallId: 'conflicting-claude-meta',
          _meta: { claudeCode: { toolName: 'mcp__other__jira_get_issue' } },
        },
      }),
    ).toMatchObject({ reason: 'identity-unmatched', identitySource: 'claude-meta' })
    const ask = await setup('devin', ['jira_get_issue'], false, 'lead', async () => 'ask')
    ask.lease.beginPrompt(new AbortController().signal)
    const askRequest: RequestPermissionRequest = {
      ...ask.permission(),
      toolCall: { toolCallId: 'kanban-ask', name: kanbanName, title: `Calling ${kanbanName} from dsh` },
    }
    expect(await ask.lease.inspectPermission!(askRequest)).toMatchObject({
      reason: 'approval-required',
      toolName: kanbanName,
      identitySource: 'devin-title',
    })
    expect(await ask.lease.permission(askRequest)).toBeUndefined()
    expect(await lease.inspectPermission!({ ...request(`Calling ${wait} from dsh`), options: [] })).toMatchObject({
      reason: 'allow-once-unavailable',
    })
    const raw = {
      toolCallId: 'bash',
      title: `Calling ${shell} from dsh`,
      rawInput: { command: 'sleep 20', description: 'Wait for teammates' },
    }
    expect(lease.presentTool!(raw)).toEqual({ ...raw, title: 'bash', name: 'bash', kind: 'execute' })
    expect(raw.title).toContain(shell)
    const malformed = `${wait}<arg_key>arguments</arg_key><arg_value>{"timeout_ms": 60000}`
    expect(await lease.permission(request(`Calling ${malformed} from dsh`))).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect((await client.callTool({ name: malformed, arguments: {} })).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    for (const title of [`Calling ${wait} from other`, `Calling ${wait} from dsh\nextra`]) {
      expect(await lease.permission(request(title))).toBeUndefined()
    }
    const other = await setup('codex')
    other.lease.beginPrompt(new AbortController().signal)
    expect(await other.lease.permission(request(`Calling ${wait} from dsh`))).toBeUndefined()
    lease.endPrompt()
    expect(await lease.permission(request(`Calling ${wait} from dsh`))).toBeUndefined()
  })
  it('rejects invalid Devin names owned by this connection without executing or repairing them', async () => {
    const { lease, tools, permission, execute } = await setup('devin', ['bash'])
    lease.beginPrompt(new AbortController().signal)
    const wait = tools.find((tool) => tool.name === 'wait_agent')!.name
    const malformed = `${wait}<arg_key>arguments</arg_key><arg_value>{"timeout_ms":60000}`
    const options: RequestPermissionRequest['options'] = [
      { optionId: 'persist-reject', kind: 'reject_always', name: 'Reject always' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject once' },
      ...permission().options,
    ]
    for (const toolCall of [
      { toolCallId: 'meta', _meta: { 'cognition.ai/toolName': `mcp__dsh__${malformed}` }, rawInput: {} },
      { toolCallId: 'name', name: `mcp__dsh__${malformed}` },
      { toolCallId: 'title', title: `Calling ${malformed} from dsh` },
      { toolCallId: 'unknown', name: 'mcp__dsh__nonexistent' },
    ]) {
      const request = { ...permission(), toolCall, options }
      expect(await lease.inspectPermission!(request)).toMatchObject({ reason: 'invalid-tool-name' })
      expect(await lease.permission(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
      expect(await lease.permission({ ...request, options: [options[0]!, options[2]!] })).toEqual({
        outcome: { outcome: 'cancelled' },
      })
    }
    expect(execute).not.toHaveBeenCalled()
    expect(await lease.permission({ ...permission(wait), options })).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes' },
    })
    expect(await lease.permission(permission(tools.find((tool) => tool.name === 'bash')!.name))).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes' },
    })
  })
  it('does not classify another connection or conflicting structured identity as its own invalid tool', async () => {
    const one = await setup('devin'),
      two = await setup('codex'),
      generic = await setup()
    for (const item of [one, two, generic]) item.lease.beginPrompt(new AbortController().signal)
    const invalid = `${one.name}<arg_key>arguments</arg_key>`
    expect(await two.lease.permission(one.permission(invalid))).toBeUndefined()
    expect(await one.lease.permission(one.permission(`mcp__other__${invalid}`))).toBeUndefined()
    expect(
      await one.lease.permission({
        ...one.permission('unknown'),
        toolCall: {
          toolCallId: 'conflict',
          name: 'unknown',
          title: `Calling ${invalid} from dsh`,
        },
      }),
    ).toBeUndefined()
    expect(await generic.lease.inspectPermission!(generic.permission(`${generic.name}<arg_key>`))).toMatchObject({
      reason: 'invalid-tool-name',
    })
    one.lease.endPrompt()
    expect(await one.lease.permission(one.permission(invalid))).toBeUndefined()
  })
  it('rejects hostile origins and capabilities after feature removal or tool replacement', async () => {
    const { lease, server, definitions, name, client, services } = await setup()
    lease.beginPrompt(new AbortController().signal)
    expect((await fetch(server.url, { headers: { Origin: 'https://example.com' } })).status).toBe(403)
    definitions.set('list_agents', {})
    await expect(client.callTool({ name })).rejects.toThrow()
    delete services.agentTeams
    expect((await fetch(server.url)).status).toBe(403)
  })
  it('propagates prompt cancellation to native execution and revokes coordination permission', async () => {
    const { lease, execute, client, name, permission } = await setup()
    const abort = new AbortController()
    lease.beginPrompt(abort.signal)
    execute.mockImplementationOnce(
      async (input) =>
        await new Promise((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: false }),
            { once: true },
          )
        }),
    )
    const pending = client.callTool({ name })
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    abort.abort()
    expect((await pending).content).toEqual([{ type: 'text', text: 'cancelled' }])
    expect(await lease.permission(permission(name))).toBeUndefined()
  })
  it('propagates an HTTP client cancellation into native tool execution', async () => {
    const { lease, execute, client, name } = await setup()
    lease.beginPrompt(new AbortController().signal)
    let receivedAbort!: (signal: AbortSignal) => void
    const executionStarted = new Promise<AbortSignal>((resolve) => {
      receivedAbort = resolve
    })
    execute.mockImplementationOnce(
      async (input) =>
        await new Promise((resolve) => {
          receivedAbort(input.signal)
          input.signal.addEventListener(
            'abort',
            () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: false }),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const pending = client.callTool({ name }, { signal: controller.signal })
    const signal = await executionStarted
    controller.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
  })
  it('matches legacy cancellation IDs, rejects duplicate active IDs, and isolates leases', async () => {
    const first = await setup(undefined, ['file_read'], false)
    const second = await setup(undefined, ['file_read'], false)
    first.lease.beginPrompt(new AbortController().signal)
    second.lease.beginPrompt(new AbortController().signal)
    const firstSignal = new Promise<AbortSignal>((resolve) => {
      first.execute.mockImplementationOnce(
        async (input) =>
          await new Promise((done) => {
            resolve(input.signal)
            input.signal.addEventListener('abort', () => done({ content: [], isError: true }), { once: true })
          }),
      )
    })
    const secondSignal = new Promise<AbortSignal>((resolve) => {
      second.execute.mockImplementationOnce(
        async (input) =>
          await new Promise((done) => {
            resolve(input.signal)
            input.signal.addEventListener('abort', () => done({ content: [], isError: true }), { once: true })
          }),
      )
    })
    const call = (server: typeof first.server) =>
      rawMcp(
        server,
        {
          id: 'shared-id',
          method: 'tools/call',
          params: { name: 'file_read', arguments: { path: '/tmp/file' } },
        },
        '2025-03-26',
      )
    const pendingFirst = call(first.server)
    const pendingSecond = call(second.server)
    const [firstAbort, secondAbort] = await Promise.all([firstSignal, secondSignal])
    const duplicate = await call(first.server)
    expect(await duplicate.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'ACP_TEAM_REQUEST_ID_COLLISION' }],
      },
    })
    expect(first.execute).toHaveBeenCalledTimes(1)
    await rawMcp(first.server, { method: 'notifications/cancelled', params: { requestId: 'unknown-id' } }, '2025-03-26')
    expect(firstAbort.aborted).toBe(false)
    await rawMcp(first.server, { method: 'notifications/cancelled', params: { requestId: 'shared-id' } }, '2025-03-26')
    await vi.waitFor(() => expect(firstAbort.aborted).toBe(true))
    expect(secondAbort.aborted).toBe(false)
    await rawMcp(second.server, { method: 'notifications/cancelled', params: { requestId: 'shared-id' } }, '2025-03-26')
    const [firstResult, secondResult] = await Promise.all([pendingFirst, pendingSecond])
    expect(await firstResult.json()).toMatchObject({ result: { isError: true } })
    expect(await secondResult.json()).toMatchObject({ result: { isError: true } })
    await vi.waitFor(() => expect(secondAbort.aborted).toBe(true))
    await rawMcp(first.server, { method: 'notifications/cancelled', params: { requestId: 'shared-id' } }, '2025-03-26')
    const reused = await call(first.server)
    expect(await reused.json()).toMatchObject({
      result: { isError: false, content: [{ type: 'text', text: 'file_read' }] },
    })
    expect(first.execute).toHaveBeenCalledTimes(2)
  })
  it('forwards cancellation through the stdio session proxy into native execution', async () => {
    const { lease, execute, server, name } = await setup()
    lease.beginPrompt(new AbortController().signal)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../src/runtime/session/team-mcp-stdio.ts', import.meta.url))],
      env: { DSH_ACP_TEAM_MCP_URL: server.url, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-cancellation-fixture', version: '1' })
    cleanup.push(async () => {
      await client.close()
      await transport.close()
    })
    await client.connect(transport)
    let receiveAbort!: (signal: AbortSignal) => void
    const executionStarted = new Promise<AbortSignal>((resolve) => {
      receiveAbort = resolve
    })
    execute.mockImplementationOnce(
      async (input) =>
        await new Promise((resolve) => {
          receiveAbort(input.signal)
          input.signal.addEventListener(
            'abort',
            () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: false }),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const pending = client.callTool({ name }, { signal: controller.signal })
    const signal = await executionStarted
    controller.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
  })
  it('releases the capability immediately when its native member is disposed or Teams is disabled', async () => {
    const first = await setup()
    first.listeners.get('agent/disposed')!({ agent: first.agent })
    expect(first.lease.signal.aborted).toBe(true)
    await first.lease.close()
    await expect(fetch(first.server.url)).rejects.toThrow()
    const second = await setup()
    delete second.services.agentTeams
    second.listeners.get('internal/service')!('agentTeams')
    expect(second.lease.signal.aborted).toBe(true)
    expect(second.listeners.size).toBe(0)
  })
  it('recognizes Kimi’s exact qualified title only on its runtime and current capability', async () => {
    const { lease, server, name, permission } = await setup('kimi')
    lease.beginPrompt(new AbortController().signal)
    expect(
      (
        await lease.permission({
          ...permission(),
          toolCall: { toolCallId: 'kimi', title: `mcp__${server.name}__${name}` },
        })
      )?.outcome,
    ).toEqual({ outcome: 'selected', optionId: 'yes' })
    expect(
      await lease.permission({ ...permission(), toolCall: { toolCallId: 'kimi', title: 'spawn_teammate' } }),
    ).toBeUndefined()
  })
  it('answers only a correlated Codex MCP approval with once scope, never other forms or servers', async () => {
    const { lease, server, name } = await setup('codex')
    const request: CreateElicitationRequest = {
      sessionId: 'acp',
      toolCallId: 'call',
      mode: 'form',
      message: 'not used as authority',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: {
        type: 'object',
        properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } },
        required: ['persist'],
      },
    }
    const toolCall = {
      toolCallId: 'call',
      _meta: { is_mcp_tool_call: true },
      rawInput: { server: server.name, tool: name, arguments: {} },
    }
    expect(await lease.elicitation!(request, toolCall)).toBeUndefined()
    lease.beginPrompt(new AbortController().signal)
    expect(await lease.elicitation!(request, toolCall)).toEqual({ action: 'accept', content: { persist: 'once' } })
    expect(await lease.elicitation!(request, undefined)).toBeUndefined()
    expect(await lease.elicitation!({ ...request, _meta: {} }, toolCall)).toBeUndefined()
    expect(
      await lease.elicitation!(request, { ...toolCall, rawInput: { server: 'other', tool: name } }),
    ).toBeUndefined()
    expect(
      await lease.elicitation!(
        { ...request, requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } },
        toolCall,
      ),
    ).toBeUndefined()
    lease.endPrompt()
    expect(await lease.elicitation!(request, toolCall)).toBeUndefined()
  })
  it('presents a verified host tool name without granting approval or losing extra request context', async () => {
    const { lease, name, server, definitions } = await setup('codex', ['glob'], false, 'lead', async () => 'ask')
    const call = {
      toolCallId: 'display',
      rawInput: { server: server.name, tool: name },
      _meta: { is_mcp_tool_call: true },
    }
    const request: CreateElicitationRequest = {
      sessionId: 'acp',
      toolCallId: 'display',
      mode: 'form',
      message: `Allow the ${server.name} MCP server to run tool "${name}"?`,
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: {
        type: 'object',
        properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } },
      },
    }
    expect(lease.elicitationToolName!(request, call)).toBeUndefined()
    lease.beginPrompt(new AbortController().signal)
    expect(lease.elicitationToolName!(request, call)).toBe('glob')
    expect(await lease.elicitation!(request, call)).toBeUndefined()
    expect(
      lease.elicitationToolName!({ ...request, message: request.message + ' Additional scope!' }, call),
    ).toBeUndefined()
    expect(lease.elicitationToolName!(request, { ...call, toolCallId: 'other' })).toBeUndefined()
    expect(lease.elicitationToolName!(request, { ...call, rawInput: { server: 'other', tool: name } })).toBeUndefined()
    expect(lease.elicitationToolName!({ ...request, _meta: {} }, call)).toBeUndefined()
    definitions.delete('glob')
    expect(lease.elicitationToolName!(request, call)).toBeUndefined()
  })
})
