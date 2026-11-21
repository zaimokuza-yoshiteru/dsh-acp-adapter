import type { AcpHandoffCommand, AcpHandoffView } from '../../contract/handoff.ts'

export type HandoffFields = Pick<AcpHandoffView, 'document' | 'instruction' | 'allowHistory'>
type Reply =
  | { readonly ok: true; readonly value: AcpHandoffView | null }
  | {
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown }
    }

export type HandoffRequest = (session: string, command: AcpHandoffCommand) => Promise<Reply>

/** The Host owns handoffs. Keep only the views needed by mounted composers and ongoing actions. */
export class SessionHandoffClient {
  private readonly views = new Map<string, AcpHandoffView>()
  private readonly listeners = new Set<() => void>()
  private readonly reads = new Map<string, Promise<void>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly openOnDraft = new Map<string, AbortSignal>()
  private stopped = false

  constructor(
    private readonly request: HandoffRequest,
    private readonly openFromSource: (source: string, destination: string) => void,
    private readonly beginNavigation: () => AbortSignal = () => new AbortController().signal,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get(session: string): AcpHandoffView | undefined {
    return this.views.get(session)
  }

  draftDestinations(): readonly string[] {
    return [...this.views]
      .filter(([id, view]) => view.phase === 'draft' && view.destinationSessionId === id)
      .map(([id]) => id)
      .sort()
  }

  async begin(source: string, command: Extract<AcpHandoffCommand, { kind: 'begin' }>): Promise<void> {
    this.openOnDraft.set(command.id, this.beginNavigation())
    try {
      await this.change(source, command)
    } catch (error) {
      this.openOnDraft.delete(command.id)
      throw error
    }
  }

  async change(
    session: string,
    command: Exclude<AcpHandoffCommand, { kind: 'status' }>,
    editorRevision?: { current: number },
  ): Promise<void> {
    const previous = this.writes.get(command.id)
    const write = async () => {
      if (this.stopped) return
      this.revisions.set(session, (this.revisions.get(session) ?? 0) + 1)
      // Autosaves and Send from the same editor may already be queued. Advance
      // only from writes that editor actually saw acknowledged.
      const editing = editorRevision && (command.kind === 'save' || command.kind === 'send')
      const result = await this.request(session, editing ? { ...command, revision: editorRevision.current } : command)
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
      if (result.value === null) throw new Error('Handoff unavailable')
      if (editing) editorRevision.current = result.value.revision
      this.install(session, result.value)
    }
    const pending = previous ? previous.catch(() => {}).then(write) : write()
    this.writes.set(command.id, pending)
    try {
      await pending
    } finally {
      if (this.writes.get(command.id) === pending) this.writes.delete(command.id)
    }
  }

  /** A late status response must never reopen a cancelled or already sent draft. */
  refresh(session: string): Promise<void> {
    const pending = this.reads.get(session)
    if (pending) return pending
    const record = this.get(session)
    const revision = this.revisions.get(session)
    const promise = this.request(session, { kind: 'status', ...(record ? { id: record.id } : {}) })
      .then((result) => {
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        if (
          !this.stopped &&
          revision === this.revisions.get(session) &&
          this.get(session) === record &&
          result.value !== null
        )
          this.install(session, result.value)
      })
      .finally(() => {
        this.reads.delete(session)
      })
    this.reads.set(session, promise)
    return promise
  }

  private install(addressed: string, view: AcpHandoffView): void {
    if (this.stopped) return
    for (const endpoint of [view.sourceSessionId, view.destinationSessionId]) {
      if (endpoint === null) continue
      const existing = this.views.get(endpoint)
      // Looking up an earlier destination cannot replace a newer operation on its source.
      if (addressed === endpoint || existing === undefined || existing.id === view.id) this.views.set(endpoint, view)
    }
    for (const listener of this.listeners) listener()
    if (view.phase === 'draft' && view.destinationSessionId !== null) {
      const navigation = this.openOnDraft.get(view.id)
      this.openOnDraft.delete(view.id)
      if (navigation && !navigation.aborted) this.openFromSource(view.sourceSessionId, view.destinationSessionId)
    }
    if (view.phase === 'cancelled' || view.phase === 'interrupted') this.openOnDraft.delete(view.id)
  }

  resetNavigation(): void {
    this.openOnDraft.clear()
  }

  dispose(): void {
    this.stopped = true
    this.listeners.clear()
    this.views.clear()
    this.openOnDraft.clear()
  }
}
