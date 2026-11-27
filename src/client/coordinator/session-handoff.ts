import type { AcpHandoffCommand, AcpHandoffView } from '../../contract/handoff.ts'

export type HandoffFields = Pick<AcpHandoffView, 'document' | 'instruction' | 'allowHistory'>
type Reply =
  | { readonly ok: true; readonly value: AcpHandoffView | null }
  | {
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown }
    }

export type HandoffRequest = (session: string, command: AcpHandoffCommand) => Promise<Reply>

function denied(code: string): boolean {
  return code === 'remote-access/denied' || code === 'dsh-acp/user-rejected'
}

/** The Host owns handoffs. Keep only the views needed by mounted composers and ongoing actions. */
export class SessionHandoffClient {
  private readonly views = new Map<string, AcpHandoffView>()
  private readonly listeners = new Set<() => void>()
  private readonly reads = new Map<string, Promise<void>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly openOnDestination = new Map<string, { signal: AbortSignal; automatic: boolean }>()
  private readonly automaticTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private connection = 0
  private stopped = false

  readonly connectionVersion = () => this.connection

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
    this.openOnDestination.set(command.id, { signal: this.beginNavigation(), automatic: command.automatic === true })
    try {
      await this.change(source, command)
    } catch (error) {
      // begin may have committed before its acknowledgement was lost.
      await this.refresh(source).catch(() => {})
      if (this.get(source)?.id === command.id) return
      this.openOnDestination.delete(command.id)
      throw error
    }
  }

  async change(
    session: string,
    command: Exclude<AcpHandoffCommand, { kind: 'status' }>,
    editorRevision?: { current: number },
  ): Promise<void> {
    const previous = this.writes.get(command.id)
    const connection = this.connection
    const bound = this.get(session)?.id === command.id
    const assertCurrent = () => {
      if (this.stopped || connection !== this.connection) throw new Error('Handoff connection changed')
      if (bound && this.get(session)?.id !== command.id) throw new Error('Handoff unavailable')
    }
    const write = async () => {
      assertCurrent()
      this.revisions.set(session, (this.revisions.get(session) ?? 0) + 1)
      // Autosaves and Send from the same editor may already be queued. Advance
      // only from writes that editor actually saw acknowledged.
      const editing = editorRevision && 'revision' in command
      const result = await this.request(session, editing ? { ...command, revision: editorRevision.current } : command)
      assertCurrent()
      if (!result.ok) {
        if (denied(result.error.code) && this.get(session)?.id === command.id) this.forget(this.get(session))
        throw Object.assign(new Error(result.error.message), result.error)
      }
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
    const connection = this.connection
    // Lookup by endpoint so a completed transfer never pins the source to an old operation.
    const promise = this.request(session, { kind: 'status' })
      .then((result) => {
        if (
          this.stopped ||
          connection !== this.connection ||
          revision !== this.revisions.get(session) ||
          this.get(session) !== record
        )
          return
        if (!result.ok) {
          if (denied(result.error.code)) this.forget(record)
          throw Object.assign(new Error(result.error.message), result.error)
        }
        if (result.value) this.install(session, result.value)
        else this.forget(record)
      })
      .finally(() => {
        if (this.reads.get(session) === promise) this.reads.delete(session)
      })
    this.reads.set(session, promise)
    return promise
  }

  /** Continue a local model selection even if its source composer is unmounted.
   * The captured navigation signal independently governs whether focus follows. */
  followsSummary(id: string): boolean {
    return this.openOnDestination.get(id)?.automatic === true
  }

  private followSummary(view: AcpHandoffView): void {
    if (this.stopped || !this.followsSummary(view.id) || this.automaticTimers.has(view.id)) return
    const timer = setTimeout(async () => {
      try {
        if (!this.followsSummary(view.id) || this.get(view.sourceSessionId)?.id !== view.id) return
        await this.refresh(view.sourceSessionId)
      } catch {
        // A later status read reconciles lost acknowledgements without resubmitting.
      } finally {
        this.automaticTimers.delete(view.id)
        const latest = this.get(view.sourceSessionId)
        if (latest?.id === view.id && latest.phase === 'summarizing') this.followSummary(latest)
      }
    }, 1200)
    this.automaticTimers.set(view.id, timer)
  }

  private install(addressed: string, view: AcpHandoffView): void {
    if (this.stopped) return
    const previous = this.get(addressed)
    if (previous?.id === view.id && previous.revision > view.revision) return
    if (
      previous?.id === view.id &&
      previous.destinationSessionId &&
      !view.destinationSessionId &&
      this.get(previous.destinationSessionId)?.id === view.id
    )
      this.views.delete(previous.destinationSessionId)
    for (const endpoint of [view.sourceSessionId, view.destinationSessionId]) {
      if (endpoint === null) continue
      const existing = this.views.get(endpoint)
      // Looking up an earlier destination cannot replace a newer operation on its source.
      if (addressed === endpoint || existing === undefined || existing.id === view.id) this.views.set(endpoint, view)
    }
    if (view.phase === 'summarizing') this.followSummary(view)
    for (const listener of this.listeners) listener()
    if (
      (view.phase === 'draft' || view.phase === 'queued' || view.phase === 'completed') &&
      view.destinationSessionId !== null
    ) {
      const navigation = this.openOnDestination.get(view.id)
      this.openOnDestination.delete(view.id)
      if (navigation && !navigation.signal.aborted) this.openFromSource(view.sourceSessionId, view.destinationSessionId)
    }
    if (view.phase === 'cancelled' || view.phase === 'interrupted') this.openOnDestination.delete(view.id)
  }

  forget(record: AcpHandoffView | undefined): void {
    if (!record) return
    for (const id of [record.sourceSessionId, record.destinationSessionId]) {
      if (id && this.get(id)?.id === record.id) this.views.delete(id)
    }
    this.openOnDestination.delete(record.id)
    for (const listener of this.listeners) listener()
  }

  reconnect(): void {
    this.connection++
    this.reads.clear()
    for (const [id, navigation] of this.openOnDestination) if (!navigation.automatic) this.openOnDestination.delete(id)
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.stopped = true
    for (const timer of this.automaticTimers.values()) clearTimeout(timer)
    this.automaticTimers.clear()
    this.listeners.clear()
    this.views.clear()
    this.openOnDestination.clear()
  }
}
