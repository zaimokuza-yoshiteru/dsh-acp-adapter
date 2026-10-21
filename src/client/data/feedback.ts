export type AcpUiOutcome =
  'saved' | 'save-failed' | 'deleted' | 'delete-failed' | 'session-option-failed' | 'tool-approval-failed'

export type AcpUiOutcomeSnapshot = {
  readonly sequence: number
  readonly sourceSession?: { readonly id: string; readonly title: string | null }
} & (
  { readonly outcome: AcpUiOutcome } | { readonly outcome: 'delegated-question-unavailable'; readonly message: string }
)

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

  readonly report = (outcome: AcpUiOutcome, sourceSession?: AcpUiOutcomeSnapshot['sourceSession']): void => {
    this.snapshot = { outcome, sequence: ++this.sequence, ...(sourceSession === undefined ? {} : { sourceSession }) }
    for (const listener of [...this.listeners]) listener()
  }

  /** Preserve the Host-localized limitation without recreating an approval. */
  readonly reportQuestionLimitation = (
    message: string,
    sourceSession: NonNullable<AcpUiOutcomeSnapshot['sourceSession']>,
  ): void => {
    this.snapshot = { outcome: 'delegated-question-unavailable', message, sourceSession, sequence: ++this.sequence }
    for (const listener of [...this.listeners]) listener()
  }

  readonly dismiss = (sequence: number): void => {
    if (this.snapshot?.sequence !== sequence) return
    this.snapshot = null
    for (const listener of [...this.listeners]) listener()
  }
}

/** Follow only the adapter's stable child-question limitation event. */
export function followAcpQuestionLimitations(
  subscribe: (listener: (sessionId: string, message: string) => void) => () => void,
  feedback: AcpUiFeedback,
  titleOf: (sessionId: string) => string | null,
): () => void {
  // api-session/error is a string channel. Recognize only the exact terminal
  // marker emitted by our Host callback; generic Agent errors stay native.
  const suffix = ' (ACP_DELEGATED_QUESTION_UNAVAILABLE)'
  return subscribe((sessionId, error) => {
    if (sessionId === '' || !error.endsWith(suffix)) return
    const message = error.slice(0, -suffix.length).trim()
    if (message === '') return
    feedback.reportQuestionLimitation(message, { id: sessionId, title: titleOf(sessionId) })
  })
}
