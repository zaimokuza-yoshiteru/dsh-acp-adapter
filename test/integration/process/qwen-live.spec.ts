// Opt-in live check against a real, authenticated Qwen Code; see test/e2e/README.md:
//   DSH_E2E_LIVE_QWEN=1 DSH_E2E_LIVE_QWEN_COMMAND=<absolute path to cli-entry.js>
//     pnpm exec vitest run test/integration/process/qwen-live.spec.ts
// Makes a few real model requests through the user's configured Qwen provider.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
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

  it('adopts a Qwen cron turn (no start/end markers) when the schedule fires', async () => {
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
        'Use the cron_create tool to schedule a one-shot (non-recurring) task that fires at the next whole minute, with the prompt: "Reply with exactly CRONFIRED". Then reply with exactly SCHEDULED.',
      ),
      (n) => {
        first.push(n)
      },
    )
    console.log('first reply:', text(first).trim().slice(-200))
    const deadline = Date.now() + 150_000
    let wake: { label: string; done: Promise<QwenTaskJobOutcome> } | undefined
    while (wake === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      wake = jobs.find((job) => job.label.startsWith('cron:'))
    }
    console.log('wake job:', wake?.label)
    expect(wake).toBeDefined()
    expect((await wake!.done).silent).toBe(false)
    const adopted: AcpSessionNotification[] = []
    const response = await live.prompt(
      prompt('cron notice'),
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
    expect(text(adopted)).toContain('CRONFIRED')
  }, 300_000)
})
