/**
 * Transactional handoff between DSH execution backends.
 *
 * This module deliberately has no DSH settings or UI dependency.  The stock
 * session controller remains the authority for model selection: restoring the
 * source calls `session.selectModel(source)`, and selecting the destination
 * calls the same official operation after the destination exists.  That gives
 * the host its normal "selection becomes default" semantics without a second
 * plugin-owned default store.
 */

/** Client-safe model selection shape; intentionally independent of the legacy picker. */
export interface CrossBackendModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface CrossBackendLocation {
  readonly workspaceId?: string
  readonly cwd?: string
}

export interface CrossBackendTicket {
  readonly key: string
  readonly sourceSessionId: string
  readonly sourceSelection: CrossBackendModelSelection | undefined
  readonly targetSelection: CrossBackendModelSelection
  readonly location: CrossBackendLocation
  readonly label?: string
  /** The additive observer already compensated the stock picker's source
   * mutation before showing its confirmation UI. */
  readonly sourceAlreadyRestored?: true
}

export type CrossBackendPhase =
  | 'restore-source'
  | 'create-destination'
  | 'select-destination'
  | 'open-destination'
  | 'completed'

export interface CrossBackendFailure {
  readonly phase: CrossBackendPhase
  readonly message: string
  readonly destinationSessionId?: string
}

export type CrossBackendResult =
  | { readonly ok: true; readonly destinationSessionId: string }
  | { readonly ok: false; readonly failure: CrossBackendFailure }

export interface CrossBackendCreateResult {
  /** The host published the session even when workspace attachment failed. */
  readonly published: boolean
  readonly message?: string
}

export interface CrossBackendOperationResult {
  readonly ok: boolean
  readonly message?: string
}

export interface CrossBackendOperations {
  restoreSource(selection: CrossBackendModelSelection): Promise<CrossBackendOperationResult>
  createDestination(input: {
    sessionId: string
    location: CrossBackendLocation
  }): Promise<CrossBackendCreateResult>
  selectDestination(sessionId: string, selection: CrossBackendModelSelection): Promise<CrossBackendOperationResult>
  openDestination(sessionId: string): Promise<CrossBackendOperationResult>
}

interface TransactionState {
  readonly destinationSessionId: string
  sourceRestored: boolean
  destinationCreated: boolean
  destinationSelected: boolean
  opened: boolean
}

function messageOf(message: string | undefined, fallback: string): string {
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

/**
 * Resolves the only locations that are truthful for a new session.  Workspace
 * membership wins over cwd because it preserves DSH's grouping semantics.
 */
export function resolveCrossBackendLocation(
  sessionId: string,
  workspaces: readonly { workspaceId: string; sessionIds: readonly string[] }[],
  cwd: string | undefined,
): CrossBackendLocation | undefined {
  const workspace = workspaces.find((candidate) => candidate.sessionIds.includes(sessionId))
  if (workspace !== undefined) return { workspaceId: workspace.workspaceId }
  if (typeof cwd === 'string' && cwd.length > 0) return { cwd }
  return undefined
}

/**
 * Small stateful coordinator.  A ticket key identifies one user decision;
 * retries reuse its preallocated destination id and skip completed phases.
 * No phase after destination selection writes a separate default: the official
 * destination `selectModel` call is the sole default-producing operation.
 */
export class CrossBackendTransactionController {
  private readonly states = new Map<string, TransactionState>()

  private stateFor(ticket: CrossBackendTicket): TransactionState {
    const existing = this.states.get(ticket.key)
    if (existing !== undefined) return existing
    const state: TransactionState = {
      destinationSessionId: `session-${globalThis.crypto.randomUUID()}`,
      sourceRestored: ticket.sourceAlreadyRestored === true,
      destinationCreated: false,
      destinationSelected: false,
      opened: false,
    }
    this.states.set(ticket.key, state)
    return state
  }

  async confirm(ticket: CrossBackendTicket, operations: CrossBackendOperations): Promise<CrossBackendResult> {
    const state = this.stateFor(ticket)
    if (!state.sourceRestored && ticket.sourceSelection !== undefined) {
      const restored = await operations.restoreSource(ticket.sourceSelection)
      if (!restored.ok) {
        return { ok: false, failure: { phase: 'restore-source', message: messageOf(restored.message, 'source model restore failed'), destinationSessionId: state.destinationSessionId } }
      }
      state.sourceRestored = true
    }
    // A blank launcher has no previous model to restore.  It is still safe to
    // create a destination because no semantic context is being replaced.
    if (ticket.sourceSelection === undefined) state.sourceRestored = true

    if (!state.destinationCreated) {
      let created: CrossBackendCreateResult = { published: false }
      try {
        created = await operations.createDestination({ sessionId: state.destinationSessionId, location: ticket.location })
      } catch (error) {
        return { ok: false, failure: { phase: 'create-destination', message: messageOf(error instanceof Error ? error.message : undefined, 'destination creation failed'), destinationSessionId: state.destinationSessionId } }
      }
      if (!created.published) {
        return { ok: false, failure: { phase: 'create-destination', message: messageOf(created.message, 'destination creation failed'), destinationSessionId: state.destinationSessionId } }
      }
      state.destinationCreated = true
    }

    if (!state.destinationSelected) {
      const selected = await operations.selectDestination(state.destinationSessionId, ticket.targetSelection)
      if (!selected.ok) {
        return { ok: false, failure: { phase: 'select-destination', message: messageOf(selected.message, 'destination model selection failed'), destinationSessionId: state.destinationSessionId } }
      }
      state.destinationSelected = true
    }

    if (!state.opened) {
      const opened = await operations.openDestination(state.destinationSessionId)
      if (!opened.ok) {
        return { ok: false, failure: { phase: 'open-destination', message: messageOf(opened.message, 'opening destination failed'), destinationSessionId: state.destinationSessionId } }
      }
      state.opened = true
    }

    return { ok: true, destinationSessionId: state.destinationSessionId }
  }

  /** Cancel restores the source only; it never creates or opens a destination. */
  async cancel(ticket: CrossBackendTicket, operations: CrossBackendOperations): Promise<CrossBackendResult> {
    if (ticket.sourceAlreadyRestored === true) {
      this.states.delete(ticket.key)
      return { ok: true, destinationSessionId: '' }
    }
    if (ticket.sourceSelection === undefined) return { ok: true, destinationSessionId: '' }
    const restored = await operations.restoreSource(ticket.sourceSelection)
    if (!restored.ok) {
      return { ok: false, failure: { phase: 'restore-source', message: messageOf(restored.message, 'source model restore failed') } }
    }
    this.states.delete(ticket.key)
    return { ok: true, destinationSessionId: '' }
  }

  /** Explicitly discard a completed/failed transaction after the UI is done. */
  forget(key: string): void {
    this.states.delete(key)
  }
}
