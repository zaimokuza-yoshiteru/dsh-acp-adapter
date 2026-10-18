// Opt-in live check against a real, authenticated Qwen Code; see test/e2e/README.md:
//   DSH_E2E_LIVE_QWEN=1 DSH_E2E_LIVE_QWEN_COMMAND=<absolute path to cli-entry.js>
//     pnpm exec vitest run test/integration/process/qwen-live.spec.ts
// Makes a few real model requests through the user's configured Qwen provider.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { createQwenQuestionHandler } from '../../../src/domain/policy/qwen-question.ts'
import type { QwenTaskJobOutcome, QwenTaskJobStarter } from '../../../src/runtime/session/qwen-background.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'

const LIVE = process.env.DSH_E2E_LIVE_QWEN === '1'
const CLI = process.env.DSH_E2E_LIVE_QWEN_COMMAND ?? ''
// Only OS basics plus explicitly listed variables reach the Agent process.
const BASE_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
]
const ENV_KEYS = (process.env.DSH_E2E_LIVE_QWEN_ENV_KEYS ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter((key) => key !== '')

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []
const asked: string[] = []
let liveFacts: Record<string, unknown> = {}
const scheduleCalls = new Map<string, { tool?: string; input?: Record<string, unknown>; status?: string }>()

beforeEach(({ task }) => {
  liveFacts = { test: task.name, startedAt: new Date().toISOString() }
  scheduleCalls.clear()
})

function observeSchedule(notification: AcpSessionNotification): void {
  const update = notification.update
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
  const raw = update.rawInput as Record<string, unknown> | undefined
  const prior = scheduleCalls.get(update.toolCallId)
  if (prior === undefined && (raw === undefined || raw === null || typeof raw !== 'object' || !('cron' in raw))) return
  const snapshot = prior ?? {}
  const meta = update._meta as Record<string, unknown> | undefined
  if (meta?.toolName === 'cron_create') snapshot.tool = 'cron_create'
  if (raw !== undefined && raw !== null && typeof raw === 'object' && 'cron' in raw) {
    // Only schedule fields from this public test task; never persist arbitrary
    // native tool input, output, commands, credentials or user configuration.
    snapshot.input = {
      cron: typeof raw.cron === 'string' && /^[\d*,/ -]{1,100}$/.test(raw.cron) ? raw.cron : 'unsupported',
      recurring: typeof raw.recurring === 'boolean' ? raw.recurring : 'missing',
      durable: typeof raw.durable === 'boolean' ? raw.durable : 'missing',
      sessionMode: raw.sessionMode === 'current' || raw.sessionMode === 'unbound' ? raw.sessionMode : 'omitted',
      expectedPrompt: raw.prompt === 'Reply with exactly CRONFIRED',
    }
  }
  if (typeof update.status === 'string') snapshot.status = update.status
  if (scheduleCalls.size < 16 || prior !== undefined) scheduleCalls.set(update.toolCallId, snapshot)
}

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})
afterEach(async () => {
  const current = runtimes.splice(0)
  const metadata = current.map((runtime) => ({
    agent: runtime.agentInfo,
    model: runtime.configOptions?.find(
      (option) => option.type === 'select' && (option.id === 'model' || option.category === 'model'),
    )?.currentValue,
  }))
  const closed = await Promise.allSettled(current.map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  if (LIVE) {
    const evidence = fileURLToPath(new URL('../../../.local/e2e-live-qwen/', import.meta.url))
    fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(evidence, `${randomUUID()}.json`),
      JSON.stringify(
        {
          ...liveFacts,
          metadata,
          schedules: [...scheduleCalls.values()],
          cleanup: closed.map((result) => ({
            status: result.status,
            ...(result.status === 'rejected'
              ? { errorName: result.reason instanceof Error ? result.reason.name : 'UnknownError' }
              : {}),
          })),
          endedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }
  const failures = closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length > 0) throw new AggregateError(failures, 'Qwen live runtime cleanup failed')
})

function runtime(extra: Partial<AcpSessionRuntimeOptions> = {}): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-qwen-live-'))
  roots.push(root)
  const argv = [process.execPath, CLI, '--acp']
  const env: Record<string, string> = {}
  for (const key of [...BASE_ENV_KEYS, ...ENV_KEYS]) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  const created = new AcpSessionRuntime({
    profileId: 'qwen-live',
    config: { command: process.execPath, args: argv.slice(1), env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    // Shell approvals: allow once (the commands are fixed by this test).
    onPermissionRequest: async (params) => {
      const allow = params.options.find((option) => option.kind === 'allow_once')
      return allow === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: allow.optionId } }
    },
    onQwenQuestion: createQwenQuestionHandler({
      getAgent: () => ({}),
      userQuestions: {
        async ask(request) {
          asked.push(
            ...request.questions.map(
              (question) =>
                `${question.question} [${(question.options ?? []).map((option) => option.label).join('|')}]`,
            ),
          )
          return {
            answers: request.questions.map((question) => ({
              id: question.id,
              selected: (question.options ?? [])
                .filter((option) => /blue/i.test(option.label))
                .map((option) => option.label)
                .slice(0, 1),
            })),
          }
        },
      },
    }),
    agentTurnWaitMs: 15_000,
    ...extra,
  })
  runtimes.push(created)
  return created
}

const text = (updates: readonly AcpSessionNotification[]): string =>
  updates
    .map((notification) => {
      const update = notification.update
      return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''
    })
    .join('')

const prompt = (value: string): acp.ContentBlock[] => [{ type: 'text', text: value }]

describe.skipIf(!LIVE)('live Qwen Code ACP', () => {
  beforeAll(() => {
    if (!path.isAbsolute(CLI) || !fs.existsSync(CLI))
      throw new Error('DSH_E2E_LIVE_QWEN_COMMAND must be an absolute path to the Qwen Code cli-entry.js')
    for (const key of ENV_KEYS)
      if (process.env[key] === undefined) throw new Error(`DSH_E2E_LIVE_QWEN_ENV_KEYS lists unset variable ${key}`)
  })

  it('answers ask_user_question through the native question bridge', async () => {
    const live = runtime()
    const updates: AcpSessionNotification[] = []
    const response = await live.prompt(
      prompt(
        'Use the ask_user_question tool to ask me one question: which color do I prefer, with exactly two options "Red" and "Blue". After I answer, reply with exactly CHOSEN=<my answer> and nothing else.',
      ),
      (n) => {
        updates.push(n)
      },
    )
    console.log('questions:', asked, '\nreply:', text(updates).trim().slice(-200))
    expect(response.stopReason).toBe('end_turn')
    expect(asked.length).toBeGreaterThan(0)
    expect(text(updates)).toMatch(/CHOSEN=\s*Blue/i)
  }, 180_000)

  it('mirrors a background shell and adopts the turn Qwen starts when it finishes', async () => {
    const outcomes: Promise<QwenTaskJobOutcome>[] = []
    const labels: string[] = []
    let notifyJob: (() => void) | undefined
    const firstJob = new Promise<void>((resolve) => {
      notifyJob = resolve
    })
    const starter: QwenTaskJobStarter = (label, run) => {
      const hooks = run()
      labels.push(label)
      outcomes.push(hooks.done)
      notifyJob?.()
      return { cancel: () => hooks.cancel() }
    }
    const live = runtime({ qwenTaskJobs: starter })
    const first: AcpSessionNotification[] = []
    await live.prompt(
      prompt(
        'Start this shell command as a background process (is_background: true) and do not wait for it: node -e "setTimeout(()=>console.log(\'BGDONE\'),25000)". Then reply with exactly STARTED.',
      ),
      (n) => {
        first.push(n)
      },
    )
    console.log('first reply:', text(first).trim().slice(-200))
    await firstJob
    console.log('mirrored jobs:', labels)
    const outcome = await outcomes[0]!
    console.log('job outcome:', { ...outcome, result: outcome.result?.slice(0, 200) })
    expect(outcome.silent).toBe(false)
    const adopted: AcpSessionNotification[] = []
    const response = await live.prompt(
      prompt('background job notice'),
      (n) => {
        adopted.push(n)
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    console.log('adopted stop:', response.stopReason, '\nadopted reply:', text(adopted).trim().slice(-300))
    expect(response.stopReason).toBe('end_turn')
    expect(text(adopted).length).toBeGreaterThan(0)
    expect(text(adopted)).not.toContain('background job notice')
  }, 240_000)

  it('keeps a Qwen cron turn without an explicit terminal outcome unknown', async () => {
    const jobs: Array<{ label: string; done: Promise<QwenTaskJobOutcome> }> = []
    const starter: QwenTaskJobStarter = (label, run) => {
      const hooks = run()
      jobs.push({ label, done: hooks.done })
      return { cancel: () => hooks.cancel() }
    }
    const live = runtime({ qwenTaskJobs: starter })
    const first: AcpSessionNotification[] = []
    await live.prompt(
      prompt(
        'Call cron_create with exactly these arguments: {"cron":"* * * * *","prompt":"Reply with exactly CRONFIRED","recurring":false,"durable":false}. Omit sessionMode. This is a single session-only task; do not calculate a clock time or use shell scheduling. After the tool confirms creation, reply with exactly SCHEDULED. If creation fails or the tool is unavailable, report the failure instead.',
      ),
      (n) => {
        first.push(n)
        observeSchedule(n)
      },
    )
    console.log('first reply:', text(first).trim().slice(-200))
    liveFacts.firstReply = text(first).trim().slice(-200)
    expect([...scheduleCalls.values()]).toContainEqual({
      tool: 'cron_create',
      input: { cron: '* * * * *', recurring: false, durable: false, sessionMode: 'omitted', expectedPrompt: true },
      status: 'completed',
    })
    const deadline = Date.now() + 150_000
    let wake: { label: string; done: Promise<QwenTaskJobOutcome> } | undefined
    while (wake === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      wake = jobs.find((job) => job.label.startsWith('cron:'))
    }
    console.log('wake job:', wake?.label)
    liveFacts.wakeObserved = wake !== undefined
    expect(wake).toBeDefined()
    expect((await wake!.done).silent).toBe(false)
    const adopted: AcpSessionNotification[] = []
    await expect(
      live.prompt(
        prompt('cron notice'),
        (n) => {
          adopted.push(n)
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true, followupContent: prompt('RETAINED_INPUT_MUST_NOT_DISPATCH') },
      ),
    ).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR', reason: 'missing-terminal' })
    liveFacts.outcome = 'unknown-missing-terminal'
    liveFacts.expectedReplyObserved = text(adopted).includes('CRONFIRED')
    liveFacts.retainedInputObserved = text(adopted).includes('RETAINED_INPUT_MUST_NOT_DISPATCH')
    console.log('adopted outcome: unknown; reply:', text(adopted).trim().slice(-300))
    expect(text(adopted)).toContain('CRONFIRED')
    expect(text(adopted)).not.toContain('RETAINED_INPUT_MUST_NOT_DISPATCH')
  }, 300_000)
})
