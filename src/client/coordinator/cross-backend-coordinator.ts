/** Additive coordinator for stock DSH model selection transitions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpOwnedRoutesView } from '../../contract/remote.ts'
import { includesRoute } from '../data/managed-routes.ts'
import { requiresAcpModelSwitchExit } from '../../contract/model-transition.ts'
import { CrossBackendTransactionController, resolveCrossBackendLocation } from '../data/cross-backend-controller.ts'
import type {
  CrossBackendFailure,
  CrossBackendLocation,
  CrossBackendModelSelection,
  CrossBackendTicket,
} from '../data/cross-backend-controller.ts'

import {
  createIndependentChild,
  isMainSession,
  presetUnavailable,
  reconcileIndependentChild,
  openIndependentChild,
  DefaultPresetRepair,
  definiteCreateRefusal,
  sourcePresetUnavailable,
  sessionCreateFailure,
  withDefaultPreset,
} from './native-session-navigation.ts'

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
  readonly useDefault?: true
}

interface CreatedSession {
  readonly source: string
  readonly child: SessionId
}

export interface CrossBackendCoordinatorSnapshot {
  readonly created: readonly CreatedSession[]
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
    readonly preset?: unknown
  },
  ownsRoute: OwnsAcpRoute,
): boolean {
  if (input.next === null || sameSelection(input.lastUsed, input.next)) return false
  const fromAcp = isAcpRoute(input.lastUsed?.provider, ownsRoute)
  const toAcp = isAcpRoute(input.next.provider, ownsRoute)
  if (!fromAcp && !toAcp) return false
  if (input.blank && input.lastUsed === null && toAcp) return false
  if (fromAcp && toAcp && input.lastUsed?.provider === input.next.provider)
    return requiresAcpModelSwitchExit(input.lastUsed, input.next, ownsRoute, input.preset)
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
  private created: readonly CreatedSession[] = []
  private readonly offered = new WeakSet<CrossBackendTicket>()
  private readonly uncertainCreations = new Map<
    string,
    {
      ticket: CrossBackendTicket
      requested: SessionId
      checking: boolean
      presetRefused: boolean
      refused: boolean
      repair: DefaultPresetRepair
    }
  >()
  private snapshot: CrossBackendCoordinatorSnapshot = { pending: null, created: [] }
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
      this.reconcileWithdrawn()
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
    this.uncertainCreations.delete(key)
    this.ticketChecks.delete(key)
    this.tx.forget(key)
  }

  private offerCreated(ticket: CrossBackendTicket, child: string): void {
    if (this.disposed || this.offered.has(ticket)) return
    this.offered.add(ticket)
    this.created = [...this.created, { source: ticket.sourceSessionId, child: child as SessionId }]
    this.emit()
  }

  dismissCreated(source: string, child: SessionId): void {
    this.created = this.created.filter((entry) => entry.source !== source || entry.child !== child)
    this.emit()
  }

  openCreated(source: SessionId, child: SessionId, allowed: () => boolean): boolean {
    const sessions = this.ctx.get('sessions') as unknown as ISessions
    if (
      this.disposed ||
      !this.created.some((entry) => entry.source === source && entry.child === child) ||
      !isMainSession(sessions, source) ||
      !sessions.list.getSnapshot().byId[child]?.blank ||
      !allowed()
    )
      return false
    this.ctx.uiWorkspace.openSession(child)
    this.dismissCreated(source, child)
    return true
  }

  /** A lost create acknowledgement can outlive its route. Publish only a blank row
   * confirmed by a fresh Host reply; the source dock observes the child's live follow grant. */
  private reconcileWithdrawn(): void {
    if (this.disposed || !this.uncertainCreations.size) return
    const list = (this.ctx.get('sessions') as unknown as ISessions).list.getSnapshot()
    if (list.phase !== 'ready') return
    const candidates = [...this.uncertainCreations.values()].filter(
      (candidate) =>
        !candidate.checking && !this.ticketChecks.has(candidate.ticket.key) && list.byId[candidate.requested]?.blank,
    )
    if (!candidates.length) return
    for (const candidate of candidates) candidate.checking = true
    void this.ctx.remote.session
      .list({})
      .then((result) => {
        if (!result.ok || this.disposed) return
        for (const candidate of candidates) {
          if (
            this.uncertainCreations.get(candidate.ticket.key) === candidate &&
            result.value.items.some((row) => row.sessionId === candidate.requested && row.blank)
          ) {
            this.uncertainCreations.delete(candidate.ticket.key)
            this.offerCreated(candidate.ticket, candidate.requested)
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        for (const candidate of candidates) candidate.checking = false
      })
  }

  private withdraw(key: string): void {
    const pending = this.pending
    const child = this.tx.confirmedDestination(key)
    this.ticketChecks.delete(key)
    this.tx.forget(key)
    this.reconcileWithdrawn()
    if (child !== undefined && pending?.ticket.key === key) this.offerCreated(pending.ticket, child)
  }

  private withdrawChangedRoutes(): void {
    for (const [key, current] of this.ticketChecks) {
      if (!current(this.routes.getSnapshot())) this.withdraw(key)
    }
    for (let i = this.queued.length - 1; i >= 0; i--)
      if (!this.ticketChecks.has(this.queued[i]!.ticket.key)) this.queued.splice(i, 1)
    if (this.pending !== null && !this.ticketChecks.has(this.pending.ticket.key)) {
      this.pending = this.queued.shift() ?? null
      this.emit()
    }
  }

  async confirm(expectedKey?: string, useDefault = false): Promise<void> {
    let pending = this.pending
    if (
      pending === null ||
      this.disposed ||
      !pending.confirmable ||
      pending.busy ||
      (expectedKey !== undefined && pending.ticket.key !== expectedKey)
    )
      return
    if (pending.failure?.phase === 'preset-unavailable') {
      if (!useDefault) return
      pending = { ...pending, useDefault: true }
    }
    this.pending = { ...pending, busy: true, failure: null }
    this.suppressSelection(pending.ticket.sourceSessionId, pending.ticket.sourceSelection)
    this.emit()
    const result = await this.tx.confirm(pending.ticket, this.operationsFor(pending.ticket, pending.useDefault))
    if (this.disposed) return
    if (this.pending?.ticket.key !== pending.ticket.key) {
      // A revocation may arrive while create is in flight, before the transaction knows its published ID.
      if (
        !result.ok &&
        ['select-destination', 'open-destination', 'ungrouped-destination'].includes(result.failure.phase) &&
        result.failure.destinationSessionId !== undefined
      )
        this.offerCreated(pending.ticket, result.failure.destinationSessionId)
      return
    }
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
    const row = sessions.list.getSnapshot().byId[sessionId]
    const sessionPreset = observed.binding.session.projections.faceOf('agentPreset').getSnapshot()
    const preset = typeof sessionPreset === 'string' ? sessionPreset : row?.projectionValues?.agentPreset
    // `lastUsed` is the last committed turn model.  A stock picker change can
    // leave an uncommitted `next` selection in the projection (for example a
    // same-profile reasoning change); if the user immediately chooses another
    // backend, cancellation must restore that visible pre-transition choice,
    // not the older committed model.
    const modelSwitch =
      projection.next !== null &&
      requiresAcpModelSwitchExit(projection.lastUsed, projection.next, this.ownsRoute, preset)
    const firstObservation = observed.lastProjection === undefined
    const previousChoice = observed.lastProjection?.next
    const sourceSelection =
      modelSwitch &&
      previousChoice != null &&
      requiresAcpModelSwitchExit(projection.lastUsed, previousChoice, this.ownsRoute, preset)
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
    const next = projection.next
    if (next === null || sameSelection(projection.lastUsed, next)) return
    const sourceProvider = projection.lastUsed?.provider
    const sourceStatus = (routes: AcpOwnedRoutesView) => {
      if (includesRoute(routes.providers, sourceProvider)) return 'active'
      return includesRoute(routes.historicalProviders, sourceProvider) ? 'historical' : 'native'
    }
    const initialRoutes = this.routes.getSnapshot()
    const source = sourceStatus(initialRoutes)
    const targetOwned = this.ownsRoute(next.provider)
    const transition = shouldConfirmBackendTransition(
      { lastUsed: projection.lastUsed, next, blank: row?.blank === true, preset },
      this.ownsRoute,
    )
    if (!transition && source !== 'historical') return
    // A retired model cannot be written back. Its pending choice can survive
    // cancel, navigation or reload; only a new choice opens this dialog.
    if (firstObservation && source === 'historical') return

    const workspaces = (this.ctx.get('workspaces') as IWorkspaces).list.getSnapshot()
    const location = resolveCrossBackendLocation(sessionId, workspaces.items, row?.cwd, preset)
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
        [sourceProvider, next.provider, sourceSelection?.provider].every(
          (provider) =>
            provider === undefined ||
            initialRoutes.generations?.[provider] === undefined ||
            initialRoutes.generations[provider] === routes.generations?.[provider],
        ) &&
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
        source !== undefined &&
        requiresAcpModelSwitchExit(source, ticket.targetSelection, this.ownsRoute, ticket.location.agentPreset)
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
    this.withdraw(key)
    this.withdrawChangedRoutes()
    return false
  }

  private operationsFor(ticket: CrossBackendTicket, useDefault = false) {
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
        location: sourceLocation,
      }: {
        sessionId: string
        location: CrossBackendLocation
      }) => {
        if (!(await this.verifyTicket(ticket.key))) return withdrawn
        const location = useDefault ? withDefaultPreset(sourceLocation) : sourceLocation
        const requested = sessionId as SessionId
        const reconcile = async () => {
          const state = await reconcileIndependentChild(this.ctx, requested, location)
          if (state === 'missing') return undefined
          return state === 'ungrouped'
            ? { sessionId, attachmentError: 'Workspace attachment was not confirmed.' }
            : { sessionId }
        }
        const uncertain = this.uncertainCreations.get(ticket.key)
        if (uncertain !== undefined) {
          let confirmed
          try {
            confirmed = await reconcile()
          } catch (error) {
            return { uncertain: true as const, message: error instanceof Error ? error.message : String(error) }
          }
          if (confirmed !== undefined) {
            if (!uncertain.presetRefused) {
              this.uncertainCreations.delete(ticket.key)
              return confirmed
            }
            const repaired = await uncertain.repair.run(this.ctx, requested, current)
            this.uncertainCreations.delete(ticket.key)
            return { ...confirmed, sessionId: repaired }
          }
          if (!uncertain.refused)
            return { uncertain: true as const, message: 'Session creation has not been confirmed.' }
          if (!current()) return withdrawn
        }
        if (location.agentPreset && (await sourcePresetUnavailable(this.ctx, location.agentPreset))) {
          return { message: 'The source mode is unavailable.', presetUnavailable: true as const }
        }
        if (!current()) return withdrawn
        try {
          const child = await createIndependentChild(sessions, requested, location)
          this.uncertainCreations.delete(ticket.key)
          return { sessionId: child }
        } catch (error) {
          const failure = sessionCreateFailure(error)
          if (failure?.code === 'session/workspace-attach-failed')
            return {
              sessionId: failure.details.sessionId,
              attachmentError: error instanceof Error ? error.message : failure.message,
            }
          const message = error instanceof Error ? error.message : String(error)
          const refused = presetUnavailable(failure?.code, location)
          const terminal = definiteCreateRefusal(failure?.code)
          if (!this.disposed)
            this.uncertainCreations.set(ticket.key, {
              ticket,
              requested,
              checking: false,
              presetRefused: refused,
              refused: terminal,
              repair: new DefaultPresetRepair(),
            })
          if (refused) {
            this.reconcileWithdrawn()
            return { message, presetUnavailable: true as const }
          }
          const confirmed = await reconcile().catch(() => undefined)
          if (confirmed !== undefined) this.uncertainCreations.delete(ticket.key)
          else this.reconcileWithdrawn()
          return confirmed ?? (terminal ? { message } : { message, uncertain: true as const })
        }
      },
      selectDestination: async (sessionId: string, selection: CrossBackendModelSelection) => {
        if (!(await this.verifyTicket(ticket.key))) return withdrawn
        try {
          const result = await remote.session.selectModel({ sessionId: sessionId as SessionId, ...selection })
          if (!result.ok && result.error.code === 'session/model-unavailable' && current()) {
            const catalog = await remote.session.modelCatalog().catch(() => undefined)
            if (
              catalog?.ok &&
              !catalog.value.failures.some((failure) => failure.id === selection.provider) &&
              !catalog.value.groups.some(
                (group) =>
                  group.id === selection.provider && group.models.some((model) => model.id === selection.model),
              )
            ) {
              this.withdraw(ticket.key)
              this.withdrawChangedRoutes()
            }
          }
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
      openDestination: async (sessionId: string) => {
        if (!(await this.verifyTicket(ticket.key))) return withdrawn
        try {
          openIndependentChild(this.ctx, sessionId as SessionId)
          return { ok: true }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }
  }

  private emit(): void {
    this.snapshot = { pending: this.pending, created: this.created }
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
    this.uncertainCreations.clear()
    this.queued.length = 0
    for (const key of this.ticketChecks.keys()) this.forget(key)
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.listeners.clear()
  }
}
