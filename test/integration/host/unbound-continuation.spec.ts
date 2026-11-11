import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { installAcpBackendGuard } from '../../../src/host/composition/backend-guard.ts'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import { AcpSessionFacts, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// The published AgentLoop, session log, projections, guard, adapter and Sidecar are real; only the ACP wire is scripted.
async function harness(options: { failFirstStart?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-unbound-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const sidecar = createAcpSidecar({ root })
  cleanup.push(() => sidecar.dispose())
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AcpSessionFacts)
  installAcpBackendGuard(ctx, { sidecar, ownsProvider: (provider) => provider === 'acp-unbound' })
  const sessionId = SessionId('unbound-continuation')
  const prompts: string[] = []
  let starts = 0
  const adapter = new AcpProfileAdapter(
    'unbound',
    () => ({ name: 'Unbound', command: 'scripted-acp', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    (id) => acpSessionView(ctx, ctx.sessions.get(id as never)),
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    () => ({ listModels: async () => [{ id: 'scripted', name: 'Scripted', provider: 'acp-unbound' }] }),
    () => ({
      acpSessionId: 'remote-session',
      start: async () => {
        starts += 1
        if (options.failFirstStart === true && starts === 1) throw new Error('agent could not start')
      },
      restore: async () => 'reused',
      close: async () => undefined,
      prompt: async (input, onUpdate) => {
        prompts.push(JSON.stringify(input))
        onUpdate({
          sessionId: 'remote-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agent answer' } },
        })
        return { stopReason: 'end_turn' }
      },
    }),
    sidecar,
  )
  ctx.llm.registerAdapter(['acp-unbound'], adapter)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'acp-unbound', model: 'scripted' }, { cwd: root })
  cleanup.push(() => adapter.disposeSession({ id: agent.session.id, identity: agent.session }))
  const lastTurnEnd = () => agent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')
  return { ctx, agent, sidecar, prompts, lastTurnEnd }
}

describe('same-profile continuation of a session ACP never bound', () => {
  it('lets another plugin answer an ACP-routed session for several turns, then hands a later turn to ACP', async () => {
    const h = await harness()
    let intercept = true
    h.ctx.on('llm/stream', (_options, next) => {
      if (!intercept) return next()
      return (async function* answered() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'relayed' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'relayed' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    for (const text of ['first round', 'second round']) {
      h.agent.followup(user(text))
      await h.agent.whenIdle()
      expect(h.lastTurnEnd()).toMatchObject({ data: { reason: { kind: 'completed' } } })
    }
    expect(h.prompts).toHaveLength(0)
    expect(await h.sidecar.readRecoveryState(h.agent.session.id)).toBeUndefined()
    expect(await h.sidecar.readLatestBinding(h.agent.session.id)).toBeUndefined()

    intercept = false
    h.agent.followup(user('third round'))
    await h.agent.whenIdle()
    expect(h.lastTurnEnd()).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain('third round')
    // The Agent's first session receives the conversation it never saw, in order, before the current request.
    const order = ['not delivered to you', 'first round', 'relayed', 'second round', 'third round'].map((text) =>
      h.prompts[0]!.indexOf(text),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // A bound session receives only its current input again.
    h.agent.followup(user('fourth round'))
    await h.agent.whenIdle()
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain('fourth round')
    expect(h.prompts[1]).not.toContain('first round')
    expect(h.prompts[1]).not.toContain('not delivered to you')
    expect(await h.sidecar.readLatestBinding(h.agent.session.id)).toMatchObject({ status: 'ok' })
  })

  it('continues after a first turn that failed before its binding was saved', async () => {
    const h = await harness({ failFirstStart: true })
    h.agent.followup(user('first attempt'))
    await h.agent.whenIdle()
    expect(h.lastTurnEnd()).toMatchObject({ data: { reason: { kind: 'error' } } })
    expect(await h.sidecar.readLatestBinding(h.agent.session.id)).toBeUndefined()

    h.agent.followup(user('second attempt'))
    await h.agent.whenIdle()
    expect(h.lastTurnEnd()).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.indexOf('first attempt')).toBeGreaterThanOrEqual(0)
    expect(h.prompts[0]!.indexOf('first attempt')).toBeLessThan(h.prompts[0]!.indexOf('second attempt'))
    expect(await h.sidecar.readLatestBinding(h.agent.session.id)).toMatchObject({ status: 'ok' })
  })

  it('sends an ordinary first turn without any earlier-conversation preamble', async () => {
    const h = await harness()
    h.agent.followup(user('only message'))
    await h.agent.whenIdle()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain('only message')
    expect(h.prompts[0]).not.toContain('not delivered to you')
  })

  it('still gates a session whose ACP binding disappeared after ACP answered', async () => {
    const h = await harness()
    h.agent.followup(user('answered by the agent'))
    await h.agent.whenIdle()
    expect(h.prompts).toHaveLength(1)
    // Simulate a lost Sidecar: a fresh store has neither binding nor activity for this session.
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-unbound-empty-'))
    cleanup.push(() => fs.rmSync(emptyRoot, { recursive: true, force: true }))
    const empty = createAcpSidecar({ root: emptyRoot })
    cleanup.push(() => empty.dispose())
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    installAcpBackendGuard(
      {
        inject: (_keys: readonly string[], callback: (child: unknown) => void) =>
          callback({
            get: (name: string) => h.ctx.get(name as never),
            on: (_event: string, handler: typeof listener) => {
              listener = handler
            },
          }),
      } as never,
      { sidecar: empty, ownsProvider: (provider) => provider === 'acp-unbound' },
    )
    const config = { provider: 'acp-unbound', model: 'scripted' }
    await expect(listener!({ agent: { session: h.agent.session } }, async () => config)).rejects.toMatchObject({
      code: 'ACP_BACKEND_RECOVERY_REQUIRED',
    })
  })
})
