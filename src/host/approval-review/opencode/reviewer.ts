import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { supportsLocalApprovalReview, type ApprovalReviewDecision } from '../../../contract/approval-review.ts'
import { isLocalOpenCodeReviewProfile, isOpenCodeReviewModel } from '../../../contract/opencode-review.ts'
import { stopSubprocess } from '../../../runtime/process/cleanup.ts'
import type { SubprocessSeam } from '../../../runtime/process/subprocess.ts'
import type { ApprovalReviewBackend, ApprovalReviewRequest } from '../backend.ts'
import { MAX_REVIEW_OUTPUT_BYTES, readReviewDecision, reviewPrompt } from '../decision.ts'
import { privateReviewSubprocess } from '../subprocess.ts'
import { localReviewApi, readServerEndpoint } from './review-api.ts'
import { reviewEnvironment, verifyOpenCodeActorOrigin, verifyOpenCodeReviewModel } from './review-config.ts'

function isBundledPlugin(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('source' in value)) return false
  const source = value.source
  return !!source && typeof source === 'object' && 'type' in source && source.type === 'builtin'
}

/** OpenCode's one-shot generation endpoint accepts only model and prompt; no Agent or tools session is created. */
export class OpenCodeReviewer implements ApprovalReviewBackend {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()

  constructor(
    private readonly subprocess: SubprocessSeam,
    private readonly warn?: (message: string) => void,
  ) {}

  async review({
    profile,
    actorCwd,
    model,
    task,
    toolCall,
    locale,
    signal,
  }: ApprovalReviewRequest): Promise<ApprovalReviewDecision> {
    if (
      !actorCwd ||
      !this.subprocess.localExecution ||
      !supportsLocalApprovalReview(process.platform) ||
      !isLocalOpenCodeReviewProfile(profile) ||
      !isOpenCodeReviewModel(model)
    )
      throw new Error('Unsupported OpenCode reviewer')
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(20_000)])
    deadline.throwIfAborted()
    const prompt = reviewPrompt(task, toolCall, locale)
    const work = this.run(profile, actorCwd, model, prompt, deadline)
    this.active.add(work)
    try {
      const decision = await work
      deadline.throwIfAborted()
      return decision
    } catch {
      deadline.throwIfAborted()
      throw new Error('OpenCode review unavailable')
    } finally {
      this.active.delete(work)
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active])
  }

  private async run(
    profile: ApprovalReviewRequest['profile'],
    actorCwd: string,
    model: string,
    prompt: string,
    signal: AbortSignal,
  ) {
    const { env, location } = reviewEnvironment(profile.env)
    await verifyOpenCodeActorOrigin(profile, actorCwd)
    const command = await this.subprocess.resolveExecutable(profile.command, profile.env, signal)
    if (!isAbsolute(command)) throw new Error('Invalid OpenCode executable')
    const binary = await realpath(command)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-opencode-review-'))
    try {
      signal.throwIfAborted()
      const password = randomBytes(32).toString('base64url')
      const handle = privateReviewSubprocess(this.subprocess).spawn({
        argv: [binary, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
        cwd,
        env: { ...env, OPENCODE_PASSWORD: password },
        signal,
        graceMs: 500,
      })
      void handle.done.catch(() => {})
      handle.stderr?.resume()
      try {
        const url = await readServerEndpoint(handle.stdout, signal)
        const api = localReviewApi(url, password, signal)
        const info = await api('/api/info')
        if (info.version !== '2.3.2' || !Array.isArray(info.urls) || !info.urls.includes(url))
          throw new Error('Unverified OpenCode server')
        // Generate binds to global.config, not the process cwd or the business ACP session's directory.
        const base = await realpath(location)
        const scope = `?location%5Bdirectory%5D=${encodeURIComponent(base)}`
        const slash = model.indexOf('/')
        const selected = { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
        // Unlike plugin.list, model.list awaits activation. Check the resolved transport before submitting the prompt.
        const models = await api('/api/model' + scope, undefined, 4 * 1024 * 1024)
        if ((models.location as { directory?: unknown } | null)?.directory !== base || !Array.isArray(models.data))
          throw new Error('Invalid OpenCode model inventory')
        const matches = models.data.filter((m) => m?.providerID === selected.providerID && m?.id === selected.id)
        if (matches.length !== 1) throw new Error('Unverified OpenCode model')
        verifyOpenCodeReviewModel(matches[0])
        const emptyInventory = async () => {
          for (const path of ['/api/plugin', '/api/mcp']) {
            const list = await api(path + scope)
            if (
              (list.location as { directory?: unknown } | null)?.directory !== base ||
              !Array.isArray(list.data) ||
              (path === '/api/mcp'
                ? list.data.length !== 0
                : list.data.some((plugin: unknown) => !isBundledPlugin(plugin)))
            )
              throw new Error('OpenCode review extensions are active or unknown')
          }
        }
        await emptyInventory()
        const output = await api('/api/experimental/generate/text', {
          model: selected,
          prompt,
        })
        const decision = (output.data as { text?: unknown } | null)?.text
        if (typeof decision !== 'string' || Buffer.byteLength(decision) > MAX_REVIEW_OUTPUT_BYTES)
          throw new Error('Invalid OpenCode reviewer output')
        await emptyInventory()
        signal.throwIfAborted()
        await verifyOpenCodeActorOrigin(profile, actorCwd)
        signal.throwIfAborted()
        return readReviewDecision(decision, 'both')
      } finally {
        if (!(await stopSubprocess(handle, { eofGraceMs: 300, exitWaitMs: 2000, warn: this.warn })))
          throw new Error('OpenCode reviewer did not stop')
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}
