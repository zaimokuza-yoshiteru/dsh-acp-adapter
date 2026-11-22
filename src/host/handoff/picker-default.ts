import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { AcpHandoffTarget } from '../../contract/handoff.ts'
import { changedSession, checkHandoffModel } from './destination.ts'

function same(left: unknown, right: AcpHandoffTarget) {
  return (
    !!left &&
    typeof left === 'object' &&
    'provider' in left &&
    left.provider === right.provider &&
    'model' in left &&
    left.model === right.model &&
    ('reasoningEffort' in left ? left.reasoningEffort : undefined) === right.reasoningEffort
  )
}

interface PickerWrite {
  namespace: string
  initialRevision: number
  previous: object
  targets: AcpHandoffTarget[]
  awaitingRestore: Map<Session, AcpHandoffTarget>
  update: PromiseWithResolvers<void>
}

function knownRevision(write: PickerWrite, revision: number, value: unknown): boolean {
  if (revision === write.initialRevision) return true
  const target = write.targets[revision - write.initialRevision - 1]
  return target !== undefined && same(value, target)
}

/** RC.5's native picker writes the profile preference even for a provisional cross-backend selection. */
export class HandoffPickerDefault {
  private pending: PickerWrite | undefined
  private restoring: Session | undefined

  constructor(
    private readonly ctx: Context,
    owns: (provider: string) => boolean,
  ) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection' || session === this.restoring) return
      const previous = this.pending
      this.pending = undefined
      const source = session.requestHeader()?.config.provider
      if (!source || source === event.data.provider || (!owns(source) && !owns(event.data.provider))) return
      const ns = ctx
        .get('configEditor', false)
        ?.entries()
        .find((entry) => entry.options.name === '@deepseek-ai/dsh-agent-default-model')?.options.id
      if (!ns) return
      const entry = ctx
        .get('settings', false)
        ?.describe({ redactSecrets: true })
        .find((item) => item.ns === ns)
      if (!entry || !entry.user || typeof entry.user !== 'object') return
      const continuing = previous?.namespace === ns && knownRevision(previous, entry.revision, entry.value)
      if (!continuing && same(entry.value, event.data)) return
      const write: PickerWrite = continuing
        ? previous
        : {
            namespace: ns,
            initialRevision: entry.revision,
            previous: entry.user,
            targets: [],
            awaitingRestore: new Map(),
            update: Promise.withResolvers<void>(),
          }
      // The stock picker serializes profile saves, including those from other windows.
      // Retain the baseline while the profile follows exactly those provisional writes.
      if (!same(write.targets.at(-1), event.data)) {
        write.targets.push(event.data)
        write.update = Promise.withResolvers<void>()
      }
      write.awaitingRestore.set(session, event.data)
      this.pending = write
    })
    ctx.on('settings/document-updated', (ns, revision) => {
      const captured = this.pending
      if (captured?.namespace === ns && revision >= captured.initialRevision + captured.targets.length)
        captured.update.resolve()
    })
    ctx.on('session/disposed', (session) => {
      if (this.pending?.awaitingRestore.has(session)) this.pending = undefined
    })
  }

  async restore(sessionId: string, source: AcpHandoffTarget, target: AcpHandoffTarget, authorize: () => void) {
    const id = SessionId(sessionId)
    const agent = this.ctx.get('agents', false)?.get(id)
    if (!agent || agent.session.header.origin === 'subagent' || source.provider === target.provider)
      throw changedSession()
    const current = agent.model.current()
    if (same(current, source)) return
    if (!same(current, target)) throw changedSession()
    const selected = await checkHandoffModel(this.ctx, source)
    authorize()
    if (agent !== this.ctx.get('agents', false)?.get(id) || !same(agent.model.current(), target)) throw changedSession()
    this.restoring = agent.session
    try {
      agent.model.select(selected)
    } finally {
      this.restoring = undefined
    }
    const captured = this.pending
    if (captured && same(captured.awaitingRestore.get(agent.session), target)) {
      captured.awaitingRestore.delete(agent.session)
      if (captured.awaitingRestore.size) return
      await this.compensate(captured, authorize)
      if (this.pending === captured) {
        // This continuation belongs to the restoring RPC. The settings event fires
        // inside the native picker's HMR transaction and can only wake the waiter.
        void captured.update.promise
          .then(() => this.compensate(captured, authorize))
          .catch(() => this.ctx.logger.warn('Unable to restore the model preference after a provisional selection.'))
      }
    }
  }

  private async compensate(captured: PickerWrite, authorize: () => void) {
    if (this.pending !== captured || captured.awaitingRestore.size) return
    const settings = this.ctx.get('settings', false)
    const current = settings?.describe({ redactSecrets: true }).find((item) => item.ns === captured.namespace)
    if (this.pending !== captured || !settings || !current) return
    const expectedRevision = captured.initialRevision + captured.targets.length
    const matches = knownRevision(captured, current.revision, current.value)
    if (matches && current.revision < expectedRevision) return
    this.pending = undefined
    if (!matches || current.revision !== expectedRevision) return
    authorize()
    try {
      // The Host validates the revision again inside the config editor's serialized mutation.
      await settings.replace(captured.namespace, captured.previous, current.revision)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'SETTINGS_CONFLICT')) throw error
    }
  }
}
