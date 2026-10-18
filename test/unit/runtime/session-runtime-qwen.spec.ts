import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import { createQwenQuestionHandler } from '../../../src/domain/policy/qwen-question.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'
import type {
  QwenTaskJobHooks,
  QwenTaskJobOutcome,
  QwenTaskJobStarter,
} from '../../../src/runtime/session/qwen-background.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'fake-qwen-agent.mjs')

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const answeringQuestions: AcpNativeUserQuestionService = {
  async ask(request) {
    return {
      answers: request.questions.map((question) =>
        question.multiSelect === true
          ? { id: question.id, selected: ['X', 'Y'], custom: 'my own' }
          : { id: question.id, selected: ['B'] },
      ),
    }
  },
}

function createRuntime(
  extra: Partial<AcpSessionRuntimeOptions> = {},
  env: Record<string, string> = {},
): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-qwen-'))
  roots.push(root)
  const argv = [process.execPath, AGENT]
  const runtime = new AcpSessionRuntime({
    profileId: 'qwen',
    config: { command: process.execPath, args: [AGENT], env },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env, spawnPlan: { argv, env } }),
    onPermissionRequest: async () => {
      throw new Error('a Qwen question must not reach the approval bridge')
    },
    onQwenQuestion: createQwenQuestionHandler({ userQuestions: answeringQuestions, getAgent: () => ({}) }),
    agentTurnWaitMs: 2_000,
    ...extra,
  })
  runtimes.push(runtime)
  return runtime
}

function texts(notifications: readonly AcpSessionNotification[]): string[] {
  return notifications.flatMap((notification) => {
    const update = notification.update
    return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  })
}

function promptRequests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-qwen-prompts-'))
  roots.push(root)
  const file = path.join(root, 'prompts.jsonl')
  return {
    env: { FAKE_QWEN_PROMPT_LOG: file },
    read: () =>
      fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string),
  }
}

interface RecordedJob {
  label: string
  hooks: QwenTaskJobHooks
  outcome: Promise<QwenTaskJobOutcome>
  cancelled: boolean
}

function recordingJobs(): { starter: QwenTaskJobStarter; jobs: RecordedJob[]; next(): Promise<RecordedJob> } {
  const jobs: RecordedJob[] = []
  const waiters: Array<(job: RecordedJob) => void> = []
  const starter: QwenTaskJobStarter = (label, run) => {
    const hooks = run()
    const job: RecordedJob = { label, hooks, outcome: hooks.done, cancelled: false }
    jobs.push(job)
    waiters.shift()?.(job)
    return {
      cancel: () => {
        job.cancelled = true
        hooks.cancel()
      },
    }
  }
  return {
    starter,
    jobs,
    next: () =>
      new Promise<RecordedJob>((resolve) => {
        waiters.push(resolve)
      }),
  }
}

describe('Qwen Code ask_user_question', () => {
  it('leaves an ordinary Agent question and background-shaped content on the generic paths', async () => {
    let approvals = 0
    const runtime = createRuntime(
      {
        qwenTaskJobs: recordingJobs().starter,
        onPermissionRequest: async () => {
          approvals++
          return { outcome: { outcome: 'selected', optionId: 'proceed_once' } }
        },
        onQwenQuestion: async () => {
          throw new Error('not Qwen')
        },
      },
      { FAKE_QWEN_AGENT_NAME: 'ordinary-agent' },
    )
    const updates: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'ask' }], (n) => updates.push(n))
    expect(approvals).toBe(1)
    expect(texts(updates)).toContain('answers:null outcome:{"outcome":"selected","optionId":"proceed_once"}')
    await runtime.prompt([{ type: 'text', text: 'ordinary-metadata' }], (n) => updates.push(n))
    expect(texts(updates)).toContain('ordinary background-shaped answer')
  })
  it('answers through the native question card with Qwen `answers`, never through approval', async () => {
    const runtime = createRuntime()
    const updates: AcpSessionNotification[] = []
    const response = await runtime.prompt([{ type: 'text', text: 'ask' }], (notification) => {
      updates.push(notification)
    })
    expect(response.stopReason).toBe('end_turn')
    const reply = texts(updates).find((text) => text.startsWith('answers:'))
    expect(reply).toBe('answers:{"0":"B","1":"X, Y, my own"} outcome:{"outcome":"selected","optionId":"proceed_once"}')
  })

  it('declines the question (cancelled) when the user dismisses it', async () => {
    const runtime = createRuntime({
      onQwenQuestion: createQwenQuestionHandler({
        userQuestions: {
          ask: async () => {
            throw new Error('dismissed')
          },
        },
        getAgent: () => ({}),
      }),
    })
    const updates: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'ask' }], (notification) => {
      updates.push(notification)
    })
    expect(texts(updates)).toContain('answers:null outcome:{"outcome":"cancelled"}')
  })
})

describe('Qwen Code background tasks', () => {
  it('fails a live announced turn without a terminal, retains its prefix, and never dispatches retained input', async () => {
    const jobs = recordingJobs()
    const prompts = promptRequests()
    const runtime = createRuntime(
      { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80 },
      { FAKE_QWEN_DROP_END: '1', FAKE_QWEN_NO_FINISHED_MARKER: '1', ...prompts.env },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const updates: AcpSessionNotification[] = []
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (n) => updates.push(n),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
      ),
    ).rejects.toMatchObject({ code: 'ACP_PROTOCOL_ERROR', reason: 'missing-terminal' })
    expect(texts(updates)).toContain('The background command printed done.')
    expect(prompts.read()).toEqual(['background'])
    await expect(runtime.prompt([{ type: 'text', text: 'later user input' }], () => undefined)).rejects.toMatchObject({
      reason: 'missing-terminal',
    })
    expect(prompts.read()).toEqual(['background'])
  })

  it('preserves an unadopted timeout through close, initialize, restore, and a later ordinary Host prompt', async () => {
    const jobs = recordingJobs()
    const prompts = promptRequests()
    let spawned = 0
    const runtime = createRuntime(
      {
        qwenTaskJobs: jobs.starter,
        unannouncedIdleMs: 80,
        subprocess: {
          resolveExecutable: (...args) => subprocess.resolveExecutable(...args),
          spawn: (spec) => {
            spawned++
            return subprocess.spawn(spec)
          },
        },
      },
      { FAKE_QWEN_DROP_END: '1', FAKE_QWEN_NO_FINISHED_MARKER: '1', ...prompts.env },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    await expect.poll(() => runtime.pendingAgentTurnFailure?.error.reason).toBe('missing-terminal')
    const sessionId = runtime.acpSessionId!
    expect(runtime.pendingAgentTurnFailure).toMatchObject({
      acpSessionId: sessionId,
      turnId: `${sessionId}########notification1`,
    })
    await runtime.close()
    await runtime.initialize()
    await runtime.start()
    expect(await runtime.restore({ agentSessionId: sessionId })).toBe('reused')
    await expect(runtime.restore({ agentSessionId: 'other-session' })).rejects.toThrow('does not match')
    const updates: AcpSessionNotification[] = []
    await expect(
      runtime.prompt([{ type: 'text', text: 'user already queued' }], (n) => updates.push(n)),
    ).rejects.toMatchObject({ reason: 'missing-terminal' })
    expect(texts(updates)).toContain('The background command printed done.')
    expect(runtime.agentInfo?.name).toBe('qwen-code')
    expect(spawned).toBe(1)
    expect(prompts.read()).toEqual(['background'])
    const repeated: AcpSessionNotification[] = []
    await expect(runtime.prompt([{ type: 'text', text: 'retry' }], (n) => repeated.push(n))).rejects.toMatchObject({
      reason: 'missing-terminal',
    })
    expect(repeated).toEqual([])
    expect(spawned).toBe(1)
  })

  it('bounds a live automatic turn with no Host consumer independently of matching activity', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime(
      { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80, agentTurnAdoptionMs: 120 },
      {
        FAKE_QWEN_BACKGROUND_ACTIVITY: 'notification',
        FAKE_QWEN_BACKGROUND_DELAY_MS: '1000',
      },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    await expect.poll(() => runtime.pendingAgentTurnFailure?.error.reason).toBe('missing-terminal')
    await expect(
      runtime.prompt([{ type: 'text', text: 'wake' }], () => undefined, undefined, undefined, undefined, undefined, {
        adoptAgentTurn: true,
      }),
    ).rejects.toMatchObject({ reason: 'missing-terminal' })
  })

  it.each(['shell', 'notification'])(
    'keeps a silent announced turn alive across reporting windows with matching %s activity',
    async (activity) => {
      const jobs = recordingJobs()
      const runtime = createRuntime(
        { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80 },
        {
          FAKE_QWEN_BACKGROUND_ACTIVITY: activity,
          FAKE_QWEN_BACKGROUND_DELAY_MS: '350',
        },
      )
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      const updates: AcpSessionNotification[] = []
      const start = Date.now()
      const response = await runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (n) => updates.push(n),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      )
      expect(response.stopReason).toBe('end_turn')
      expect(Date.now() - start).toBeGreaterThan(250)
      expect(texts(updates)).toContain('The background command printed done.')
      expect(runtime.pendingAgentTurnFailure).toBeUndefined()
    },
  )

  it.each(['foreign-task', 'foreign-session', 'idle', 'unrelated-shell', 'wrong-turn-shell', 'session'])(
    'does not let %s snapshots keep an announced turn alive',
    async (activity) => {
      const jobs = recordingJobs()
      const runtime = createRuntime(
        { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80 },
        {
          FAKE_QWEN_BACKGROUND_ACTIVITY: activity,
          FAKE_QWEN_BACKGROUND_DELAY_MS: '350',
        },
      )
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      await expect(
        runtime.prompt([{ type: 'text', text: 'wake' }], () => undefined, undefined, undefined, undefined, undefined, {
          adoptAgentTurn: true,
        }),
      ).rejects.toMatchObject({ reason: 'missing-terminal' })
    },
  )

  it.each([
    { marker: '1', activity: 'shell', later: 'unrelated-shell' },
    { marker: undefined, activity: 'notification', later: 'notification' },
  ])(
    'does not let later $later activity pin a finished automatic turn (no marker=$marker)',
    async ({ marker, activity, later }) => {
      const jobs = recordingJobs()
      const runtime = createRuntime(
        { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80 },
        {
          FAKE_QWEN_BACKGROUND_ACTIVITY: activity,
          FAKE_QWEN_BACKGROUND_DELAY_MS: '200',
          FAKE_QWEN_DROP_END: '1',
          ...(marker === undefined ? {} : { FAKE_QWEN_NO_FINISHED_MARKER: marker }),
          FAKE_QWEN_POST_TERMINAL_ACTIVITY: later,
        },
      )
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      const updates: AcpSessionNotification[] = []
      await expect(
        runtime.prompt(
          [{ type: 'text', text: 'wake' }],
          (n) => updates.push(n),
          undefined,
          undefined,
          undefined,
          undefined,
          { adoptAgentTurn: true },
        ),
      ).rejects.toMatchObject({ reason: 'missing-terminal' })
      expect(texts(updates)).toContain('The background command printed done.')
    },
  )

  it('does not cut off a pending human answer or a later adoption because their reporting timers elapsed', async () => {
    const jobs = recordingJobs()
    let answer!: () => void
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const runtime = createRuntime({
      qwenTaskJobs: jobs.starter,
      unannouncedIdleMs: 60,
      agentTurnAdoptionMs: 60,
      onQwenQuestion: async () => {
        await answered
        return { answers: { '0': 'B' } } as never
      },
    })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background-ask' }], () => undefined)
    await (
      await mirrored
    ).outcome
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(runtime.pendingAgentTurnFailure).toBeUndefined()
    const adopting = runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(runtime.pendingAgentTurnFailure).toBeUndefined()
    answer()
    expect((await adopting).stopReason).toBe('end_turn')
  })

  it('keeps a native Host body alive past the reporting window and drains it before retained input', async () => {
    const jobs = recordingJobs()
    let release!: () => void
    let entered!: () => void
    const body = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const runtime = createRuntime(
      {
        qwenTaskJobs: jobs.starter,
        unannouncedIdleMs: 60,
        createFileSystemHandlers: () => ({
          dispose: () => undefined,
          readTextFile: async () => ({ content: '' }),
          writeTextFile: async () => {
            entered()
            await body
            return {}
          },
        }),
      },
      { FAKE_QWEN_BACKGROUND_FS: '1', FAKE_QWEN_BACKGROUND_DELAY_MS: '250' },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const adopting = runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'retained' }] },
    )
    await started
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runtime.pendingAgentTurnFailure).toBeUndefined()
    release()
    expect((await adopting).stopReason).toBe('end_turn')
  })

  it('consumes a successful terminal received before adoption instead of sending the wake again', async () => {
    const jobs = recordingJobs()
    const prompts = promptRequests()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter, unannouncedIdleMs: 80 }, prompts.env)
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    await new Promise((resolve) => setTimeout(resolve, 150))
    const updates: AcpSessionNotification[] = []
    expect(
      (
        await runtime.prompt(
          [{ type: 'text', text: 'wake' }],
          (n) => updates.push(n),
          undefined,
          undefined,
          undefined,
          undefined,
          { adoptAgentTurn: true },
        )
      ).stopReason,
    ).toBe('end_turn')
    expect(texts(updates)).toContain('The background command printed done.')
    expect(prompts.read()).toEqual(['background'])
  })

  it('retains an empty partial response marker received before adoption and rejects a matching end_turn', async () => {
    const jobs = recordingJobs()
    const marker = Promise.withResolvers<AcpSessionNotification>()
    const prompts = promptRequests()
    const runtime = createRuntime(
      {
        qwenTaskJobs: jobs.starter,
        onSessionUpdate: (notification) => {
          if (
            notification.update._meta?.source === 'background_notification_response' &&
            notification.update.sessionUpdate === 'agent_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text === ''
          )
            marker.resolve(notification)
        },
      },
      { FAKE_QWEN_PARTIAL_MARKER: 'matching', ...prompts.env },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    expect(await marker.promise).toMatchObject({
      sessionId: 'qwen-session',
      update: {
        content: { type: 'text', text: '' },
        _meta: {
          source: 'background_notification_response',
          backgroundTask: { turnId: 'qwen-session########notification1', turnComplete: true, partial: true },
        },
      },
    })

    const updates: AcpSessionNotification[] = []
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (notification) => updates.push(notification),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      ),
    ).rejects.toMatchObject({
      name: 'AcpAgentTurnOutcomeError',
      code: 'ACP_PROTOCOL_ERROR',
      reason: 'incomplete-turn',
    })
    expect(texts(updates)).toContain('The background command printed done.')
    expect(prompts.read()).toEqual(['background'])
  })

  it.each([
    'false',
    'wrong-session',
    'wrong-turn',
    'wrong-source',
    'nonboolean-partial',
    'nonboolean-complete',
    'missing-turn',
    'missing-complete',
    'missing-partial',
    'non-message',
    'array-task',
    'null-task',
  ])('does not invent an incomplete outcome from a %s marker', async (mode) => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter }, { FAKE_QWEN_PARTIAL_MARKER: mode })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const response = await runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    expect(response.stopReason).toBe('end_turn')
  })

  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const)(
    'preserves an explicit %s after the matching partial marker',
    async (reason) => {
      const jobs = recordingJobs()
      const runtime = createRuntime(
        { qwenTaskJobs: jobs.starter },
        { FAKE_QWEN_PARTIAL_MARKER: 'matching', FAKE_QWEN_END_REASON: reason },
      )
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      const response = await runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        () => undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      )
      expect(response.stopReason).toBe(reason)
    },
  )

  it('keeps the first confirmed terminal when a partial marker and duplicate ending arrive afterwards', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime(
      { qwenTaskJobs: jobs.starter },
      { FAKE_QWEN_PARTIAL_MARKER: 'matching', FAKE_QWEN_PARTIAL_MARKER_ORDER: 'after-end' },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const response = await runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    expect(response.stopReason).toBe('end_turn')
    const next: AcpSessionNotification[] = []
    expect(
      (await runtime.prompt([{ type: 'text', text: 'continue afterwards' }], (notification) => next.push(notification)))
        .stopReason,
    ).toBe('end_turn')
    expect(texts(next)).toContain('echo:continue afterwards')
    expect(texts(next)).not.toContain('The background command printed done.')
  })

  it.each(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const)(
    'preserves an explicitly confirmed %s after visible automatic output',
    async (reason) => {
      const jobs = recordingJobs()
      const runtime = createRuntime({ qwenTaskJobs: jobs.starter }, { FAKE_QWEN_END_REASON: reason })
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      const updates: AcpSessionNotification[] = []
      const response = await runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (n) => updates.push(n),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      )
      expect(response.stopReason).toBe(reason)
      expect(texts(updates)).toContain('The background command printed done.')
    },
  )

  it.each(['session', 'turn'])(
    'ignores a successful terminal for another %s before the owned turn fails',
    async (mismatch) => {
      const jobs = recordingJobs()
      const runtime = createRuntime(
        { qwenTaskJobs: jobs.starter },
        { FAKE_QWEN_WRONG_END: mismatch, FAKE_QWEN_END_REASON: 'failed' },
      )
      const mirrored = jobs.next()
      await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
      await (
        await mirrored
      ).outcome
      const updates: AcpSessionNotification[] = []
      await expect(
        runtime.prompt(
          [{ type: 'text', text: 'wake' }],
          (n) => updates.push(n),
          undefined,
          undefined,
          undefined,
          undefined,
          { adoptAgentTurn: true },
        ),
      ).rejects.toMatchObject({
        name: 'AcpAgentTurnOutcomeError',
        code: 'ACP_PROTOCOL_ERROR',
        reason: 'unrecognized-end-reason',
      })
      expect(texts(updates)).toContain('The background command printed done.')
    },
  )

  it('keeps an active automatic turn unknown when the local runtime closes', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter }, { FAKE_QWEN_IGNORE_CANCEL: '1' })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const updates: AcpSessionNotification[] = []
    const outcome = runtime
      .prompt([{ type: 'text', text: 'wake' }], (n) => updates.push(n), undefined, undefined, undefined, undefined, {
        adoptAgentTurn: true,
      })
      .then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      )
    await expect.poll(() => texts(updates)).toContain('background still running')
    await runtime.close()
    expect(await outcome).toMatchObject({
      error: { name: 'AcpAgentTurnOutcomeError', code: 'ACP_PROTOCOL_ERROR', reason: 'missing-terminal' },
    })
  })

  it('keeps fast cron output unknown when ordered activity snapshots lose the active hold', async () => {
    const jobs = recordingJobs()
    const prompts = promptRequests()
    const runtime = createRuntime(
      { qwenTaskJobs: jobs.starter, unannouncedIdleMs: 800 },
      { FAKE_QWEN_FAST_CRON: '1', ...prompts.env },
    )
    await runtime.prompt([{ type: 'text', text: 'schedule' }], () => undefined)
    await expect.poll(() => jobs.jobs.some((job) => job.label.startsWith('cron:'))).toBe(true)
    const updates: AcpSessionNotification[] = []
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (n) => updates.push(n),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
      ),
    ).rejects.toMatchObject({
      name: 'AcpAgentTurnOutcomeError',
      code: 'ACP_PROTOCOL_ERROR',
      reason: 'missing-terminal',
    })
    expect(texts(updates)).toEqual(expect.arrayContaining(['cron working', 'cron done']))
    expect(texts(updates).some((text) => text.startsWith('echo:'))).toBe(false)
    expect(prompts.read()).toEqual(['schedule'])
  })

  it('keeps a cron hold release unknown on Stop and never dispatches retained input', async () => {
    const jobs = recordingJobs()
    const prompts = promptRequests()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter, cancelGraceMs: 100 }, prompts.env)
    await runtime.prompt([{ type: 'text', text: 'schedule' }], () => undefined)
    await expect.poll(() => jobs.jobs.some((job) => job.label.startsWith('cron:'))).toBe(true)
    const controller = new AbortController()
    const updates: AcpSessionNotification[] = []
    const adopted = runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      (n) => updates.push(n),
      controller.signal,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
    )
    setTimeout(() => controller.abort(), 10)
    await expect(adopted).rejects.toThrow()
    expect(texts(updates).some((text) => text.includes('must not dispatch'))).toBe(false)
    expect(prompts.read()).toEqual(['schedule'])
  })

  it.each(['FAKE_QWEN_NO_ACTIVE_WORK', 'FAKE_QWEN_IDLE_ONLY'])(
    'fails unknown rather than succeeding or waiting forever without activity proof (%s)',
    async (envKey) => {
      const jobs = recordingJobs()
      const runtime = createRuntime({ qwenTaskJobs: jobs.starter, unannouncedIdleMs: 120 }, { [envKey]: '1' })
      await runtime.prompt([{ type: 'text', text: 'schedule' }], () => undefined)
      await expect.poll(() => jobs.jobs.some((job) => job.label.startsWith('cron:'))).toBe(true)
      const updates: AcpSessionNotification[] = []
      await expect(
        runtime.prompt(
          [{ type: 'text', text: 'wake' }],
          (n) => updates.push(n),
          undefined,
          undefined,
          undefined,
          undefined,
          { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
        ),
      ).rejects.toMatchObject({
        name: 'AcpAgentTurnOutcomeError',
        code: 'ACP_PROTOCOL_ERROR',
        reason: 'missing-terminal',
      })
      expect(texts(updates).some((text) => text.includes('must not dispatch'))).toBe(false)
    },
  )

  it('drains adopted native Host operations before sending retained input in order', async () => {
    const jobs = recordingJobs()
    let releaseWrite!: () => void
    let startedWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      startedWrite = resolve
    })
    const writeDone = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const runtime = createRuntime(
      {
        qwenTaskJobs: jobs.starter,
        createFileSystemHandlers: () => ({
          dispose: () => undefined,
          readTextFile: async () => ({ content: '' }),
          writeTextFile: async () => {
            startedWrite()
            await writeDone
            return {}
          },
        }),
      },
      { FAKE_QWEN_BACKGROUND_FS: '1' },
    )
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const updates: AcpSessionNotification[] = []
    let settled = false
    const adopted = runtime
      .prompt([{ type: 'text', text: 'wake' }], (n) => updates.push(n), undefined, undefined, undefined, undefined, {
        adoptAgentTurn: true,
        followupContent: [{ type: 'text', text: 'retained input' }],
      })
      .finally(() => {
        settled = true
      })
    await writeStarted
    await expect.poll(() => texts(updates)).toContain('The background command printed done.')
    expect(settled).toBe(false)
    expect(texts(updates)).not.toContain('echo:retained input')
    releaseWrite()
    expect((await adopted).stopReason).toBe('end_turn')
    expect(texts(updates)).toContain('echo:retained input')
    expect(texts(updates).indexOf('The background command printed done.')).toBeLessThan(
      texts(updates).indexOf('echo:retained input'),
    )
  })

  it('rejects an unconfirmed Stop and refuses to reuse the live automatic turn', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter, cancelGraceMs: 40 }, { FAKE_QWEN_IGNORE_CANCEL: '1' })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const controller = new AbortController()
    const updates: AcpSessionNotification[] = []
    const adopted = runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      (n) => updates.push(n),
      controller.signal,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true, followupContent: [{ type: 'text', text: 'must not dispatch' }] },
    )
    setTimeout(() => controller.abort(), 10)
    await expect(adopted).rejects.toThrow()
    await expect(runtime.prompt([{ type: 'text', text: 'next user' }], () => undefined)).rejects.toThrow()
    expect(jobs.jobs).toHaveLength(1)
    expect(texts(updates).some((text) => text.includes('must not dispatch'))).toBe(false)
  })

  it('keeps a cron round active through a slow pre-tool hook and its later permission', async () => {
    const jobs = recordingJobs()
    let approvals = 0
    const runtime = createRuntime(
      {
        qwenTaskJobs: jobs.starter,
        unannouncedIdleMs: 800,
        onPermissionRequest: async () => {
          approvals++
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        },
      },
      { FAKE_QWEN_STALE_WORK: '1', FAKE_QWEN_TRANSIENT_IDLE: '1' },
    )
    await runtime.prompt([{ type: 'text', text: 'schedule-slow-hook' }], () => undefined)
    await expect.poll(() => jobs.jobs.find((job) => job.label.startsWith('cron:'))).toBeDefined()
    const updates: AcpSessionNotification[] = []
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (n) => updates.push(n),
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      ),
    ).rejects.toMatchObject({
      name: 'AcpAgentTurnOutcomeError',
      code: 'ACP_PROTOCOL_ERROR',
      reason: 'missing-terminal',
    })
    expect(approvals).toBe(1)
    expect(texts(updates)).toContain('cron-permission:selected')
    expect(texts(updates)).toContain('cron done')
    expect(jobs.jobs).toHaveLength(2) // one mirrored shell + one cron wake, never a split cron
  })

  it('mirrors running tasks as jobs and adopts the Qwen-initiated turn after the wake-up', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    const first: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'background' }], (notification) => {
      first.push(notification)
    })
    const job = await mirrored
    expect(job.label).toBe('sleep 1 && echo done')
    // Qwen announces its own turn: the mirrored job settles unawaited (wake-up).
    const outcome = await job.outcome
    expect(outcome).toMatchObject({
      status: 'completed',
      silent: false,
      result: 'Background shell bg-1 completed: done',
    })
    const adopted: AcpSessionNotification[] = []
    const response = await runtime.prompt(
      [{ type: 'text', text: 'background job acp-qwen-task-1 finished' }],
      (notification) => {
        adopted.push(notification)
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    expect(response.stopReason).toBe('end_turn')
    expect(texts(adopted)).toContain('The background command printed done.')
    // The notice itself was never sent to Qwen as a prompt.
    expect(texts(adopted).some((text) => text.startsWith('echo:'))).toBe(false)
    expect(texts(adopted)).not.toContain('Background shell bg-1 completed: done')
  })

  it('holds a question from an unadopted Qwen turn until the woken host turn adopts it', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background-ask' }], () => undefined)
    await (
      await mirrored
    ).outcome
    // Simulate a slow wake-up: Qwen is already asking.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const adopted: AcpSessionNotification[] = []
    const response = await runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      (notification) => {
        adopted.push(notification)
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    expect(response.stopReason).toBe('end_turn')
    expect(texts(adopted)).toContain('bg-answers:{"0":"B","1":"X, Y, my own"}')
    expect(texts(adopted)).toContain('The background command printed done.')
  })

  it('cancels an adopted Qwen turn on host stop', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    await runtime.prompt([{ type: 'text', text: 'background-ask' }], () => undefined)
    await (
      await mirrored
    ).outcome
    const controller = new AbortController()
    const adopting = runtime.prompt(
      [{ type: 'text', text: 'wake' }],
      () => undefined,
      controller.signal,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    setTimeout(() => controller.abort(), 10)
    expect((await adopting).stopReason).toBe('cancelled')
    // The runtime accepts a new user prompt afterwards.
    expect((await runtime.prompt([{ type: 'text', text: 'hello' }], () => undefined)).stopReason).toBe('end_turn')
  })

  it('preserves cron text and completed tool evidence without inferring a successful terminal', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter, unannouncedIdleMs: 800 })
    await runtime.prompt([{ type: 'text', text: 'schedule' }], () => undefined)
    await expect.poll(() => jobs.jobs.find((candidate) => candidate.label.startsWith('cron:'))).toBeDefined()
    const job = jobs.jobs.find((candidate) => candidate.label.startsWith('cron:'))!
    expect(job.label).toBe('cron: check the build')
    expect(await job.outcome).toMatchObject({ silent: false })
    const adopted: AcpSessionNotification[] = []
    const started = Date.now()
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (notification) => {
          adopted.push(notification)
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      ),
    ).rejects.toMatchObject({
      name: 'AcpAgentTurnOutcomeError',
      code: 'ACP_PROTOCOL_ERROR',
      reason: 'missing-terminal',
    })
    expect(texts(adopted)).toEqual(expect.arrayContaining(['cron working', 'cron done']))
    // The first round's usage chunk is followed by a tool call: no early end.
    expect(adopted.some((n) => n.update.sessionUpdate === 'tool_call_update' && n.update.status === 'completed')).toBe(
      true,
    )
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('separates an ordinary prompt response from an inline cron with an unknown terminal', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter, unannouncedIdleMs: 800 })
    const first: AcpSessionNotification[] = []
    await runtime.prompt([{ type: 'text', text: 'schedule-inline' }], (notification) => {
      first.push(notification)
    })
    expect(texts(first)).toEqual(['echo:schedule-inline'])
    const job = jobs.jobs.find((candidate) => candidate.label === 'cron: check the build')
    expect(job).toBeDefined()
    const adopted: AcpSessionNotification[] = []
    await expect(
      runtime.prompt(
        [{ type: 'text', text: 'wake' }],
        (notification) => {
          adopted.push(notification)
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { adoptAgentTurn: true },
      ),
    ).rejects.toMatchObject({
      name: 'AcpAgentTurnOutcomeError',
      code: 'ACP_PROTOCOL_ERROR',
      reason: 'missing-terminal',
    })
    expect(texts(adopted)).toEqual(expect.arrayContaining(['cron working', 'cron done']))
  })

  it('falls back to an ordinary prompt when Qwen does not announce a turn', async () => {
    const runtime = createRuntime({ qwenTaskJobs: recordingJobs().starter, agentTurnWaitMs: 50 })
    const updates: AcpSessionNotification[] = []
    const response = await runtime.prompt(
      [{ type: 'text', text: 'notice' }],
      (notification) => {
        updates.push(notification)
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { adoptAgentTurn: true },
    )
    expect(response.stopReason).toBe('end_turn')
    expect(texts(updates)).toContain('echo:notice')
  })

  it('maps a job kill to Qwen task cancellation and settles silently', async () => {
    const jobs = recordingJobs()
    const runtime = createRuntime({ qwenTaskJobs: jobs.starter })
    const mirrored = jobs.next()
    // A plain prompt mirrors bg-1 without completing it.
    await runtime.prompt([{ type: 'text', text: 'hello' }], () => undefined)
    const job = await mirrored
    job.hooks.cancel()
    const outcome = await job.outcome
    expect(outcome).toMatchObject({ status: 'killed', silent: true })
  })

  it("leaves Qwen's unannounced fallback in place without a job registry", async () => {
    const runtime = createRuntime()
    const seen: AcpSessionNotification[] = []
    const all = new Promise<void>((resolve) => {
      const runtimeWithUpdates = createRuntime({
        onSessionUpdate: (notification) => {
          seen.push(notification)
          if (texts([notification]).some((text) => text.startsWith('start_turn:'))) resolve()
        },
      })
      void runtimeWithUpdates.prompt([{ type: 'text', text: 'background' }], () => undefined)
    })
    await all
    expect(texts(seen)).toContain('start_turn:-32601')
    await runtime.close()
  })
})
