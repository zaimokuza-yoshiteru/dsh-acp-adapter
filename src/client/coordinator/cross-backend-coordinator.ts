/** Additive coordinator for stock DSH model selection transitions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SessionCreateError, type ISessions, type SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpOwnedRoutesView } from '../../contract/remote.ts'
import { includesRoute } from '../data/managed-routes.ts'
import { requiresAcpModelSwitchExit } from '../../contract/model-transition.ts'
import { CrossBackendTransactionController, resolveCrossBackendLocation } from '../data/cross-backend-controller.ts'
import type {
  CrossBackendFailure,
  CrossBackendModelSelection,
  CrossBackendTicket,
} from '../data/cross-backend-controller.ts'

type ModelProjection = {
  readonly lastUsed: CrossBackendModelSelection | null
  readonly next: CrossBackendModelSelection | null
}

export interface CrossBackendPending {
  readonly reason: 'backend-change' | 'model-switch'
  readonly ticket: CrossBackendTicket
  readonly failure: CrossBackendFailure | null
  readonly blockingReason?: 'no-location'
  readonly confirmable: boolean
  readonly busy: boolean
}

export interface CrossBackendCoordinatorSnapshot {
  readonly pending: CrossBackendPending | null
}

export type OwnsAcpRoute = (provider: string | undefined) => boolean

function isAcpRoute(provider: string | undefined, ownsRoute: OwnsAcpRoute): boolean {
  return provider !== undefined && ownsRoute(provider)
}

function sameSelection(
  left: CrossBackendModelSelection | null | undefined,
  right: CrossBackendModelSelection | null | undefined,
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.reasoningEffort === right?.reasoningEffort
  )
}

/** Pure observation decision, independent of React and side effects. */
export function shouldConfirmBackendTransition(
  input: {
    readonly lastUsed: CrossBackendModelSelection | null
    readonly next: CrossBackendModelSelection | null
    readonly blank: boolean
  },
  ownsRoute: OwnsAcpRoute,
): boolean {
  if (input.next === null || sameSelection(input.lastUsed, input.next)) return false
  const fromAcp = isAcpRoute(input.lastUsed?.provider, ownsRoute)
  const toAcp = isAcpRoute(input.next.provider, ownsRoute)
  if (!fromAcp && !toAcp) return false
  if (input.blank && input.lastUsed === null && toAcp) return false
  if (fromAcp && toAcp && input.lastUsed?.provider === input.next.provider)
    return requiresAcpModelSwitchExit(input.lastUsed, input.next, ownsRoute)
  return true
}

interface ObservedSession {
  readonly binding: SessionBinding
  unsubscribe: () => void
  lastProjection: ModelProjection | undefined
  suppressed: CrossBackendModelSelection | undefined
  staging: boolean
}

export class CrossBackendCoordinator {
  private readonly tx = new CrossBackendTransactionController()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly observed = new Map<SessionId, ObservedSession>()
  private readonly queued: CrossBackendPending[] = []
  private pending: CrossBackendPending | null = null
  private snapshot: CrossBackendCoordinatorSnapshot = { pending: null }
  private disposed = false
  private readonly ticketChecks = new Map<string, (routes: AcpOwnedRoutesView) => boolean>()
  private readonly ownsRoute: OwnsAcpRoute = (provider) => includesRoute(this.routes.getSnapshot().providers, provider)

  constructor(
    private readonly ctx: Context,
    private readonly routes: {
      getSnapshot(): AcpOwnedRoutesView
      subscribe(changed: () => void): () => void
    },
  ) {}

  start(): () => void {
    // dsh-session also exposes a host-side `ctx.sessions` store. Resolve the
    // public client faces through Cordis by name so both packages can coexist
    // in one TypeScript program without merging incompatible Context fields.
    const sessions = this.ctx.get('sessions') as unknown as ISessions | undefined
    if (sessions === undefined || typeof sessions.list?.subscribe !== 'function') {
      return () => this.dispose()
    }
    const syncBindings = (): void => {
      if (this.disposed) return
      const rows = sessions.list.getSnapshot().byId
      for (const [id, observed] of this.observed) {
        if (sessions.binding(id) !== observed.binding || rows[id] === undefined) {
          observed.unsubscribe()
          this.observed.delete(id)
        }
      }
      for (const row of Object.values(rows)) {
        if (this.observed.has(row.id)) continue
        // Borrow the generation already owned by a view/resource. Merely listing
        // history must not keep every Session resident or reopen it.
        const binding = sessions.binding(row.id)
        const projection = binding?.session.projections.faceOf('modelSelection')
        if (binding === undefined || projection === undefined) continue
        const observed: ObservedSession = {
          binding,
          unsubscribe: () => {},
          lastProjection: undefined,
          suppressed: undefined,
          staging: false,
        }
        this.observed.set(row.id, observed)
        observed.unsubscribe = projection.subscribe(() => {
          this.observe(row.id, observed)
        })
        this.observe(row.id, observed)
      }
    }
    this.unsubscribers.push(
      sessions.list.subscribe(syncBindings),
      this.routes.subscribe(() => this.withdrawChangedRoutes()),
    )
    syncBindings()
    return () => this.dispose()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): CrossBackendCoordinatorSnapshot {
    return this.snapshot
  }

  private forget(key: string): void {
    this.ticketChecks.delete(key)
    this.tx.forget(key)
  }

  private withdrawChangedRoutes(): void {
    for (const [key, current] of this.ticketChecks) {
      if (!current(this.routes.getSnapshot())) this.forget(key)
    }
    for (let i = this.queued.length - 1; i >= 0; i--)
      if (!this.ticketChecks.has(this.queued[i]!.ticket.key)) this.queued.splice(i, 1)
    if (this.pending !== null && !this.ticketChecks.has(this.pending.ticket.key)) {
      this.pending = this.queued.shift() ?? null
      this.emit()
    }
  }

  async confirm(): Promise<void> {
    const pending = this.pending
    if (pending === null || this.disposed || !pending.confirmable || pending.busy) return
    this.pending = { ...pending, busy: true, failure: null }
    this.suppressSelection(pending.ticket.sourceSessionId, pending.ticket.sourceSelection)
    this.emit()
    const result = await this.tx.confirm(pending.ticket, this.operationsFor(pending.ticket))
    if (this.disposed || this.pending?.ticket.key !== pending.ticket.key) return
    if (result.ok) {
      this.forget(pending.ticket.key)
      this.pending = this.queued.shift() ?? null
    } else {
      this.pending = { ...pending, busy: false, failure: result.failure }
    }
    this.emit()
  }

  async cancel(): Promise<void> {
    const pending = this.pending
    if (pending === null || this.disposed || pending.busy) return
    const source = pending.ticket.sourceSelection
    if (source === undefined) {
      this.forget(pending.ticket.key)
      this.pending = this.queued.shift() ?? null
      this.emit()
      return
    }
    this.pending = { ...pending, busy: true, failure: null }
    this.suppressSelection(pending.ticket.sourceSessionId, source)
    this.emit()
    const result = await this.tx.cancel(pending.ticket, this.operationsFor(pending.ticket))
    if (this.disposed || this.pending?.ticket.key !== pending.ticket.key) return
    if (result.ok) {
      this.forget(pending.ticket.key)
      this.pending = this.queued.shift() ?? null
    } else this.pending = { ...pending, busy: false, failure: result.failure }
    this.emit()
  }

  private observe(sessionId: SessionId, observed: ObservedSession): void {
    if (this.disposed || this.observed.get(sessionId) !== observed) return
    const sessions = this.ctx.get('sessions') as unknown as ISessions
    const session = sessions.binding(sessionId)
    const value = session?.session.projections.faceOf('modelSelection').getSnapshot()
    const projection = value as ModelProjection | undefined
    if (projection === undefined || sameSelection(observed.lastProjection?.next, projection.next)) return
    // `lastUsed` is the last committed turn model.  A stock picker change can
    // leave an uncommitted `next` selection in the projection (for example a
    // same-profile reasoning change); if the user immediately chooses another
    // backend, cancellation must restore that visible pre-transition choice,
    // not the older committed model.
    const modelSwitch =
      projection.next !== null && requiresAcpModelSwitchExit(projection.lastUsed, projection.next, this.ownsRoute)
    const firstObservation = observed.lastProjection === undefined
    const previousChoice = observed.lastProjection?.next
    const sourceSelection =
      modelSwitch &&
      previousChoice != null &&
      requiresAcpModelSwitchExit(projection.lastUsed, previousChoice, this.ownsRoute)
        ? projection.lastUsed
        : (previousChoice ?? projection.lastUsed)
    observed.lastProjection = projection
    if (sameSelection(observed.suppressed, projection.next) && observed.suppressed !== undefined) {
      observed.suppressed = undefined
      return
    }
    if (
      observed.staging ||
      this.pending?.ticket.sourceSessionId === sessionId ||
      this.queued.some((item) => item.ticket.sourceSessionId === sessionId)
    )
      return
    const row = sessions.list.getSnapshot().byId[sessionId]
    const next = projection.next
    if (next === null || sameSelection(projection.lastUsed, next)) return
    const sourceProvider = projection.lastUsed?.provider
    const sourceStatus = (routes: AcpOwnedRoutesView) => {
      if (includesRoute(routes.providers, sourceProvider)) return 'active'
      return includesRoute(routes.historicalProviders, sourceProvider) ? 'historical' : 'native'
    }
    const source = sourceStatus(this.routes.getSnapshot())
    const targetOwned = this.ownsRoute(next.provider)
    const transition = shouldConfirmBackendTransition(
      { lastUsed: projection.lastUsed, next, blank: row?.blank === true },
      this.ownsRoute,
    )
    if (!transition && source !== 'historical') return
    // A retired model cannot be written back. Its pending choice can survive
    // cancel, navigation or reload; only a new choice opens this dialog.
    if (firstObservation && source === 'historical') return

    const workspaces = (this.ctx.get('workspaces') as IWorkspaces).list.getSnapshot()
    const location = resolveCrossBackendLocation(sessionId, workspaces.items, row?.cwd)
    const ticket: CrossBackendTicket = {
      key: globalThis.crypto.randomUUID(),
      sourceSessionId: sessionId,
      sourceSelection: sourceSelection ?? undefined,
      targetSelection: next,
      location: location ?? {},
    }
    // Track both the execution source and any previously pending selection
    // the stock picker would restore. A same-named replacement cannot inherit intent.
    const restoreOwned = this.ownsRoute(sourceSelection?.provider)
    this.ticketChecks.set(
      ticket.key,
      (routes) =>
        sourceStatus(routes) === source &&
        includesRoute(routes.providers, next.provider) === targetOwned &&
        includesRoute(routes.providers, sourceSelection?.provider) === restoreOwned,
    )
    void this.stagePending(ticket, observed, projection, source === 'historical', transition, location === undefined)
  }

  private async stagePending(
    ticket: CrossBackendTicket,
    observed: ObservedSession,
    projection: ModelProjection,
    historicalSource: boolean,
    liveTransition: boolean,
    noLocation: boolean,
  ): Promise<void> {
    const current = () =>
      this.ticketChecks.has(ticket.key) && this.observed.get(ticket.sourceSessionId as SessionId) === observed
    if (historicalSource) {
      const backend = await this.ctx.remote.dshAcp.backendOf(ticket.sourceSessionId).catch(() => undefined)
      const bound =
        backend?.ok &&
        backend.value.state === 'established' &&
        backend.value.acpBinding === true &&
        backend.value.provider === projection.lastUsed?.provider
      if (!current() || observed.lastProjection !== projection || !backend?.ok || (!bound && !liveTransition)) {
        this.forget(ticket.key)
        return
      }
      // The removed source cannot be selected again through the Host catalog.
      // Its durable history stays guarded even if another plugin reuses the name.
      if (bound) ticket = { ...ticket, sourceSelection: undefined, sourceUnavailable: true }
    }
    const source = ticket.sourceSelection
    observed.staging = true
    if (source !== undefined) this.suppressSelection(ticket.sourceSessionId, source)
    const restored: { ok: boolean; message?: string } =
      source === undefined ? { ok: true as const } : await this.operationsFor(ticket).restoreSource(source)
    observed.staging = false
    if (!current()) {
      this.forget(ticket.key)
      return
    }
    const pending: CrossBackendPending = {
      reason:
        source !== undefined && requiresAcpModelSwitchExit(source, ticket.targetSelection, this.ownsRoute)
          ? 'model-switch'
          : 'backend-change',
      ticket: restored.ok && source !== undefined ? { ...ticket, sourceAlreadyRestored: true } : ticket,
      failure: restored.ok
        ? null
        : { phase: 'restore-source', message: restored.message ?? 'source model restore failed' },
      ...(noLocation ? { blockingReason: 'no-location' as const } : {}),
      confirmable: restored.ok && !noLocation,
      busy: false,
    }
    if (this.pending === null) this.pending = pending
    else this.queued.push(pending)
    this.emit()
  }

  /** A catalog notification may still be in transit when the user confirms. */
  private async verifyTicket(key: string): Promise<boolean> {
    if (!this.ticketChecks.has(key)) return false
    const result = await this.ctx.remote.dshAcp.ownedProviderRoutes().catch(() => undefined)
    if (!result?.ok) return false
    if (this.ticketChecks.get(key)?.(result.value)) return true
    this.forget(key)
    this.withdrawChangedRoutes()
    return false
  }

  private operationsFor(ticket: CrossBackendTicket) {
    const current = () => this.ticketChecks.has(ticket.key)
    const withdrawn = { ok: false, message: 'The model selection changed.' }
    const remote = this.ctx.remote as TypertClientRemote
    const sessions = this.ctx.get('sessions') as unknown as ISessions
    return {
      restoreSource: async (selection: CrossBackendModelSelection) => {
        if (!current()) return withdrawn
        try {
          const result = await remote.session.selectModel({
            sessionId: ticket.sourceSessionId as SessionId,
            ...selection,
          })
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      createDestination: async ({
        sessionId,
        location,
      }: {
        sessionId: string
        location: { workspaceId?: string; cwd?: string }
      }) => {
        if (!(await this.verifyTicket(ticket.key))) return withdrawn
        try {
          const child = await sessions.create({
            sessionId: sessionId as SessionId,
            ...(location.cwd === undefined ? {} : { cwd: location.cwd }),
            ...(location.workspaceId === undefined ? {} : { workspaceId: location.workspaceId as never }),
          })
          return { sessionId: child }
        } catch (error) {
          if (error instanceof SessionCreateError && error.rpcError.code === 'session/workspace-attach-failed')
            return { sessionId: error.rpcError.details.sessionId, attachmentError: error.message }
          // A transport timeout can race a successful Host create. Reuse the
          // preallocated id when the authoritative list already contains it.
          if (sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined) return { sessionId }
          return { message: error instanceof Error ? error.message : String(error) }
        }
      },
      selectDestination: async (sessionId: string, selection: CrossBackendModelSelection) => {
        if (!(await this.verifyTicket(ticket.key))) return withdrawn
        try {
          const result = await remote.session.selectModel({ sessionId: sessionId as SessionId, ...selection })
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      openDestination: async (sessionId: string) => {
        if (!current()) return withdrawn
        try {
          this.ctx.uiWorkspace.openSession(sessionId as SessionId)
          return { ok: true }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }
  }

  private emit(): void {
    this.snapshot = { pending: this.pending }
    for (const listener of [...this.listeners]) listener()
  }

  private suppressSelection(sessionId: string, selection: CrossBackendModelSelection | undefined): void {
    if (selection === undefined) return
    const observed = this.observed.get(sessionId as SessionId)
    if (observed !== undefined) observed.suppressed = selection
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const observed of this.observed.values()) observed.unsubscribe()
    this.observed.clear()
    this.queued.length = 0
    for (const key of this.ticketChecks.keys()) this.forget(key)
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.listeners.clear()
  }
}
