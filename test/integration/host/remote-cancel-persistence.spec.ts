import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { acpExecutionProjection, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// Scripted ACP notifications isolate the reported failure ordering. Persistence,
// stream assembly, native cancellation, inbox admission and the adapter are real.
async function harness(cancelAt = 1, emitText = true, atomicSteering = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cancel-persistence-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const sidecar = createAcpSidecar({ root })
  cleanup.push(() => sidecar.dispose())
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.sessionProjections.register(acpExecutionProjection)
  const sessionId = SessionId('remote-cancel-persistence')
  let prompts = 0
  let steers = 0
  let streamingUpdate: Parameters<AcpProfileRuntime['prompt']>[1] | undefined
  const promptEntered = Promise.withResolvers<void>()
  const steeredFinish = Promise.withResolvers<void>()
  let beforeCancelled: (() => void) | undefined
  const adapter = new AcpProfileAdapter(
    'cancel-test',
    () => ({ name: 'Cancel test', command: 'scripted-acp', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    (id) => {
      const view = acpSessionView(ctx, ctx.sessions.get(id as never))
      // No permission operation is exercised by this stream-persistence fixture.
      return view === undefined
        ? undefined
        : Object.defineProperty(view, 'permissions', {
            value: { preset: null, sandbox: null, approval: null, seeded: false },
          })
    },
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    () => ({ listModels: async () => [{ id: 'scripted', name: 'Scripted', provider: 'acp-cancel-test' }] }),
    () => ({
      acpSessionId: 'same-remote-session',
      start: async () => undefined,
      restore: async () => 'reused',
      close: async () => undefined,
      canSteer: atomicSteering,
      steer: async (_input, onDispatched) => {
        onDispatched?.()
        steers += 1
        streamingUpdate?.({
          sessionId: 'same-remote-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after steering' } },
        })
        steeredFinish.resolve()
        return 'injected'
      },
      prompt: async (_input, onUpdate) => {
        prompts += 1
        streamingUpdate = onUpdate
        for (const text of !emitText
          ? []
          : prompts === cancelAt
            ? ['before rejection ', 'last visible chunk']
            : ['continued']) {
          onUpdate({
            sessionId: 'same-remote-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          })
        }
        promptEntered.resolve()
        if (atomicSteering && prompts === cancelAt) await steeredFinish.promise
        if (prompts === cancelAt) beforeCancelled?.()
        return { stopReason: prompts === cancelAt ? 'cancelled' : 'end_turn' }
      },
    }),
    sidecar,
  )
  ctx.llm.registerAdapter(['acp-cancel-test'], adapter)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'acp-cancel-test', model: 'scripted' }, { cwd: root })
  const session = agent.session
  cleanup.push(() => adapter.disposeSession({ id: session.id, identity: session }))
  return {
    agent,
    session,
    sidecar,
    promptEntered: promptEntered.promise,
    get steers() {
      return steers
    },
    get prompts() {
      return prompts
    },
    beforeCancelled(callback: () => void) {
      beforeCancelled = callback
    },
  }
}

describe('remote cancellation through the published native AgentLoop', () => {
  it('preserves interrupted text in the newly admitted native step after atomic steering', async () => {
    const h = await harness(1, true, true)
    h.agent.followup(user('first task'))
    await h.promptEntered
    h.agent.steer(user('adjust this task'))
    await h.agent.whenIdle()
    expect(h.prompts).toBe(1)
    expect(h.steers).toBe(1)
    const events = h.session.snapshotEvents()
    const messages = events.filter((event) => event.type === 'assistant/message')
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ data: { interrupted: true } })
    expect(JSON.stringify(messages[1]!.data.message.content)).toContain('after steering')
    expect(events.findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'hook' } } },
    })
  })

  it('does not invent an answer or provider error when the remote cancels before emitting text', async () => {
    const h = await harness(1, false)
    h.agent.followup(user('no visible answer yet'))
    await h.agent.whenIdle()
    expect(h.prompts).toBe(1)
    expect(h.session.snapshotEvents().filter((event) => event.type === 'assistant/message')).toHaveLength(0)
    expect(h.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'hook' } } },
    })
  })

  it('retains earlier completed rounds alongside the interrupted round', async () => {
    const h = await harness(2)
    h.agent.followup(user('completed first task'))
    await h.agent.whenIdle()
    const firstMessage = h.session.snapshotEvents().find((event) => event.type === 'assistant/message')
    expect(firstMessage).toBeDefined()
    h.agent.followup(user('reject second task'))
    await h.agent.whenIdle()
    const messages = h.session.snapshotEvents().filter((event) => event.type === 'assistant/message')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(firstMessage)
    expect(messages[1]).toMatchObject({ data: { interrupted: true } })
    const restored = Session.create(
      h.session.id,
      JSON.parse(JSON.stringify(h.session.snapshotEvents())),
      h.session.header,
    )
    expect(restored.deriveMessages()).toEqual(h.session.deriveMessages())
  })

  it('persists every delivered text chunk as interrupted and continues the same binding without replay', async () => {
    const h = await harness()
    h.agent.followup(user('first task'))
    await h.agent.whenIdle()
    const events = h.session.snapshotEvents()
    const messages = events.filter((event) => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      data: {
        interrupted: true,
        message: { content: [{ type: 'text', text: 'before rejection last visible chunk' }] },
      },
    })
    expect(events.findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'hook' } } },
    })
    expect(
      h.session
        .deriveMessages()
        .some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (block) => block.type === 'text' && block.text === 'before rejection last visible chunk',
            ),
        ),
    ).toBe(true)
    const restored = Session.create(h.session.id, JSON.parse(JSON.stringify(events)), h.session.header)
    expect(restored.deriveMessages()).toEqual(h.session.deriveMessages())
    expect(messages[0]).toMatchObject({
      data: {
        message: {
          source: { replayState: { response: { agentSessionId: 'same-remote-session', committedPromptOrdinal: 1 } } },
        },
      },
    })
    expect(h.prompts).toBe(1)
    h.agent.followup(user('continue'))
    await h.agent.whenIdle()
    expect(h.prompts).toBe(2)
    expect(h.session.snapshotEvents().filter((event) => event.type === 'assistant/message')).toHaveLength(2)
    expect(h.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'completed' } },
    })
  })

  it('preserves queued input without automatically executing it when the remote cancels', async () => {
    const h = await harness()
    h.beforeCancelled(() => h.agent.followup(user('queued next task')))
    h.agent.followup(user('first task'))
    await h.agent.whenIdle()
    expect(h.prompts).toBe(1)
    expect(h.agent.inbox.nextTurn).toHaveLength(1)
    expect(h.session.snapshotEvents().filter((event) => event.type === 'assistant/message')).toHaveLength(1)
  })
})
