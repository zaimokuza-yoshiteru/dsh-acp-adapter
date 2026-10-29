import type { AcpRecoveryState } from '../../persistence/sidecar.ts'

export interface HostExecutionOwner {
  hasPendingHostCalls?(): boolean
  hasUncommittedHostFeedback?(): boolean
  hasRetainedHostFeedback?(): boolean
  waitForHostCallsSettled?(): Promise<void>
}

interface OwnerState {
  readonly owner: HostExecutionOwner
  failed: boolean
}
function ownerIsQuiescent(owner: HostExecutionOwner): boolean {
  return (
    owner.hasPendingHostCalls?.() === false &&
    (owner.hasUncommittedHostFeedback === undefined || owner.hasUncommittedHostFeedback() === false) &&
    (owner.hasRetainedHostFeedback === undefined || owner.hasRetainedHostFeedback() === false)
  )
}

/** Host-owned continuity for retired runtimes and recovery gates. */
export class HostExecutionOwners {
  private readonly owners = new Map<string, Set<OwnerState>>()
  private readonly fallbacks = new Map<string, AcpRecoveryState>()
  private closed = false
  private closing: Promise<void> | undefined

  private assertOpen(): void {
    if (this.closed) throw new Error('ACP_HOST_CONTINUITY_CLOSED')
  }

  setRecoveryFallback(state: AcpRecoveryState): void {
    this.assertOpen()
    this.fallbacks.set(state.dshSessionId, state)
  }

  getRecoveryFallback(sessionId: string): AcpRecoveryState | undefined {
    return this.fallbacks.get(sessionId)
  }

  clearRecoveryFallback(sessionId: string): void {
    this.assertOpen()
    this.fallbacks.delete(sessionId)
  }

  /** Consumer cleanup may still add a retired runtime while an earlier one is draining. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const observed = new Set<OwnerState>()
      for (;;) {
        const batch = [...this.owners.values()].flatMap((states) => [...states]).filter((state) => !observed.has(state))
        if (batch.length === 0) break
        for (const state of batch) observed.add(state)
        await Promise.allSettled(
          batch.map((state) => Promise.resolve().then(() => state.owner.waitForHostCallsSettled?.())),
        )
      }
      this.closed = true
      // A broken observer must not silently certify a still-running tool as drained.
      if (
        [...this.owners.values()].some((states) =>
          [...states].some((state) => state.owner.hasPendingHostCalls?.() === true),
        )
      )
        throw new Error('ACP_HOST_EXECUTION_STILL_ACTIVE')
      this.owners.clear()
      this.fallbacks.clear()
    })())
  }

  /** Keep draining Host calls visible across profile adapter replacement and plugin reinstallation. */
  retain(sessionId: string, owner: HostExecutionOwner): void {
    this.assertOpen()
    if (
      owner.hasPendingHostCalls?.() !== true &&
      owner.hasUncommittedHostFeedback?.() !== true &&
      owner.hasRetainedHostFeedback?.() !== true
    )
      return
    const owners = this.owners
    let sessionOwners = owners.get(sessionId)
    if (sessionOwners === undefined) owners.set(sessionId, (sessionOwners = new Set()))
    let state = [...sessionOwners].find((candidate) => candidate.owner === owner)
    if (state === undefined) sessionOwners.add((state = { owner, failed: false }))
    const wait = owner.waitForHostCallsSettled
    if (wait === undefined) return
    void wait.call(owner).then(
      () => {
        if (owner.hasPendingHostCalls?.() === true) return
        if (owner.hasUncommittedHostFeedback?.() === true) return
        if (owner.hasRetainedHostFeedback?.() === true) return
        sessionOwners!.delete(state!)
        if (sessionOwners!.size === 0 && owners.get(sessionId) === sessionOwners) owners.delete(sessionId)
      },
      () => {
        // The observer may reject after the public tool state has already
        // settled (for example, a post-append inbox subscriber). Trust the
        // public pending/feedback facts before retaining an owner gate.
        if (ownerIsQuiescent(owner)) {
          sessionOwners!.delete(state!)
          if (sessionOwners!.size === 0 && owners.get(sessionId) === sessionOwners) owners.delete(sessionId)
        } else state!.failed = true
      },
    )
  }

  /** Recovery must fail fast while an abandoned transport can still execute or report a tool. */
  assertQuiescent(sessionId: string, allowSettledFailure = false): void {
    this.assertOpen()
    const ownerMap = this.owners
    const owners = ownerMap.get(sessionId)
    if (owners === undefined) return
    for (const state of [...owners]) {
      const pending = state.owner.hasPendingHostCalls?.() === true
      const uncommittedFeedback = state.owner.hasUncommittedHostFeedback?.() === true
      const quiescent = ownerIsQuiescent(state.owner)
      // A rejected observer promise is not permanent evidence of active work.
      // Recheck the owner's public state whenever the gate is consulted and
      // retire a previously failed owner once all work and feedback have settled.
      if (state.failed && quiescent) {
        owners.delete(state)
        continue
      }
      if (pending || (!allowSettledFailure && (state.failed || uncommittedFeedback)))
        throw new Error('ACP_HOST_EXECUTION_STILL_ACTIVE')
    }
    if (owners.size === 0) ownerMap.delete(sessionId)
  }

  /** Release the active gate after explicit recovery without mutating the retired owner's feedback. */
  clear(sessionId: string): void {
    this.assertOpen()
    const owners = this.owners
    const sessionOwners = owners.get(sessionId)
    if (sessionOwners === undefined) return
    for (const state of sessionOwners) {
      if (state.owner.hasPendingHostCalls?.() === true) throw new Error('ACP_HOST_EXECUTION_STILL_ACTIVE')
    }
    owners.delete(sessionId)
  }
}
