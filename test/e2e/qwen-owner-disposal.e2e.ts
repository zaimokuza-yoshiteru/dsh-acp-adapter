import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.ts'
import { required } from './required.ts'

// Published Loader -> installed profile cleanup -> native Agent owner scope ->
// real ACP process and background child. No synthetic producer settlement.
it('disposes a Qwen owner after refused cancellation without waiting on session/disposed', async () => {
  const host = await launchAdapterWorld()
  const directory = join(root, '.local/e2e-qwen-owner-disposal', randomUUID())
  mkdirSync(directory, { recursive: true })
  const control = join(host.workspaceCwd, 'owner-disposal-task')
  const log = `${control}.jsonl`
  const facts: Record<string, unknown> = {}
  const events = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                event: string
                pid?: number
                code?: number | null
                signal?: string | null
              },
          )
      : []
  let owner: AgentHandle | undefined
  let disposing: Promise<void> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await host.ctx.settings.replace('dsh-acp-adapter', {
      agents: {
        qwen: {
          name: 'Qwen owner cleanup fixture',
          command: process.execPath,
          args: [join(root, 'test/fixtures/qwen-job-control-agent.mjs')],
          env: {
            HOME: host.workspaceCwd,
            QWEN_JOB_CONTROL: control,
            QWEN_JOB_LOG: log,
            QWEN_JOB_CANCEL_MODE: 'reject',
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-qwen')).toBe(true))
    const presets = required(host.ctx.get('agentPresets'))
    const preset = await presets.resolve(undefined)
    owner = await host.ctx.agents.create({
      sessionId: SessionId(`qwen-owner-${randomUUID()}`),
      agentOptions: { provider: 'acp-qwen', model: 'qwen-job-fixture' },
      meta: { cwd: host.workspaceCwd, agentPreset: preset.id },
      // Match native SessionController composition while retaining the public
      // owner handle needed to exercise disposal. A bare Agent has no scoped
      // tool-jobs controller, so the registry correctly refuses its jobs.
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, preset.id)
      },
    })
    const sessionId = owner.agent.id
    owner.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Start the controlled task' }],
        source: { kind: 'user' },
      }),
    )
    await owner.agent.whenIdle()
    await expect.poll(() => host.ctx.jobs.list(sessionId).length).toBe(1)
    const job = required(host.ctx.jobs.list(sessionId)[0])
    expect(job.kind).toBe('acp-qwen-task')
    await expect.poll(() => existsSync(`${control}.heartbeat`)).toBe(true)
    host.ctx.jobs.kill(job.id, sessionId)
    await expect.poll(() => events().filter((entry) => entry.event === 'cancel-requested').length).toBe(1)
    expect(host.ctx.jobs.get(job.id, sessionId).status).toBe('stopping')
    facts.beforeOwnerDisposal = host.ctx.jobs.get(job.id, sessionId)
    const settlements: unknown[] = []
    host.ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
      if (event.type === 'settled' && event.job.id === job.id) settlements.push(event)
    })
    const started = performance.now()
    disposing = owner.dispose()
    await Promise.race([
      disposing,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Native owner disposal waited on its own unfinished jobs')), 5_000)
      }),
    ])
    clearTimeout(deadline)
    expect(events().find((entry) => entry.event === 'task-exited')).toMatchObject({ signal: 'SIGTERM' })
    expect(events().filter((entry) => entry.event === 'cancel-requested')).toHaveLength(1)
    expect(host.ctx.jobs.list(sessionId)).toEqual([])
    expect(host.ctx.agents.get(sessionId)).toBeUndefined()
    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({ cause: 'teardown', job: { status: 'killed' } })
    facts.elapsedMs = Math.round(performance.now() - started)
    facts.settlements = settlements
    facts.status = 'passed'
  } catch (error) {
    facts.error = String(error)
    facts.sessionEvents = owner?.agent.session.snapshotEvents()
    throw error
  } finally {
    clearTimeout(deadline)
    // On regression let only the test-owned child finish so cleanup cannot hang.
    writeFileSync(`${control}.finish`, 'finish')
    await (disposing ?? owner?.dispose())
    facts.agent = events()
    writeFileSync(join(directory, 'facts.json'), JSON.stringify(facts, null, 2))
    await host.close()
  }
})
