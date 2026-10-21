import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, markAgentLoopRequest, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { createDshToolBridge } from '../../../src/host/tools/bridge.ts'
import type { AcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { DispatchLedgerStore, DispatchRecord } from '../../../src/runtime/session/dispatch-ledger.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const provider = 'acp-images'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

class Ledger implements DispatchLedgerStore {
  private readonly records = new Map<string, DispatchRecord>()
  async begin(record: DispatchRecord): Promise<void> {
    this.records.set(record.key, record)
  }
  async settle(_sessionId: string, key: string): Promise<void> {
    const record = this.records.get(key)
    if (record !== undefined) this.records.set(key, { ...record, state: 'settled' })
  }
  async read(_sessionId: string, key: string): Promise<DispatchRecord | undefined> {
    return this.records.get(key)
  }
}

interface RuntimeState {
  image: boolean | undefined
  model: string
  live: boolean
  prompts: unknown[]
}

async function harness() {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SystemPrompt, {}),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(AgentRegistry),
  ]
  cleanup.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  const states = new Map<string, RuntimeState>()
  const views = new Map<string, ReturnType<typeof withSessionFacts>>()
  let command = 'image-fixture'
  const data = Uint8Array.of(1, 2, 3)
  const image: ImageAttachmentRef = {
    attachmentId: AttachmentId('screenshot'),
    mediaType: 'image/png',
    bytes: data.byteLength,
    width: 1,
    height: 1,
  }
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1024,
      maxImageDimension: 1024,
      mediaTypes: ['image/png'],
    },
    saveImages: vi.fn(async (_inputs: readonly SaveImageAttachment[]) => [image]),
    readImage: vi.fn(async () => ({ ref: image, data })),
  } satisfies Pick<AttachmentStore, 'imageLimits' | 'saveImages' | 'readImage'>
  // The owning storage seam is intentionally narrower than Cordis Service lifecycle.
  ctx.provide('attachments', attachments as unknown as AttachmentStore)
  const sidecar = {
    append: async () => undefined,
    readLatestBinding: async () => undefined,
    readModeIntent: async () => undefined,
    readRecoveryState: async () => undefined,
    writeRecoveryState: async () => undefined,
    writeOptionSnapshot: async () => undefined,
  } as unknown as AcpSidecar
  const adapter = new AcpProfileAdapter(
    'images',
    () => ({ name: 'Image fixture', command, args: [], env: {} }),
    { ok: true, seam: undefined as never },
    (id) => views.get(id),
    new Ledger(),
    () => ({
      // A standalone discovery process is deliberately not sufficient proof.
      listModels: async () =>
        ['model-a', 'model-b'].map((id) => ({ provider, id, name: id, inputModalities: ['text', 'image'] as const })),
    }),
    (options) => {
      const state = states.get(options.diagnosticDshSessionId!)!
      const configOptions = () => [
        {
          id: 'model',
          category: 'model' as const,
          name: 'Model',
          type: 'select' as const,
          currentValue: state.model,
          options: ['model-a', 'model-b'].map((value) => ({ value, name: value })),
        },
      ]
      return {
        acpSessionId: `remote-${options.diagnosticDshSessionId}`,
        agentCapabilities: { promptCapabilities: { image: state.image === true } },
        get inputImageSupported() {
          return state.live ? state.image : undefined
        },
        get configOptions() {
          return configOptions()
        },
        initialize: async () => {
          state.live = true
        },
        start: async () => {
          state.live = true
        },
        setConfigOption: async (_id, value) => {
          state.model = String(value)
        },
        prompt: async (prompt, onUpdate) => {
          state.prompts.push(prompt)
          onUpdate({
            sessionId: `remote-${options.diagnosticDshSessionId}`,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture answer' } },
          })
          return { stopReason: 'end_turn' }
        },
        close: async () => {
          state.live = false
        },
      }
    },
    sidecar,
    attachments,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ctx,
  )
  ctx.llm.registerAdapter([provider], adapter)
  cleanup.push(() => adapter.close())

  const add = (
    id: string,
    imageSupported: boolean | undefined,
    content: ContentBlock[] = [{ type: 'text', text: 'Begin' }],
  ) => {
    const session = Session.create(SessionId(id))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    const message = createUserMessage({ source: { kind: 'user' }, content })
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider, model: 'model-a' } }, reason: 'initial' })
    const agent = {
      id: session.id,
      session,
      ctx,
      options: { provider, model: 'model-a' },
      inbox: { nextStep: [], nextTurn: [] },
    } as unknown as Agent
    const detach = ctx.agents.enter(agent, undefined)
    cleanup.push(detach)
    views.set(
      id,
      withSessionFacts({
        identity: session,
        header: { cwd: process.cwd() },
        workingDirectory: process.cwd(),
        inheritedEventCount: 0,
        snapshotEvents: () => session.snapshotEvents(),
      }),
    )
    const state: RuntimeState = { image: imageSupported, model: 'model-a', live: false, prompts: [] }
    states.set(id, state)
    const initialize = async () => {
      await ctx.agents.withInitiator(agent, async () => {
        let stopped = false
        for await (const chunk of ctx.llm.stream(
          markAgentLoopRequest({ provider, model: 'model-a', sessionId: session.id, messages: [message] }),
        )) {
          if (chunk.type === 'finish') {
            expect(chunk.reason, JSON.stringify(chunk.reason)).toMatchObject({ kind: 'stop' })
            stopped = true
          }
        }
        expect(stopped).toBe(true)
      })
    }
    return { agent, session, state, initialize, detach }
  }
  return {
    ctx,
    adapter,
    attachments,
    data,
    image,
    add,
    changeProfile: () => {
      command = 'replacement-image-fixture'
    },
  }
}

describe('session-scoped ACP image capability', () => {
  it('admits images only for an exact live caller, confirmed route and launch generation', async () => {
    const h = await harness()
    const owner = h.add('owner', true)
    const resolve = (model = 'model-a') =>
      h.ctx.agents.withInitiator(owner.agent, () => h.ctx.llm.resolveModelInfo(provider, model))
    expect((await resolve()).inputModalities).toBeUndefined()
    expect((await h.adapter.prepareCall(provider, 'model-a')).model.inputModalities).toBeUndefined()
    await owner.initialize()
    expect((await resolve()).inputModalities).toEqual(['text', 'image'])
    expect(
      (await h.ctx.agents.withInitiator(owner.agent, () => h.adapter.prepareCall(provider, 'model-a'))).model
        .inputModalities,
    ).toEqual(['text', 'image'])
    expect((await h.ctx.llm.resolveModelInfo(provider, 'model-a')).inputModalities).toBeUndefined()
    const unregistered = { ...owner.agent } as Agent
    expect(
      (await h.ctx.agents.withInitiator(unregistered, () => h.ctx.llm.resolveModelInfo(provider, 'model-a')))
        .inputModalities,
    ).toBeUndefined()

    owner.session.append('request/header', { header: { config: { provider, model: 'model-b' } }, reason: 'change' })
    expect((await resolve('model-b')).inputModalities).toBeUndefined()
    expect((await resolve('model-a')).inputModalities).toBeUndefined()
    owner.state.model = 'model-b'
    expect((await resolve('model-b')).inputModalities).toEqual(['text', 'image'])
    // Native continuation checks may still ask about the initial model: unknown
    // must not become text-only and strip a subsequent image request.
    expect((await resolve('model-a')).inputModalities).toBeUndefined()
    owner.state.live = false
    expect((await resolve('model-b')).inputModalities).toBeUndefined()
    owner.state.live = true
    owner.state.image = undefined
    expect((await resolve('model-b')).inputModalities).toBeUndefined()
    owner.state.image = false
    expect((await resolve('model-b')).inputModalities).toBeUndefined()
    owner.state.image = true
    h.changeProfile()
    expect((await resolve('model-b')).inputModalities).toBeUndefined()
  })

  it('preserves the native uploaded-image entry point before a live model proof exists', async () => {
    const h = await harness()
    const owner = h.add('uploaded-image', true, [
      { type: 'text', text: 'Inspect' },
      { type: 'image', attachment: h.image },
    ])
    await owner.initialize()
    expect(owner.state.prompts).toHaveLength(1)
    expect(owner.state.prompts[0]).toContainEqual({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from(h.data).toString('base64'),
    })
    expect(h.attachments.readImage).toHaveBeenCalled()
  })

  it('does not reuse a retired Session object capability for a replacement with the same durable id', async () => {
    const h = await harness()
    const old = h.add('replaced-owner', true)
    await old.initialize()
    old.detach()
    const replacement = h.add('replaced-owner', true)
    const info = await h.ctx.agents.withInitiator(replacement.agent, () =>
      h.ctx.llm.resolveModelInfo(provider, 'model-a'),
    )
    expect(info.inputModalities).toBeUndefined()
  })

  it('carries the actual MCP caller through the official screenshot projection without borrowing another session capability', async () => {
    const h = await harness()
    const capable = h.add('image-capable', true)
    const unknown = h.add('image-unknown', undefined)
    await capable.initialize()
    await unknown.initialize()
    const seen: Agent[] = []
    h.ctx.tools.register(
      createMcpToolDefinition(h.ctx, {
        name: 'browser_screenshot',
        rawName: 'screenshot',
        description: 'Fixture screenshot',
        inputSchema: { type: 'object', properties: {} },
        call: async () => {
          // Crossing an await verifies AsyncLocalStorage ownership, not merely an
          // execution argument that the native MCP image resolver never receives.
          await Promise.resolve()
          seen.push(h.ctx.agents.currentInitiator()!)
          return {
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', mimeType: 'image/png', data: Buffer.from(h.data).toString('base64') },
              { type: 'text', text: 'after' },
            ],
          }
        },
      }),
    )
    const connect = async (agent: Agent, imageSupported = true) => {
      const assembly = await h.ctx.systemPrompt.assemble({ scope: agent })
      const lease = (await createDshToolBridge(
        h.ctx as never,
        agent.id,
        { mcpCapabilities: { http: true }, promptCapabilities: { image: imageSupported } },
        undefined,
        async () => 'auto',
        undefined,
        assembly.tools,
      ))!
      cleanup.push(() => lease.close())
      lease.beginPrompt(new AbortController().signal)
      const server = lease.servers[0]!
      if (!('url' in server)) throw new Error('Expected HTTP MCP bridge')
      const client = new Client({ name: 'image-capability-fixture', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
      cleanup.push(() => client.close())
      return client
    }
    const a = await connect(capable.agent)
    const b = await connect(unknown.agent)
    const [positive, negative] = await Promise.all([
      a.callTool({ name: 'browser_screenshot', arguments: {} }),
      b.callTool({ name: 'browser_screenshot', arguments: {} }),
    ])
    expect(positive.isError).not.toBe(true)
    expect(positive.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(h.data).toString('base64') },
      { type: 'text', text: 'after' },
    ])
    expect(negative.isError).not.toBe(true)
    expect(negative.content.every((block) => block.type !== 'image')).toBe(true)
    expect(JSON.stringify(negative.content)).toContain('does not declare image input')
    expect(h.attachments.saveImages).toHaveBeenCalledTimes(1)
    expect(new Set(seen)).toEqual(new Set([capable.agent, unknown.agent]))
    expect(h.ctx.agents.currentInitiator()).toBeUndefined()

    const textConnection = await connect(capable.agent, false)
    const gated = await textConnection.callTool({ name: 'browser_screenshot', arguments: {} })
    expect(gated.content.every((block) => block.type !== 'image')).toBe(true)
    expect(JSON.stringify(gated.content)).toContain('image output is unavailable on this connection')
    expect(seen).toHaveLength(3)
    expect(h.attachments.saveImages).toHaveBeenCalledTimes(2)
  })
})
