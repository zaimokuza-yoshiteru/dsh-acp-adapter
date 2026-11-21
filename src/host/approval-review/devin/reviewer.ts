import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  ApprovalReviewError,
  supportsLocalApprovalReview,
  type ApprovalReviewDecision,
} from '../../../contract/approval-review.ts'
import { isDevinReviewModel, isDevinReviewerAgent, isLocalDevinReviewProfile } from '../../../contract/devin-review.ts'
import { AcpClientConnection } from '../../../protocol/v1/connection.ts'
import type { SubprocessSeam } from '../../../runtime/process/subprocess.ts'
import type { ApprovalReviewBackend, ApprovalReviewRequest } from '../backend.ts'
import { MAX_REVIEW_OUTPUT_BYTES, readReviewDecision, reviewPrompt } from '../decision.ts'
import { privateReviewSubprocess } from '../subprocess.ts'
import { assertEmptyReviewRegistry } from './review-extensions.ts'
import { openReviewWorkspace } from './review-workspace.ts'

interface Worker {
  conn: AcpClientConnection
  workspace: Awaited<ReturnType<typeof openReviewWorkspace>>
  violation: AbortController
  sessions: Set<string>
}

/** An idle reviewer can handle the next approval; overlapping or cancelled requests never share a transport. */
export class DevinReviewer implements ApprovalReviewBackend {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private readonly idle = new Map<string, { worker: Worker; timer: NodeJS.Timeout }>()
  private closing?: Promise<void>

  constructor(
    private readonly subprocess: SubprocessSeam,
    private readonly onProcessWarn?: (message: string) => void,
  ) {}

  async review({
    profile,
    model,
    task,
    toolCall,
    locale,
    signal,
  }: ApprovalReviewRequest): Promise<ApprovalReviewDecision> {
    if (
      this.subprocess.localExecution !== true ||
      !supportsLocalApprovalReview(process.platform) ||
      !isLocalDevinReviewProfile(profile) ||
      !isDevinReviewModel(model)
    )
      throw new ApprovalReviewError('review-unavailable')
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(15_000)])
    deadline.throwIfAborted()
    const prompt = reviewPrompt(task, toolCall, locale)
    const env = { ...profile.env }
    const key = createHash('sha256')
      .update(JSON.stringify([profile.command, model, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))]))
      .digest('hex')
    const work = this.run(profile.command, env, key, model, prompt, deadline)
    this.active.add(work)
    try {
      const decision = await work
      deadline.throwIfAborted()
      return decision
    } catch (error) {
      deadline.throwIfAborted()
      // Server errors can quote approval data or include private authentication diagnostics.
      throw error instanceof ApprovalReviewError ? error : new ApprovalReviewError('review-unavailable')
    } finally {
      this.active.delete(work)
    }
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    return (this.closing ??= (async () => {
      const closing = [...this.idle.values()].map(({ worker, timer }) => {
        clearTimeout(timer)
        return this.closeWorker(worker)
      })
      this.idle.clear()
      await Promise.allSettled([...this.active, ...closing])
    })())
  }

  private async openWorker(
    command: string,
    env: Record<string, string>,
    model: string,
    signal: AbortSignal,
  ): Promise<Worker> {
    const resolved = await this.subprocess.resolveExecutable(command, env, signal)
    if (!isAbsolute(resolved)) throw new ApprovalReviewError('unverified-reviewer')
    const binary = await realpath(resolved)
    signal.throwIfAborted()
    const workspace = await openReviewWorkspace(env)
    let conn: AcpClientConnection | undefined
    try {
      signal.throwIfAborted()
      const violation = new AbortController()
      conn = new AcpClientConnection(
        {
          argv: [
            binary,
            '--config',
            workspace.configPath,
            'acp',
            '--agent-type',
            'summarizer',
            '--model',
            model,
            '--process-model',
            'in-process',
          ],
          cwd: workspace.cwd,
          env: workspace.env,
          subprocess: privateReviewSubprocess(this.subprocess),
        },
        {
          ...(this.onProcessWarn ? { onProcessWarn: this.onProcessWarn } : {}),
          onPermissionRequest: () => {
            violation.abort(new ApprovalReviewError('unverified-reviewer'))
            return { outcome: { outcome: 'cancelled' } }
          },
        },
      )
      const init = await conn.initialize({ signal })
      if (!isDevinReviewerAgent(init.agentInfo)) throw new ApprovalReviewError('unverified-reviewer')
      return { conn, workspace, violation, sessions: new Set() }
    } catch (e) {
      try {
        await conn?.close()
      } finally {
        await workspace.close()
      }
      throw e
    }
  }

  private async run(
    command: string,
    env: Record<string, string>,
    key: string,
    model: string,
    prompt: string,
    deadline: AbortSignal,
  ) {
    const idle = this.idle.get(key)
    if (idle) {
      clearTimeout(idle.timer)
      this.idle.delete(key)
    }
    let worker = idle?.worker
    if (worker && !worker.conn.isTransportAvailable) {
      await this.closeWorker(worker)
      worker = undefined
    }
    if (!worker) {
      deadline.throwIfAborted()
      worker = await this.openWorker(command, env, model, deadline)
    }
    let reusable = false
    try {
      const { conn, violation } = worker
      const signal = AbortSignal.any([deadline, violation.signal])
      signal.throwIfAborted()
      const session = await conn.newSession({}, { signal })
      const controls =
        session.configOptions?.filter((option) => option.category === 'model' && option.type === 'select') ?? []
      if (controls.length !== 1 || !session.sessionId || worker.sessions.has(session.sessionId))
        throw new ApprovalReviewError('unverified-reviewer')
      if (controls[0]!.currentValue !== model) throw new ApprovalReviewError('model-unavailable')
      worker.sessions.add(session.sessionId)
      const root = worker.workspace.root
      await assertEmptyReviewRegistry(root)
      const mcp = await this.readText(worker, session.sessionId, model, '/mcp', signal)
      if (mcp.trim() !== 'No MCP servers are configured.') throw new ApprovalReviewError('unverified-reviewer')
      await assertEmptyReviewRegistry(root)
      signal.throwIfAborted()
      const decision = readReviewDecision(await this.readText(worker, session.sessionId, model, prompt, signal))
      await assertEmptyReviewRegistry(root)
      // Release each session before reusing the process. Discard a process that cannot prove session teardown.
      if (conn.agentCapabilities?.sessionCapabilities?.close) {
        await conn.closeSession(session.sessionId, { signal })
        reusable = true
      }
      signal.throwIfAborted()
      return decision
    } catch (error) {
      worker.violation.signal.throwIfAborted()
      throw error
    } finally {
      if (reusable && !deadline.aborted && !this.idle.has(key) && worker.sessions.size < 32) {
        const retiring = worker
        const timer = setTimeout(() => {
          this.idle.delete(key)
          const done = this.closeWorker(retiring)
          this.active.add(done)
          void done
            .catch(() => this.onProcessWarn?.('Devin review cleanup failed'))
            .finally(() => this.active.delete(done))
        }, 30_000)
        timer.unref()
        this.idle.set(key, { worker, timer })
      } else await this.closeWorker(worker)
    }
  }

  private async readText(
    worker: Worker,
    id: string,
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { conn, violation } = worker
    let output = ''
    let bytes = 0
    const result = await conn.prompt(
      id,
      [{ type: 'text', text: prompt }],
      ({ sessionId, update }) => {
        if (sessionId !== id) return
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          bytes += Buffer.byteLength(update.content.text)
          if (bytes <= MAX_REVIEW_OUTPUT_BYTES) output += update.content.text
          else violation.abort(new ApprovalReviewError('invalid-response'))
        } else if (
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update' ||
          update.sessionUpdate === 'subagent_spawned' ||
          update.sessionUpdate === 'agent_message_chunk' ||
          (update.sessionUpdate === 'config_option_update' &&
            update.configOptions.some((opt) => opt.category === 'model' && opt.currentValue !== model))
        ) {
          violation.abort(new ApprovalReviewError('unverified-reviewer'))
        }
      },
      { signal },
    )
    signal.throwIfAborted()
    if (result.stopReason !== 'end_turn') throw new ApprovalReviewError('invalid-response')
    return output
  }

  private async closeWorker(worker: Worker) {
    try {
      await worker.conn.close()
      if (!worker.conn.isCleanupConfirmed) throw new ApprovalReviewError('unverified-reviewer')
    } finally {
      await worker.workspace.close()
    }
  }
}
