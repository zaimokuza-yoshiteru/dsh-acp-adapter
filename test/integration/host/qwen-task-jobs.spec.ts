import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { resolveQwenTaskJobs } from '../../../src/host/composition/qwen-task-jobs.ts'
import { acpExecutionProjection, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { QwenTaskJobOutcome } from '../../../src/runtime/session/qwen-background.ts'
import type { AcpPromptOptions } from '../../../src/runtime/session/session-runtime.ts'
import type * as acp from '@agentclientprotocol/sdk'

// Resolve the published implementations from the exact CLI dependency graph,
// without adding monorepo aliases or substituting registry/loop behavior.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const JobsLocal = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-jobs-local')).href)
const ToolJobs = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-jobs')).href)
const TeamTools = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-experimental-tool-agent-team')).href)

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'qwen-host-other': 'qwen-host-other'
  }
}

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const text = (blocks: readonly acp.ContentBlock[]) =>
  blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

async function harness(holdFirst = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-qwen-host-jobs-'))
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
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JobsLocal.default, {})
  await ctx.plugin(ToolJobs, {})
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => {
    events.push(event)
  })
  ctx.sessionProjections.register(acpExecutionProjection)
  const firstEntered = Promise.withResolvers<void>()
  const firstRelease = Promise.withResolvers<void>()
  const calls: Array<{ content: acp.ContentBlock[]; options: AcpPromptOptions }> = []
  // The ACP wire is covered by session-runtime-qwen.spec.ts. This fixture
  // keeps the actual registry, completion reporter, native inbox/admission,
  // AgentLoop and profile-adapter conversion real and observable.
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'qwen-host-remote',
    agentInfo: { name: 'qwen-code', version: '0.25.1' },
    start: async () => undefined,
    restore: async () => 'reused',
    close: async () => undefined,
    async prompt(content, onUpdate, _signal, _onReport, _onConclusion, _onTool, options = {}) {
      const number = calls.push({ content, options })
      if (number === 1) {
        firstEntered.resolve()
        if (holdFirst) await firstRelease.promise
      }
      onUpdate({
        sessionId: 'qwen-host-remote',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${number}` } },
      })
      return { stopReason: 'end_turn' }
    },
  }
  const adapter = new AcpProfileAdapter(
    'qwen-host',
    () => ({ name: 'Qwen host fixture', command: 'scripted', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    (id) => {
      const view = acpSessionView(ctx, ctx.sessions.get(id as never))
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
    () => ({ listModels: async () => [{ id: 'scripted', name: 'Scripted', provider: 'acp-qwen-host' }] }),
    () => runtime,
    sidecar,
  )
  ctx.llm.registerAdapter(['acp-qwen-host'], adapter)
  const agent = await ctx.agentLoop.create(
    SessionId('qwen-host-owner'),
    { provider: 'acp-qwen-host', model: 'scripted' },
    { cwd: root },
  )
  cleanup.push(() => adapter.disposeSession({ id: agent.id, identity: agent.session }))
  const jobs = ctx.get('jobs') as JobRegistry
  const start = resolveQwenTaskJobs(ctx, agent.id)!
  const job = (label: string) => {
    const result = Promise.withResolvers<QwenTaskJobOutcome>()
    const cancel = vi.fn(() => result.resolve({ status: 'killed', detail: 'cancelled', silent: true }))
    const handle = start(label, () => ({ done: result.promise, cancel }))
    expect(handle).toBeDefined()
    return { finish: result.resolve, cancel }
  }
  return {
    ctx,
    agent,
    jobs,
    job,
    calls,
    events,
    firstEntered: firstEntered.promise,
    releaseFirst: () => firstRelease.resolve(),
  }
}

describe('Qwen jobs through the published registry, reporter and AgentLoop', () => {
  it('carries the native Team policy and required identity through the admitted ACP request', async () => {
    const h = await harness()
    // Keep Team membership narrow; policy, scoped registrations, assembly,
    // native context admission and ACP prompt conversion are the real producers.
    h.ctx.provide('agentTeams', {
      tryMembership: () => ({ role: 'lead', name: 'lead' }),
      membership: () => ({ role: 'lead', name: 'lead' }),
    } as never)
    await h.ctx.plugin(TeamTools, { interrupt: false })
    h.agent.followup(user('Review this project'))
    await h.agent.whenIdle()
    expect(h.calls).toHaveLength(1)
    const prompt = text(h.calls[0]!.content)
    expect(prompt).toContain('Agent Teams is available in this session')
    expect(prompt).toContain('The Team Lead and all teammates share the same working directory and filesystem.')
    expect(prompt).toContain('The Lead must wait for required teammates before giving the final answer.')
    expect(prompt).toContain('You are the Team Lead named "lead".')
    expect(prompt).not.toContain('only when the user explicitly asks')
    expect(h.agent.session.requestHeader()?.tools?.some((tool) => tool.name === 'interrupt_agent')).toBe(false)
  })

  it('automatically wakes an idle owner and requests adoption without an extra prompt for unchanged context', async () => {
    const h = await harness()
    h.agent.followup(user('initial task'))
    await h.agent.whenIdle()
    expect(h.calls).toHaveLength(1)
    const task = h.job('Qwen task')
    const id = h.jobs.list(h.agent.id)[0]!.id
    expect(id).toMatch(/^acp-qwen-task-[0-9a-f]{16}$/)
    expect(h.events.filter((event) => event.type === 'job/registered')).toMatchObject([
      { data: { jobId: id, owner: h.agent.id, kind: 'acp-qwen-task', label: 'Qwen task' } },
    ])
    task.finish({ status: 'completed', detail: 'completed', silent: false })
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    await h.agent.whenIdle()
    expect(h.calls[1]!.options).toMatchObject({ adoptAgentTurn: true })
    expect(h.calls[1]!.options.followupContent).toBeUndefined()
    expect(h.jobs.list(h.agent.id)[0]?.status).toBe('completed')
    expect(h.events.filter((event) => event.type === 'job/settled')).toMatchObject([
      { data: { jobId: id, owner: h.agent.id, status: 'completed', producerReported: true } },
    ])
  })

  it('collects silent completions before native notice delivery and maps a native kill to the producer', async () => {
    const h = await harness()
    h.agent.followup(user('initial task'))
    await h.agent.whenIdle()
    const awaited: boolean[] = []
    h.jobs.events.subscribe({ owners: 'scope' }, (event) => {
      if (event.type === 'settled') awaited.push(event.awaited)
    })
    const silent = h.job('already observed')
    silent.finish({ status: 'completed', detail: 'completed', silent: true })
    await vi.waitFor(() => expect(awaited).toEqual([true]))
    const killed = h.job('cancel me')
    const id = h.jobs.list(h.agent.id).find((job) => job.label === 'cancel me')!.id
    h.jobs.kill(id, h.agent.id)
    await vi.waitFor(() => expect(h.jobs.get(id, h.agent.id).status).toBe('killed'))
    expect(killed.cancel).toHaveBeenCalledOnce()
    expect(awaited).toEqual([true, true])
    expect(h.calls).toHaveLength(1)
  })

  it('keeps mixed native completion and user input after the Qwen automatic turn', async () => {
    const h = await harness(true)
    h.agent.followup(user('initial task'))
    await h.firstEntered
    const qwen = h.job('Qwen task')
    const other = Promise.withResolvers<{ status: 'completed'; detail: string }>()
    const otherId = h.jobs.start({
      kind: 'qwen-host-other',
      label: 'native build',
      owner: h.agent.id,
      run: () => ({ done: other.promise, cancel: () => undefined }),
    })
    qwen.finish({ status: 'completed', detail: 'completed', silent: false })
    other.resolve({ status: 'completed', detail: 'completed' })
    await vi.waitFor(() => expect(h.jobs.get(otherId, h.agent.id).status).toBe('completed'))
    h.agent.inject(user('review the native build result'))
    h.releaseFirst()
    await h.agent.whenIdle()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.options.adoptAgentTurn).toBe(true)
    const followup = text(h.calls[1]!.options.followupContent ?? [])
    expect(followup).toContain('qwen-host-other: native build')
    expect(followup).toContain('review the native build result')
    expect(followup).not.toContain('background job acp-qwen-task-')
  })

  it('delivers a changed native runtime-context snapshot once, then avoids redundant follow-up prompts', async () => {
    const h = await harness()
    let workspace = 'workspace A'
    h.ctx.systemPrompt.context({ name: 'qwen-host-workspace', order: 1, text: () => workspace })
    h.agent.followup(user('initial task'))
    await h.agent.whenIdle()
    workspace = 'workspace B'
    h.job('Qwen task one').finish({ status: 'completed', detail: 'completed', silent: false })
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    await h.agent.whenIdle()
    expect(text(h.calls[1]!.options.followupContent ?? [])).toContain('workspace B')
    h.job('Qwen task two').finish({ status: 'completed', detail: 'completed', silent: false })
    await vi.waitFor(() => expect(h.calls).toHaveLength(3))
    await h.agent.whenIdle()
    expect(h.calls[2]!.options).toMatchObject({ adoptAgentTurn: true })
    expect(h.calls[2]!.options.followupContent).toBeUndefined()
  })

  it('carries changed host instructions explicitly when the wake has no other admitted input', async () => {
    const h = await harness()
    let instruction = 'Use the original workspace rules.'
    h.ctx.systemPrompt.section({ name: 'qwen-host-instruction', order: 1, text: () => instruction })
    h.agent.followup(user('initial task'))
    await h.agent.whenIdle()
    instruction = 'Use the updated workspace rules.'
    h.job('Qwen task').finish({ status: 'completed', detail: 'completed', silent: false })
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    await h.agent.whenIdle()
    const followup = text(h.calls[1]!.options.followupContent ?? [])
    expect(followup).toContain(instruction)
    expect(followup).toContain('The host context has changed.')
    expect(followup).not.toContain('background job acp-qwen-task-')
  })
})
