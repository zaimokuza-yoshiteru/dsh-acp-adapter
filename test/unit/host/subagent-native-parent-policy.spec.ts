import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createAcpSidecar, type AcpBindingData } from '../../../src/persistence/sidecar.ts'
import { acpExecutionProjection } from '../../../src/host/composition/session-facts.ts'
import { installAcpBackendGuard } from '../../../src/host/composition/backend-guard.ts'
import { createToolApprovalPolicyReader } from '../../../src/host/subagent/tool-approval-policy.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class LocalAdapter extends LlmAdapter {
  readonly calls: string[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'local', name: 'local' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.provider)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'local response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'local response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function send(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'local request' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

type ResidualBinding = 'owned' | 'removed' | 'outdated'

async function setup(residual: ResidualBinding) {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-acp-native-parent-'))
  const sidecar = createAcpSidecar({ root })
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await sidecar.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.sessionProjections.register(acpExecutionProjection)
  const dispose = () => () => {}
  ctx.provide('typert', {
    lookups: { configure: dispose },
    contexts: { configureHost: dispose },
    resources: { register: dispose },
  } as never)
  ctx.provide('fileUploads', { registerAgentResolver: dispose } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'deepseek', model: 'local' }),
    saveSelection: async () => {},
  } as never)
  // The public Session Controller owns its model projection and delegates
  // selectModel to the published SessionCommandController implementation.
  const controller = new SessionController(ctx, {})
  const llm = new LocalAdapter()
  ctx.llm.registerAdapter(['acp-old', 'deepseek', 'acp-child'], llm)
  const mountGuard = (): Fiber => ctx.plugin((scope) => installAcpBackendGuard(scope, { sidecar }))
  const firstGuard = await mountGuard()
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'acp-old', model: 'local' })
  await send(parent)
  expect(llm.calls).toEqual(['acp-old'])
  const binding: AcpBindingData = {
    provider: 'acp-old',
    profileId: 'old',
    agentSessionId: 'old-acp-session',
    canonicalCwd: '/tmp',
    launchFingerprint: { command: 'fixture', args: [], envKeys: [] },
    agent: {},
    protocolVersion: 1,
    capabilityHash: 'cap',
    configHash: 'config',
    generation: 1,
    bindingEpoch: 1,
    committedPromptOrdinal: 1,
    historyBaseSeq: 0,
    establishedAt: 1,
    dshCommittedSeq: parent.session.seq,
  }
  const { capabilityHash: _capabilityHash, ...incomplete } = binding
  await sidecar.append(parent.id, {
    kind: 'binding',
    data: residual === 'outdated' ? (incomplete as AcpBindingData) : binding,
  })
  await expect(sidecar.readLatestBinding(parent.id)).resolves.toMatchObject({
    status: residual === 'outdated' ? 'outdated' : 'ok',
  })
  await sidecar.writeToolApprovalPolicy(parent.id, 'auto')
  const read = createToolApprovalPolicyReader(ctx, {
    sidecar,
    sessionOf: (id) => ctx.sessions.get(SessionId(id)),
    ownsProvider: (id) => id === 'child' || (residual !== 'removed' && id === 'old'),
    defaultPolicy: () => 'ask',
  })
  const createChild = async () =>
    (
      await ctx.agents.create({
        sessionId: SessionId('child'),
        agentOptions: { provider: 'acp-child', model: 'local' },
        meta: { parentSession: parent.id, origin: 'subagent' },
      })
    ).agent
  return { ctx, sidecar, llm, parent, createChild, read, controller, firstGuard, mountGuard }
}

it.each(['owned', 'removed', 'outdated'] as const)(
  'uses the default for a committed native parent with an %s residual ACP binding after remount',
  async (residual) => {
    const h = await setup(residual)
    // Simulate the request contribution's disable/remount lifecycle. This is
    // not a Plugin Manager UI or complete Loader integration test.
    await h.firstGuard.dispose()
    await h.controller.selectModel({ sessionId: h.parent.id, provider: 'deepseek', model: 'local' })
    await send(h.parent)
    expect(h.llm.calls).toEqual(['acp-old', 'deepseek'])
    expect(h.ctx.sessionProjections.stateOf(h.parent.session, 'modelSelection')?.lastUsed?.provider).toBe('deepseek')
    await h.mountGuard()
    await send(h.parent)
    expect(h.llm.calls).toEqual(['acp-old', 'deepseek', 'deepseek'])
    const child = await h.createChild()
    await expect(h.read(child.id)).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await expect(h.sidecar.readToolApprovalPolicy(h.parent.id)).resolves.toBe('auto')
  },
)

it.each(['owned', 'removed', 'outdated'] as const)(
  'does not treat a pending native selection as a completed switch with an %s ACP binding',
  async (residual) => {
    const h = await setup(residual)
    await h.controller.selectModel({ sessionId: h.parent.id, provider: 'deepseek', model: 'local' })
    expect(h.ctx.sessionProjections.stateOf(h.parent.session, 'modelSelection')).toMatchObject({
      lastUsed: { provider: 'acp-old' },
      pending: { provider: 'deepseek' },
    })
    const child = await h.createChild()
    if (residual === 'owned') {
      await expect(h.read(child.id)).resolves.toMatchObject({ policy: 'auto' })
    } else {
      await expect(h.read(child.id)).rejects.toThrow(
        residual === 'outdated' ? 'ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE' : 'ACP_TOOL_APPROVAL_SESSION_NOT_ACP',
      )
      await expect(h.sidecar.readToolApprovalPolicy(child.id)).resolves.toBeUndefined()
    }
  },
)

it.each(['removed', 'outdated'] as const)(
  'keeps a current ACP parent fail-closed with an %s binding',
  async (residual) => {
    const h = await setup(residual)
    const child = await h.createChild()
    await expect(h.read(child.id)).rejects.toThrow(
      residual === 'outdated' ? 'ACP_TOOL_APPROVAL_POLICY_UNAVAILABLE' : 'ACP_TOOL_APPROVAL_SESSION_NOT_ACP',
    )
    await expect(h.sidecar.readToolApprovalPolicy(child.id)).resolves.toBeUndefined()
  },
)
