import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createTeamBridge } from '../../../src/host/teams/bridge.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'bridge-feedback': { kind: 'bridge-feedback' }
  }
}

const cleanup: Array<() => Promise<unknown> | unknown> = []
const feedbackText = 'feedback from the bridged tool'

afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  )
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  firstResponse = toolCallResponse('native-step-call', 'native_step')
  beforeRequest?: (options: GenerateOptions, index: number) => Promise<void>
  private firstResponseGate: Promise<void> | undefined
  private releaseFirstResponseGate: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.push(options) - 1
    await this.beforeRequest?.(options, index)
    if (index === 0) await this.firstResponseGate
    if (index === 0 && options.signal?.aborted) throw new Error('request cancelled by test')
    const chunks = index === 0 ? this.firstResponse : textResponse('done')
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('request cancelled by test')
      yield chunk
    }
  }

  holdFirstResponse(): void {
    this.firstResponseGate = new Promise<void>((resolve) => {
      this.releaseFirstResponseGate = resolve
    })
  }

  releaseFirstResponse(): void {
    this.releaseFirstResponseGate?.()
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(id: string, name: string): StreamChunk[] {
  const callId = ToolCallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: '{}' },
    },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function messageTexts(request: GenerateOptions): string[] {
  return request.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
  )
}

function expectFeedbackOnce(request: GenerateOptions): void {
  expect(messageTexts(request).filter((text) => text === feedbackText)).toHaveLength(1)
}

async function createHarness(sessionId: string) {
  const ctx = new Context()
  const fibers: Fiber[] = [
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(SystemPrompt, {}),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(AgentLoop, { agents: [] }),
  ]
  cleanup.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })

  const bridgeExecutionEntered = Promise.withResolvers<void>()
  let bridgeGate: Promise<void> | undefined
  let releaseBridgeExecution: (() => void) | undefined
  const bridgedExecute = vi.fn(async () => {
    bridgeExecutionEntered.resolve()
    await bridgeGate
    return [{ type: 'text' as const, text: 'host tool completed' }]
  })
  let feedbackMessageId: string | undefined
  ctx.tools.register(
    defineContentToolFixture({
      name: 'bridge_feedback',
      description: 'A local test tool exposed over the bridge.',
      parameters: {},
      execute: bridgedExecute,
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'native_step',
      description: 'Continue the native agent loop.',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'native step completed' }]
      },
    }),
  )
  cleanup.push(
    ctx.on('tools/post-execute', async (exec): Promise<PostToolDecision> =>
      exec.name === 'bridge_feedback'
        ? (() => {
            const message = createUserMessage({
              content: [{ type: 'text', text: feedbackText }],
              source: { kind: 'bridge-feedback' },
            })
            feedbackMessageId = message.id
            return {
              kind: 'accept',
              additionalContexts: [message],
            }
          })()
        : { kind: 'accept' },
    ),
  )

  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['bridge-feedback-test'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(sessionId), {
    provider: 'bridge-feedback-test',
    model: 'scripted',
  })
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const lease = (await createTeamBridge(
    ctx as never,
    agent.id,
    { mcpCapabilities: { http: true } },
    undefined,
    async () => 'auto',
    undefined,
    assembly.tools,
  ))!
  cleanup.push(() => lease.close())

  const server = lease.servers[0]
  if (!server || !('url' in server)) throw new Error('Expected a local HTTP MCP server')
  const client = new Client({ name: 'bridge-agent-loop-feedback-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  cleanup.push(() => client.close())

  const invokeBridgeTool = async () => {
    return await client.callTool({ name: 'bridge_feedback', arguments: {} })
  }

  const holdBridgeExecution = () => {
    bridgeGate = new Promise<void>((resolve) => {
      releaseBridgeExecution = resolve
    })
  }

  const beginBridgePrompt = (signal: AbortSignal) => lease.beginPrompt(signal)
  return {
    ctx,
    agent: agent as Agent,
    adapter,
    bridgedExecute,
    invokeBridgeTool,
    beginBridgePrompt,
    lease,
    bridgeExecutionEntered: bridgeExecutionEntered.promise,
    get feedbackMessageId() {
      return feedbackMessageId
    },
    holdBridgeExecution,
    releaseBridgeExecution: () => releaseBridgeExecution?.(),
  }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('real AgentLoop and HTTP bridge feedback handoff', () => {
  it('accepts feedback when the native inject observer throws after inbox append', async () => {
    const fixture = await createHarness('bridge-feedback-observer-throws-after-append')
    fixture.adapter.beforeRequest = async (request, index) => {
      if (index === 0) fixture.beginBridgePrompt(request.signal!)
      if (index === 0) await fixture.invokeBridgeTool()
    }
    const originalInject = fixture.agent.inject.bind(fixture.agent)
    const inject = vi.spyOn(fixture.agent, 'inject').mockImplementation((message) => {
      originalInject(message)
      if ((message as { source?: { kind?: string } }).source?.kind === 'bridge-feedback')
        throw new Error('observer rejected after append')
    })

    send(fixture.agent, 'continue after accepted feedback')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(2)
    expectFeedbackOnce(fixture.adapter.requests[1]!)
    expect(inject).toHaveBeenCalledOnce()
    expect(fixture.lease.hasUncommittedFeedback?.()).toBe(false)
    const events = fixture.agent.session.snapshotEvents()
    expect(
      events.filter((event) => event.type === 'user/message' && event.data.id === fixture.feedbackMessageId),
    ).toHaveLength(1)
    expect(
      events
        .flatMap((event) => (event.type === 'agent/inbox/spliced' ? event.data.inserted : []))
        .filter((message) => message.id === fixture.feedbackMessageId),
    ).toHaveLength(1)
    fixture.lease.endPrompt()
    await fixture.lease.drainPrompt?.()
  })

  it('retries a provably unaccepted context once with the same id and does not duplicate feedback', async () => {
    const fixture = await createHarness('bridge-feedback-retries-same-context')
    fixture.adapter.beforeRequest = async (request, index) => {
      if (index === 0) fixture.beginBridgePrompt(request.signal!)
      if (index === 0) await fixture.invokeBridgeTool()
    }
    const originalInject = fixture.agent.inject.bind(fixture.agent)
    const injectedIds: string[] = []
    const inject = vi.spyOn(fixture.agent, 'inject').mockImplementation((message) => {
      const candidate = message as { id?: unknown; source?: { kind?: string } }
      if (candidate.source?.kind === 'bridge-feedback' && typeof candidate.id === 'string')
        injectedIds.push(candidate.id)
      if (injectedIds.length === 1) throw new Error('inject failed before append')
      originalInject(message)
    })

    send(fixture.agent, 'continue after local retry')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(2)
    expectFeedbackOnce(fixture.adapter.requests[1]!)
    expect(inject).toHaveBeenCalledTimes(2)
    expect(injectedIds).toEqual([fixture.feedbackMessageId, fixture.feedbackMessageId])
    expect(fixture.lease.hasUncommittedFeedback?.()).toBe(false)
    expect(
      fixture.agent.session
        .snapshotEvents()
        .filter((event) => event.type === 'user/message' && event.data.id === fixture.feedbackMessageId),
    ).toHaveLength(1)
    fixture.lease.endPrompt()
    await fixture.lease.drainPrompt?.()
  })

  it('admits active bridge additionalContexts in the same turn next native step exactly once', async () => {
    const fixture = await createHarness('bridge-feedback-active-turn')
    fixture.adapter.beforeRequest = async (request, index) => {
      if (index === 0) fixture.beginBridgePrompt(request.signal!)
      if (index === 0) await fixture.invokeBridgeTool()
    }

    send(fixture.agent, 'start native work')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(2)
    expect(messageTexts(fixture.adapter.requests[0]!).filter((text) => text === feedbackText)).toHaveLength(0)
    expectFeedbackOnce(fixture.adapter.requests[1]!)
    expect(fixture.bridgedExecute).toHaveBeenCalledOnce()
    const events = fixture.agent.session.snapshotEvents()
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    const feedbackEvents = events.filter(
      (event) => event.type === 'user/message' && event.data.source.kind === 'bridge-feedback',
    )
    expect(feedbackEvents).toHaveLength(1)
    expect(fixture.feedbackMessageId).toBeDefined()
    expect(feedbackEvents[0]).toMatchObject({ data: { id: fixture.feedbackMessageId } })
    const feedbackIndex = events.findIndex(
      (event) => event.type === 'user/message' && event.data.source.kind === 'bridge-feedback',
    )
    const admittedStep = events.slice(0, feedbackIndex).findLast((event) => event.type === 'step/start')
    expect(admittedStep).toMatchObject({ data: { turn: 1, step: 2 } })
    fixture.lease.endPrompt()
  })

  it('keeps feedback arriving after default cancellation without waking until a user message', async () => {
    const fixture = await createHarness('bridge-feedback-stop')
    fixture.holdBridgeExecution()
    let pendingBridgeCall: Promise<unknown> | undefined
    fixture.adapter.beforeRequest = async (request, index) => {
      if (index !== 0) return
      fixture.beginBridgePrompt(request.signal!)
      pendingBridgeCall = fixture.invokeBridgeTool().catch(() => undefined)
      await fixture.bridgeExecutionEntered
      fixture.agent.cancel({ kind: 'user' })
    }

    send(fixture.agent, 'stop after tool feedback')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(1)
    expect(fixture.agent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    fixture.releaseBridgeExecution()
    await pendingBridgeCall
    expect(fixture.agent.inbox.nextStep).toHaveLength(1)
    expect(fixture.adapter.requests).toHaveLength(1)
    fixture.lease.endPrompt()

    send(fixture.agent, 'consume the queued feedback')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(2)
    expectFeedbackOnce(fixture.adapter.requests[1]!)
    expect(messageTexts(fixture.adapter.requests[1]!)).toContain('consume the queued feedback')
    expect(fixture.bridgedExecute).toHaveBeenCalledOnce()
  })

  it('keeps late feedback through keepInbox cancellation and waits for an explicit user message', async () => {
    const fixture = await createHarness('bridge-feedback-keep-inbox')
    fixture.adapter.holdFirstResponse()
    fixture.holdBridgeExecution()
    let pendingBridgeCall: Promise<unknown> | undefined
    const cancelReached = Promise.withResolvers<void>()
    fixture.adapter.beforeRequest = async (request, index) => {
      if (index !== 0) return
      fixture.beginBridgePrompt(request.signal!)
      pendingBridgeCall = fixture.invokeBridgeTool().catch(() => undefined)
      await fixture.bridgeExecutionEntered
      fixture.agent.cancel({ kind: 'user' }, { keepInbox: true })
      cancelReached.resolve()
    }

    send(fixture.agent, 'cancel after tool feedback')
    await cancelReached.promise
    expect(fixture.agent.status).toBe('running')
    fixture.releaseBridgeExecution()
    if (pendingBridgeCall === undefined) throw new Error('Expected an active bridge call')
    await pendingBridgeCall
    expect(fixture.agent.status).toBe('running')
    fixture.adapter.releaseFirstResponse()
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(1)
    expect(fixture.agent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(fixture.agent.inbox.nextStep).toHaveLength(1)
    expect(fixture.adapter.requests).toHaveLength(1)
    fixture.lease.endPrompt()

    send(fixture.agent, 'consume feedback after cancellation')
    await fixture.agent.whenIdle()

    expect(fixture.adapter.requests).toHaveLength(2)
    expectFeedbackOnce(fixture.adapter.requests[1]!)
    expect(messageTexts(fixture.adapter.requests[1]!)).toContain('consume feedback after cancellation')
    expect(fixture.bridgedExecute).toHaveBeenCalledOnce()
  })
})
