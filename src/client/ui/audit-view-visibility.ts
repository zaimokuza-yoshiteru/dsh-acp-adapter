/** Per-session presentation ownership, independent of the global Slot roster. */
export class AcpAuditViewVisibility {
  private readonly owners = new Map<string, Set<object>>()
  private readonly listeners = new Map<string, Set<() => void>>()

  readonly visible = (sessionId: string): boolean => (this.owners.get(sessionId)?.size ?? 0) > 0

  readonly setVisible = (sessionId: string, visible: boolean, owner: object): void => {
    const before = this.visible(sessionId)
    const owners = this.owners.get(sessionId) ?? new Set<object>()
    if (visible) {
      owners.add(owner)
      this.owners.set(sessionId, owners)
    } else {
      owners.delete(owner)
      if (owners.size === 0) this.owners.delete(sessionId)
    }
    if (before !== this.visible(sessionId)) {
      for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener()
    }
  }

  readonly subscribe = (sessionId: string, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }
}
