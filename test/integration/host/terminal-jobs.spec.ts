import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { JobEvent } from '@deepseek-ai/dsh-jobs'
import { resolveTerminalJobs } from '../../../src/host/composition/terminal-jobs.ts'
import { createAcpTerminalHandlers } from '../../../src/runtime/client-capabilities/terminal.ts'
import type { AcpTerminalJobHooks } from '../../../src/runtime/client-capabilities/terminal-job.ts'
import type { AcpSubprocessHandle } from '../../../src/runtime/process/subprocess.ts'

const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const JobsLocal = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-jobs-local')).href)
const ToolJobs = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tool-jobs')).href)

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-terminal-job-retention-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JobsLocal.default, {})
  // Keep the real completion reporter loaded: a missing wait would wake this
  // idle owner and enqueue another turn, not just alter a mock event flag.
  await ctx.plugin(ToolJobs, {})
  const owner = await ctx.agents.create({
    sessionId: SessionId('terminal-retention-owner'),
    agentOptions: { provider: 'no-model-registered', model: 'none' },
    meta: { cwd: root },
  })
  const events: JobEvent[] = []
  const sessionEvents: SessionEvent[] = []
  let insertedMessages = 0
  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => events.push(event))
  ctx.on('session/event', (_session, event) => sessionEvents.push(event))
  ctx.on('agent/inbox/inserted', () => {
    insertedMessages += 1
  })
  return {
    ctx,
    root,
    owner,
    events,
    sessionEvents,
    start: resolveTerminalJobs(ctx, owner.agent.id)!,
    rows: () => ctx.jobs.list(owner.agent.id),
    insertedMessages: () => insertedMessages,
  }
}

describe('ACP terminal retention through published native jobs and completion reporter', () => {
  it.each(['completed', 'failed', 'killed'] as const)(
    'keeps an unreleased %s result and removes it exactly once after release without waking the model',
    async (status) => {
      const h = await harness()
      const result = Promise.withResolvers<Awaited<AcpTerminalJobHooks['done']>>()
      const cancel = vi.fn(() => result.resolve({ status: 'killed', detail: 'fixture cleanup' }))
      const handle = h.start('foreground command', (output) => {
        output('retained output', 'stdout')
        return { done: result.promise, cancel }
      })
      const id = h.rows()[0]!.id
      result.resolve({ status, detail: `actual ${status}` })
      await vi.waitFor(() => expect(h.rows()[0]?.status).toBe(status))
      expect(
        h.ctx.jobs
          .readAt(id, 0, h.owner.agent.id)
          .chunks.map((chunk) => chunk.text)
          .join(''),
      ).toBe('retained output')
      expect(h.events.filter((event) => event.type === 'settled')).toMatchObject([{ awaited: true, job: { status } }])
      handle.release()
      handle.release()
      await vi.waitFor(() => expect(h.rows()).toEqual([]))
      expect(h.events.filter((event) => event.type === 'removed')).toHaveLength(1)
      expect(h.sessionEvents.filter((event) => event.type === 'job/settled')).toMatchObject([{ data: { status } }])
      expect(h.insertedMessages()).toBe(0)
      expect(cancel).not.toHaveBeenCalled()
    },
  )

  it('waits for producer settlement when release arrives first, retaining live output and cancellation', async () => {
    const h = await harness()
    const result = Promise.withResolvers<Awaited<AcpTerminalJobHooks['done']>>()
    const cancel = vi.fn(() => result.resolve({ status: 'killed', detail: 'actual SIGTERM' }))
    const handle = h.start('still running', (output) => {
      output('running output', 'stdout')
      return { done: result.promise, cancel }
    })
    const id = h.rows()[0]!.id
    handle.release()
    expect(h.rows()[0]?.status).toBe('running')
    expect(h.ctx.jobs.readAt(id, 0, h.owner.agent.id).chunks[0]?.text).toBe('running output')
    handle.cancel()
    expect(h.rows()[0]?.status).toBe('stopping')
    await vi.waitFor(() => expect(h.rows()).toEqual([]))
    expect(h.events.filter((event) => event.type === 'settled')).toMatchObject([
      { awaited: true, job: { status: 'killed' } },
    ])
    expect(h.events.map((event) => event.type)).toEqual(['registered', 'stopping', 'settled', 'output', 'removed'])
    expect(h.insertedMessages()).toBe(0)
  })

  it('does not retire a terminal until its release audit commits, including an in-flight output read', async () => {
    const h = await harness()
    const command = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const outputEntered = Promise.withResolvers<void>()
    const outputCommit = Promise.withResolvers<void>()
    const releaseEntered = Promise.withResolvers<void>()
    const releaseCommit = Promise.withResolvers<void>()
    const stdout = new PassThrough()
    const audits: string[] = []
    const process: AcpSubprocessHandle = {
      stdin: new PassThrough(),
      stdout,
      stderr: undefined,
      done: command.promise,
      waitForExit: async () => true,
      terminate() {},
    }
    const terminals = createAcpTerminalHandlers({
      subprocess: { spawn: () => process, resolveExecutable: async (command) => command },
      profileId: 'fixture',
      dshSessionId: h.owner.agent.id,
      cwd: h.root,
      env: {},
      startJob: h.start,
      audit: async (event) => {
        if (event.operation === 'output-summary') {
          outputEntered.resolve()
          await outputCommit.promise
        }
        if (event.operation === 'release') {
          releaseEntered.resolve()
          await releaseCommit.promise
        }
        audits.push(event.operation)
      },
    })
    cleanup.push(() => terminals.dispose())
    const { terminalId } = await terminals.createTerminal({ sessionId: 'acp', command: 'controlled' })
    const request = { sessionId: 'acp', terminalId }
    stdout.write('complete output')
    command.resolve({ exitCode: 0, signal: null })
    await terminals.waitForExit(request)
    await vi.waitFor(() => expect(h.rows()[0]?.status).toBe('completed'))
    const reading = terminals.terminalOutput(request)
    await outputEntered.promise
    const releasing = terminals.releaseTerminal(request)
    expect(h.rows()).toHaveLength(1)
    outputCommit.resolve()
    await expect(reading).resolves.toMatchObject({ output: 'complete output', exitStatus: { exitCode: 0 } })
    await releaseEntered.promise
    expect(h.rows()).toHaveLength(1)
    releaseCommit.resolve()
    await releasing
    await vi.waitFor(() => expect(h.rows()).toEqual([]))
    expect(audits).toEqual(['create', 'exit', 'output-summary', 'release'])
    expect(h.events.filter((event) => event.type === 'removed')).toHaveLength(1)
    await expect(terminals.terminalOutput(request)).rejects.toThrow('unknown or already released')
    expect(h.insertedMessages()).toBe(0)
  })

  it('retains failed cleanup and a retryable handle until managed-range exit is actually confirmed', async () => {
    const h = await harness()
    let rangeExited = false
    const terminals = createAcpTerminalHandlers({
      subprocess: {
        spawn: () => ({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: undefined,
          done: Promise.resolve({ exitCode: 0, signal: null }),
          waitForExit: async () => rangeExited,
          terminate() {},
        }),
        resolveExecutable: async (command) => command,
      },
      profileId: 'fixture',
      dshSessionId: h.owner.agent.id,
      cwd: h.root,
      env: {},
      startJob: h.start,
      releaseWaitMs: 5,
    })
    cleanup.push(() => terminals.dispose())
    const { terminalId } = await terminals.createTerminal({ sessionId: 'acp', command: 'controlled' })
    const request = { sessionId: 'acp', terminalId }
    await vi.waitFor(() => expect(h.rows()[0]?.status).toBe('failed'))
    await expect(terminals.releaseTerminal(request)).rejects.toThrow('retry release')
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0]?.detail).toContain('cleanup remains unconfirmed')
    await expect(terminals.terminalOutput(request)).resolves.toHaveProperty('output')
    rangeExited = true
    await terminals.releaseTerminal(request)
    await vi.waitFor(() => expect(h.rows()).toEqual([]))
    expect(h.sessionEvents.filter((event) => event.type === 'job/settled')).toMatchObject([
      { data: { status: 'failed' } },
    ])
  })

  it('tolerates native owner cleanup winning removal before ACP releases the same handle', async () => {
    const h = await harness()
    const result = Promise.withResolvers<Awaited<AcpTerminalJobHooks['done']>>()
    const handle = h.start('owner cleanup', () => ({
      done: result.promise,
      cancel: () => result.resolve({ status: 'killed', detail: 'owner disposed' }),
    }))
    await h.owner.dispose()
    expect(h.rows()).toEqual([])
    expect(() => handle.release()).not.toThrow()
    expect(h.events.filter((event) => event.type === 'removed')).toHaveLength(1)
  })

  it('retains the native row when removal fails without rejecting an already released ACP handle', async () => {
    const h = await harness()
    const handle = h.start('completed command', () => ({
      done: Promise.resolve({ status: 'completed', detail: 'actual exit code: 0' }),
      cancel() {},
    }))
    await vi.waitFor(() => expect(h.rows()[0]?.status).toBe('completed'))
    const remove = vi.spyOn(h.ctx.jobs, 'remove').mockImplementationOnce(() => {
      throw new Error('fixture registry unavailable')
    })
    expect(() => handle.release()).not.toThrow()
    expect(h.rows()[0]?.status).toBe('completed')
    remove.mockRestore()
    handle.release()
    expect(h.rows()).toEqual([])
    expect(h.events.filter((event) => event.type === 'removed')).toHaveLength(1)
  })
})
