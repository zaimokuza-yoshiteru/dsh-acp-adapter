import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QwenBackgroundTasks,
  qwenTaskCompletion,
  type QwenTaskJobHooks,
  type QwenTaskJobOutcome,
  type QwenTaskSnapshot,
} from '../../../src/runtime/session/qwen-background.ts'

const trackers: QwenBackgroundTasks[] = []
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.close(false)
  vi.useRealTimers()
})

function setup(cancelTask: () => Promise<unknown> = async () => undefined) {
  const row = { id: 'shell-1', kind: 'shell', label: 'background command', status: 'running' }
  let snapshot: readonly QwenTaskSnapshot[] | undefined = [row]
  let hooks!: QwenTaskJobHooks
  let outcome: QwenTaskJobOutcome | undefined
  const listTasks = vi.fn(async () => snapshot)
  const cancel = vi.fn(cancelTask)
  const progress = vi.fn()
  const log = vi.fn()
  const tracker = new QwenBackgroundTasks({
    startJob: (_label, run) => {
      hooks = run(progress)
      void hooks.done.then((value) => {
        outcome = value
      })
      return { cancel: () => hooks.cancel() }
    },
    listTasks,
    cancelTask: cancel,
    log,
  })
  trackers.push(tracker)
  return {
    tracker,
    row,
    listTasks,
    cancel,
    progress,
    log,
    hooks: () => hooks,
    outcome: () => outcome,
    snapshot: (value: readonly QwenTaskSnapshot[] | undefined) => {
      snapshot = value
    },
  }
}

describe('Qwen background cancellation settlement', () => {
  it.each(['running', 'unknown', '', undefined])(
    'rejects a completion notification without a known terminal status: %s',
    (status) => {
      expect(
        qwenTaskCompletion({
          sessionId: 'qwen-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial output' },
            _meta: { source: 'background_task_completed', backgroundTask: { taskId: 'shell-1', status } },
          },
        }),
      ).toMatchObject({ taskId: 'shell-1', status: undefined })
    },
  )

  it('keeps a rejected cancellation live beyond the old fallback and accepts the later real completion', async () => {
    vi.useFakeTimers()
    const state = setup(async () => {
      throw new Error('remote refused cancellation')
    })
    await state.tracker.refresh()
    state.hooks().cancel()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(state.outcome()).toBeUndefined()
    expect(state.progress).toHaveBeenLastCalledWith('Cancellation could not be confirmed; awaiting task status')
    expect(state.log).toHaveBeenCalledWith('Qwen task cancel failed: remote refused cancellation')
    expect(state.cancel).toHaveBeenCalledTimes(1)
    expect(state.listTasks.mock.calls.length).toBeGreaterThan(1)
    state.tracker.complete({ taskId: state.row.id, kind: 'shell', status: 'completed', text: 'LATE_SUCCESS' }, false)
    await expect(state.hooks().done).resolves.toEqual({
      status: 'completed',
      detail: 'completed',
      result: 'LATE_SUCCESS',
      silent: true,
    })
  })

  it.each(['cancelled', 'completed', 'failed'] as const)(
    'collects an explicit %s snapshot when the completion notification is missing',
    async (terminal) => {
      vi.useFakeTimers()
      const state = setup()
      await state.tracker.refresh()
      state.hooks().cancel()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.outcome()).toBeUndefined()
      state.row.status = terminal
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.outcome()).toMatchObject({
        status: terminal === 'cancelled' ? 'killed' : terminal,
        silent: true,
      })
      const reads = state.listTasks.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(state.listTasks).toHaveBeenCalledTimes(reads)
    },
  )

  it('observes a terminal snapshot while the cancellation reply is still pending', async () => {
    vi.useFakeTimers()
    const cancelReply = Promise.withResolvers<void>()
    const state = setup(() => cancelReply.promise)
    await state.tracker.refresh()
    state.hooks().cancel()
    state.row.status = 'completed'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.outcome()).toMatchObject({ status: 'completed', silent: true })
    cancelReply.resolve()
  })

  it('reports an explicit cancellation refusal through native progress without settling the job', async () => {
    vi.useFakeTimers()
    const state = setup(async () => ({ cancelled: false, reason: 'not_found' }))
    await state.tracker.refresh()
    state.hooks().cancel()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(state.outcome()).toBeUndefined()
    expect(state.progress).toHaveBeenLastCalledWith('Cancellation could not be confirmed; awaiting task status')
    expect(state.cancel).toHaveBeenCalledTimes(1)
  })

  it('ignores a terminal notification for a different task kind but accepts an omitted kind', async () => {
    const state = setup()
    await state.tracker.refresh()
    state.hooks().cancel()
    state.tracker.complete({ taskId: state.row.id, kind: 'agent', status: 'completed', text: 'FOREIGN' }, false)
    await Promise.resolve()
    expect(state.outcome()).toBeUndefined()
    state.tracker.complete({ taskId: state.row.id, status: 'completed', text: 'OWNED' }, false)
    await expect(state.hooks().done).resolves.toMatchObject({ status: 'completed', result: 'OWNED' })
  })

  it.each(['running', 'paused', 'unrecognized', 'missing', 'unavailable', 'foreign-kind'])(
    'does not manufacture a terminal outcome from %s task observations',
    async (status) => {
      vi.useFakeTimers()
      const state = setup()
      await state.tracker.refresh()
      state.hooks().cancel()
      state.snapshot(
        status === 'missing'
          ? []
          : status === 'unavailable'
            ? undefined
            : [
                {
                  ...state.row,
                  status: status === 'foreign-kind' ? 'cancelled' : status,
                  kind: status === 'foreign-kind' ? 'agent' : 'shell',
                },
              ],
      )
      await vi.advanceTimersByTimeAsync(12_000)
      expect(state.outcome()).toBeUndefined()
      expect(state.cancel).toHaveBeenCalledTimes(1)
    },
  )

  it('does not certify cancellation while connection cleanup is still pending', async () => {
    vi.useFakeTimers()
    const state = setup()
    await state.tracker.refresh()
    state.hooks().cancel()
    await vi.advanceTimersByTimeAsync(1_000)
    state.tracker.beginClose()
    const reads = state.listTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(12_000)
    expect(state.outcome()).toBeUndefined()
    expect(state.listTasks).toHaveBeenCalledTimes(reads)
    state.tracker.close(true)
    await expect(state.hooks().done).resolves.toMatchObject({
      status: 'killed',
      detail: 'ACP session closed; managed process exit confirmed',
    })
  })

  it('reports unconfirmed cleanup as a producer failure, without claiming remote termination', async () => {
    const state = setup()
    await state.tracker.refresh()
    state.tracker.beginClose()
    state.tracker.close(false)
    await expect(state.hooks().done).resolves.toMatchObject({
      status: 'failed',
      detail: 'ACP session cleanup unconfirmed; background work may still be running',
    })
  })

  it('preserves a terminal notification received before or during cleanup', async () => {
    vi.useFakeTimers()
    const state = setup()
    await state.tracker.refresh()
    state.tracker.beginClose()
    state.tracker.complete({ taskId: state.row.id, kind: 'shell', status: 'completed', text: 'FINAL_OUTPUT' }, false)
    state.tracker.close(false)
    await expect(state.hooks().done).resolves.toMatchObject({
      status: 'completed',
      result: 'FINAL_OUTPUT',
    })
  })
})
