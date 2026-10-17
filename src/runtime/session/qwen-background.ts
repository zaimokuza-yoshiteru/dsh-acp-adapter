/**
 * Qwen Code background tasks mirrored as native DSH jobs.
 *
 * Qwen runs shells (`is_background`), subagents (`run_in_background`),
 * monitors and workflows past the end of a `session/prompt`. When one
 * finishes it emits an out-of-turn `agent_message_chunk`
 * (`_meta.source: 'background_task_completed'`) and, once idle, starts a turn
 * by itself announced with `_qwencode/start_turn`.
 *
 * DSH only runs a turn when the native AgentLoop asks the provider, so each
 * running task is registered with `ctx.jobs` (visible, killable, keeps the
 * session's work accounted for). A completion that Qwen turns into its own
 * turn settles the job *unawaited*: the native `tool-jobs` plugin then wakes
 * the idle DSH agent, whose provider call adopts the already-running Qwen
 * turn instead of sending a new prompt. Completions Qwen folds into an active
 * prompt settle *awaited*, so no extra wake-up is produced.
 */
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'

/** Native job kind; also the marker the host uses to recognise the wake notice. */
export const QWEN_TASK_JOB_KIND = 'acp-qwen-task'

export interface QwenTaskJobOutcome {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail: string
  readonly result?: string
  /** true = settle as already collected (no completion notice / wake-up). */
  readonly silent: boolean
}

export interface QwenTaskJobHooks {
  cancel(): void
  done: Promise<QwenTaskJobOutcome>
}

/** Host seam over `ctx.jobs`; undefined result = registration refused. */
export type QwenTaskJobStarter = (label: string, run: () => QwenTaskJobHooks) => { cancel(): void } | undefined

export interface QwenTaskSnapshot {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
}

interface MirroredTask {
  readonly id: string
  readonly kind: string
  readonly label: string
  settle?: (outcome: QwenTaskJobOutcome) => void
  /** Completion seen; waiting briefly for Qwen's own turn to decide wake vs silent. */
  completion?: {
    readonly status: QwenTaskJobOutcome['status']
    readonly text: string
    readonly timer: ReturnType<typeof setTimeout>
  }
  settled: boolean
  /** Killed from DSH: the resulting completion is the kill's own answer. */
  cancelRequested?: boolean
}

export interface QwenBackgroundDeps {
  readonly startJob: QwenTaskJobStarter
  /** `qwen/status/session/tasks`; resolves undefined when unavailable. */
  readonly listTasks: () => Promise<readonly QwenTaskSnapshot[] | undefined>
  /** `qwen/control/session/task/cancel`. */
  readonly cancelTask: (taskId: string, kind: string) => Promise<void>
  /** How long a completion waits for `_qwencode/start_turn` before settling silently. */
  readonly turnWaitMs?: number
  readonly log?: (message: string) => void
}

const TASK_KINDS = new Set(['agent', 'shell', 'monitor', 'workflow'])
const MAX_RESULT = 16 * 1024

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jobStatus(status: unknown): QwenTaskJobOutcome['status'] {
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'killed' || status === 'aborted') return 'killed'
  return 'completed'
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (line === '') return undefined
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

function bounded(text: string): string {
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[truncated]` : text
}

/** Parse a `background_task_completed` notification; undefined for anything else. */
export function qwenTaskCompletion(
  notification: AcpSessionNotification,
): { taskId: string; kind?: string; status: QwenTaskJobOutcome['status']; label?: string; text: string } | undefined {
  const update = notification.update as { sessionUpdate?: string; content?: unknown; _meta?: unknown }
  if (update.sessionUpdate !== 'agent_message_chunk' || !plain(update._meta)) return undefined
  // `background_notification` is the same display line re-emitted when Qwen
  // starts the notification turn; the model's reply is `..._response` (kept).
  if (update._meta.source !== 'background_task_completed' && update._meta.source !== 'background_notification')
    return undefined
  const task = update._meta.backgroundTask
  if (!plain(task) || typeof task.taskId !== 'string' || task.taskId.length === 0) return undefined
  const content = update.content
  const text = plain(content) && content.type === 'text' && typeof content.text === 'string' ? content.text : ''
  return {
    taskId: task.taskId,
    ...(typeof task.kind === 'string' ? { kind: task.kind } : {}),
    ...(typeof task.label === 'string'
      ? { label: task.label }
      : typeof task.description === 'string'
        ? { label: task.description }
        : {}),
    status: jobStatus(task.status),
    text,
  }
}

/** Parse `qwen/status/session/tasks`'s result defensively. */
export function qwenTaskSnapshots(value: unknown): readonly QwenTaskSnapshot[] | undefined {
  if (!plain(value) || !Array.isArray(value.tasks)) return undefined
  const tasks: QwenTaskSnapshot[] = []
  for (const item of value.tasks) {
    if (!plain(item) || typeof item.id !== 'string' || typeof item.kind !== 'string' || typeof item.status !== 'string')
      continue
    const label =
      typeof item.label === 'string' && item.label.trim() !== ''
        ? item.label
        : typeof item.description === 'string' && item.description.trim() !== ''
          ? item.description
          : item.id
    tasks.push({ id: item.id, kind: item.kind, label, status: item.status })
  }
  return tasks
}

export class QwenBackgroundTasks {
  private readonly tasks = new Map<string, MirroredTask>()
  private refreshing: Promise<void> | undefined
  private closed = false

  constructor(private readonly deps: QwenBackgroundDeps) {}

  /** Mirror every running Qwen task not yet registered. Never throws. */
  async refresh(): Promise<void> {
    if (this.closed) return
    this.refreshing ??= (async () => {
      try {
        const snapshot = await this.deps.listTasks()
        if (snapshot === undefined || this.closed) return
        for (const task of snapshot) {
          if ((task.status === 'running' || task.status === 'paused') && !this.tasks.has(task.id))
            this.mirror(task.id, task.kind, task.label)
        }
      } catch (error) {
        this.deps.log?.(`Qwen task snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.refreshing = undefined
      }
    })()
    await this.refreshing
  }

  /**
   * Out-of-turn completion. Hold the settlement briefly: if Qwen announces a
   * turn for this task it becomes the wake-up, otherwise it settles silently.
   * @param promptActive - a host prompt is running; Qwen folds the result there.
   */
  complete(completion: NonNullable<ReturnType<typeof qwenTaskCompletion>>, promptActive: boolean): void {
    if (this.closed) return
    // Started and finished inside the same prompt: Qwen folds it into that
    // turn and nothing outlives it, so there is nothing to mirror.
    if (promptActive && !this.tasks.has(completion.taskId)) return
    const task =
      this.tasks.get(completion.taskId) ??
      this.mirror(
        completion.taskId,
        completion.kind ?? 'agent',
        completion.label ?? firstLine(completion.text) ?? completion.taskId,
      )
    if (task === undefined || task.settled || task.completion !== undefined) return
    const text = bounded(completion.text)
    if (promptActive || task.cancelRequested === true) {
      this.settle(task, {
        status: completion.status,
        detail: completion.status,
        ...(text === '' ? {} : { result: text }),
        silent: true,
      })
      return
    }
    const timer = setTimeout(() => {
      if (task.completion?.timer !== timer) return
      this.settle(task, {
        status: completion.status,
        detail: completion.status,
        ...(text === '' ? {} : { result: text }),
        silent: true,
      })
    }, this.deps.turnWaitMs ?? 3_000)
    timer.unref?.()
    task.completion = { status: completion.status, text, timer }
  }

  /**
   * `_qwencode/start_turn` was accepted. Settle (or create and settle) the
   * task's job unawaited so DSH wakes the agent. Returns false when no job
   * registry is available, i.e. nothing will adopt the turn.
   */
  wake(turn: { readonly taskId?: string; readonly kind?: string; readonly label?: string }): boolean {
    if (this.closed) return false
    const existing = turn.taskId === undefined ? undefined : this.tasks.get(turn.taskId)
    if (existing !== undefined && !existing.settled) {
      const completion = existing.completion
      if (completion !== undefined) clearTimeout(completion.timer)
      this.settle(existing, {
        status: completion?.status ?? 'completed',
        detail: completion?.status ?? 'completed',
        ...(completion === undefined || completion.text === '' ? {} : { result: completion.text }),
        silent: false,
      })
      return true
    }
    // Already settled silently (Qwen queued it behind a prompt) or never seen:
    // a fresh, immediately settled job carries the wake-up.
    const label = turn.label ?? existing?.label ?? turn.taskId ?? 'Qwen background task'
    const started = this.deps.startJob(label, () => ({
      cancel: () => undefined,
      done: Promise.resolve({ status: 'completed' as const, detail: 'completed', silent: false }),
    }))
    return started !== undefined
  }

  close(): void {
    this.closed = true
    for (const task of this.tasks.values()) {
      if (task.completion !== undefined) clearTimeout(task.completion.timer)
      // Owner teardown: the Agent process is going away with its tasks.
      this.settle(task, { status: 'killed', detail: 'ACP session closed', silent: true })
    }
    this.tasks.clear()
  }

  private mirror(id: string, kind: string, label: string): MirroredTask | undefined {
    const task: MirroredTask = { id, kind, label, settled: false }
    let resolve!: (outcome: QwenTaskJobOutcome) => void
    const done = new Promise<QwenTaskJobOutcome>((r) => {
      resolve = r
    })
    task.settle = resolve
    let started: { cancel(): void } | undefined
    try {
      started = this.deps.startJob(label, () => ({
        cancel: () => {
          if (task.settled || !TASK_KINDS.has(task.kind)) return
          task.cancelRequested = true
          void this.deps.cancelTask(task.id, task.kind).catch((error: unknown) => {
            this.deps.log?.(`Qwen task cancel failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          // Qwen reports the cancellation as a completion; do not hang the job if it never does.
          const fallback = setTimeout(
            () => this.settle(task, { status: 'killed', detail: 'cancelled', silent: true }),
            10_000,
          )
          fallback.unref?.()
        },
        done,
      }))
    } catch (error) {
      this.deps.log?.(`Qwen task job registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (started === undefined) return undefined
    this.tasks.set(id, task)
    return task
  }

  private settle(task: MirroredTask, outcome: QwenTaskJobOutcome): void {
    if (task.settled) return
    task.settled = true
    if (task.completion !== undefined) clearTimeout(task.completion.timer)
    task.settle?.(outcome)
  }
}
