export type AcpUiOutcome = 'saved' | 'save-failed' | 'deleted' | 'delete-failed'

export interface AcpUiOutcomeSnapshot {
  readonly outcome: AcpUiOutcome
  readonly sequence: number
}

/** One app-scoped outcome store read by the shell overlay and written by ACP surfaces. */
export class AcpUiFeedback {
  private snapshot: AcpUiOutcomeSnapshot | null = null
  private sequence = 0
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): AcpUiOutcomeSnapshot | null => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly report = (outcome: AcpUiOutcome): void => {
    this.snapshot = { outcome, sequence: ++this.sequence }
    for (const listener of [...this.listeners]) listener()
  }

  readonly dismiss = (sequence: number): void => {
    if (this.snapshot?.sequence !== sequence) return
    this.snapshot = null
    for (const listener of [...this.listeners]) listener()
  }
}
