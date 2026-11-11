export type AcpLocalSettlementStatus = 'saving-results' | 'storage-error'

export class AcpLocalSettlementError extends Error {
  readonly code = 'ACP_LOCAL_SETTLEMENT_FAILED'

  constructor(cause?: unknown) {
    super(
      'ACP results are not saved yet. Local storage will retry automatically, and the next prompt will wait for settlement first; completed tools will not be run again.',
      { cause },
    )
    this.name = 'AcpLocalSettlementError'
  }
}

/** Final shutdown could not save already completed work; retrying tools is unsafe. */
export class AcpLocalSettlementShutdownError extends Error {
  readonly code = 'ACP_LOCAL_SETTLEMENT_SHUTDOWN_FAILED'

  constructor(
    readonly pending: readonly { readonly sessionId: string; readonly profileId: string; readonly key: string }[],
  ) {
    super(
      'ACP shutdown left completed results unsaved. Inspect the session recovery state before continuing; do not rerun completed tools.',
    )
    this.name = 'AcpLocalSettlementShutdownError'
  }
}

interface SettlementTask {
  readonly key: string
  readonly profileId: string
  readonly run: (sink: object) => Promise<void>
}

interface SessionSettlement {
  closed: boolean
  readonly tasks: Map<string, SettlementTask>
  readonly order: string[]
  readonly observers: Set<WeakRef<object>>
  readonly observerSet: WeakSet<object>
  readonly observerCallbacks: WeakMap<object, () => void>
  readonly waiters: Set<() => void>
  status: AcpLocalSettlementStatus | undefined
  running: Promise<void> | undefined
  runningOwner: object | undefined
  runningMode: 'foreground' | 'background' | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
  retryProfileId: string | undefined
  retryAttempts: number
}

interface SettlementOwner {
  readonly token: object
  readonly sink: object
  active: boolean
}

const retryBaseMs = 1_000
const retryMaxMs = 30_000
const foregroundAttempts = 3

function observe(state: SessionSettlement, owner: object, notify: () => void): void {
  state.observerCallbacks.set(owner, notify)
  if (state.observerSet.has(owner)) return
  state.observerSet.add(owner)
  state.observers.add(new WeakRef(owner))
}

function notify(state: SessionSettlement): void {
  for (const reference of state.observers) {
    const owner = reference.deref()
    if (owner === undefined) {
      state.observers.delete(reference)
      continue
    }
    try {
      state.observerCallbacks.get(owner)?.()
    } catch {
      // A presentation subscriber cannot block settlement.
    }
  }
  for (const waiter of [...state.waiters]) {
    try {
      waiter()
    } catch {
      // One cancelled waiter cannot block other observers or settlement.
    }
  }
}

function setStatus(state: SessionSettlement, status: AcpLocalSettlementStatus | undefined): void {
  if (state.status === status) return
  state.status = status
  notify(state)
}

function clearRetry(state: SessionSettlement): void {
  if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
  state.retryTimer = undefined
  state.retryProfileId = undefined
}

function shortRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * 2 ** (attempt - 1)))
}

/** Explicit owner shared by one Host, or directly owned by a standalone adapter. */
export class LocalSettlementOwner {
  private readonly sessions = new Map<string, SessionSettlement>()
  private readonly owners = new Map<string, SettlementOwner>()
  private retiredOwnerTokens = new WeakSet<object>()
  private acceptingOwners = true
  private retriesEnabled = true
  private closed = false
  private closing: Promise<void> | undefined

  private assertOpen(): void {
    if (this.closed) throw new Error('ACP_LOCAL_SETTLEMENT_CLOSED')
  }

  /** Stop fresh sinks and background retries while existing consumers finish their final writes. */
  beginShutdown(): void {
    this.acceptingOwners = false
    this.retriesEnabled = false
    for (const state of this.sessions.values()) clearRetry(state)
  }

  /** Called only after consumer cleanup; admitted writes finish before their queues are released. */
  close(): Promise<void> {
    this.beginShutdown()
    return (this.closing ??= (async () => {
      // Existing sinks remain legal for a bounded final attempt. Consumers
      // normally drain their own profile before releasing its storage owner.
      await Promise.allSettled([...this.owners].map(([profileId, owner]) => this.settleProfile(profileId, owner.token)))
      this.closed = true
      for (;;) {
        const running = [...this.sessions.values()].flatMap((state) =>
          state.running === undefined ? [] : [state.running],
        )
        if (running.length === 0) break
        await Promise.allSettled(running)
      }
      const pending = [...this.sessions].flatMap(([sessionId, state]) =>
        [...state.tasks.values()].map(({ profileId, key }) => ({ sessionId, profileId, key })),
      )
      for (const state of this.sessions.values()) {
        state.closed = true
        clearRetry(state)
        for (const waiter of [...state.waiters]) waiter()
        state.tasks.clear()
        state.order.length = 0
        state.observers.clear()
        state.waiters.clear()
      }
      this.sessions.clear()
      this.owners.clear()
      this.retiredOwnerTokens = new WeakSet()
      if (pending.length > 0) throw new AcpLocalSettlementShutdownError(pending)
    })())
  }

  /** Finish accepted local work before this exact profile sink releases its writer. */
  async settleProfile(profileId: string, ownerToken: object): Promise<void> {
    this.assertOpen()
    const owner = this.ownerFor(profileId)
    // A replacement owns subsequent writes; an old disposer must not borrow
    // or retire the replacement's resources.
    if (owner?.token !== ownerToken) return
    const sessions = [...this.sessions].filter(([, state]) =>
      state.order.some((key) => state.tasks.get(key)?.profileId === profileId),
    )
    await Promise.allSettled(sessions.map(([sessionId]) => this.settlePending(sessionId, owner.sink, profileId)))
    const pending = sessions.flatMap(([sessionId, state]) =>
      [...state.tasks.values()]
        .filter((task) => task.profileId === profileId)
        .map(({ profileId: taskProfileId, key }) => ({ sessionId, profileId: taskProfileId, key })),
    )
    if (pending.length > 0) throw new AcpLocalSettlementShutdownError(pending)
  }

  private sessionState(sessionId: string, create: boolean): SessionSettlement | undefined {
    let state = this.sessions.get(sessionId)
    if (state === undefined && create) {
      state = {
        closed: false,
        tasks: new Map(),
        order: [],
        observers: new Set(),
        observerSet: new WeakSet(),
        observerCallbacks: new WeakMap(),
        waiters: new Set(),
        status: undefined,
        running: undefined,
        runningOwner: undefined,
        runningMode: undefined,
        retryTimer: undefined,
        retryProfileId: undefined,
        retryAttempts: 0,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private ownerFor(profileId: string): SettlementOwner | undefined {
    const owner = this.owners.get(profileId)
    return owner?.active === true ? owner : undefined
  }

  private scheduleRetry(sessionId: string, state: SessionSettlement, profileId: string): void {
    if (!this.retriesEnabled || state.retryTimer !== undefined || this.ownerFor(profileId) === undefined) return
    state.retryProfileId = profileId
    const delay = Math.min(retryBaseMs * 2 ** Math.max(0, state.retryAttempts - 1), retryMaxMs)
    const timer = setTimeout(() => {
      if (state.retryTimer !== timer) return
      state.retryTimer = undefined
      state.retryProfileId = undefined
      const owner = this.ownerFor(profileId)
      if (owner === undefined) return
      void this.drain(state, sessionId, profileId, owner.sink, owner.token, 'background')
        .catch(() => undefined)
        .finally(() => this.cleanupEmptySession(sessionId, state))
    }, delay)
    timer.unref?.()
    state.retryTimer = timer
  }

  private async drain(
    state: SessionSettlement,
    sessionId: string,
    profileId: string,
    fallbackSink?: object,
    fallbackOwner?: object,
    mode: 'foreground' | 'background' = 'foreground',
  ): Promise<void> {
    if (state.running !== undefined) {
      const joinedRun = state.running
      const joinedMode = state.runningMode
      try {
        await joinedRun
      } catch (error) {
        if (mode !== 'foreground' || joinedMode !== 'background') throw error
        return await this.drain(state, sessionId, profileId, fallbackSink, fallbackOwner, 'foreground')
      }
      if (state.order.length > 0) {
        if (mode === 'foreground' && joinedMode === 'background')
          return await this.drain(state, sessionId, profileId, fallbackSink, fallbackOwner, 'foreground')
        throw new AcpLocalSettlementError()
      }
      return
    }
    const firstTask = state.tasks.get(state.order[0] ?? '')
    const scheduledOwner = firstTask === undefined ? undefined : this.ownerFor(firstTask.profileId)
    state.runningOwner = scheduledOwner?.token ?? fallbackOwner
    state.runningMode = mode
    const running = Promise.resolve().then(async () => {
      while (state.order.length > 0) {
        const key = state.order[0]!
        const task = state.tasks.get(key)
        if (task === undefined) {
          state.order.shift()
          continue
        }
        if (task.profileId !== profileId) return
        const currentOwner = this.ownerFor(task.profileId)
        const hasRegisteredOwner = this.owners.has(task.profileId)
        const fallbackIsLive = fallbackOwner !== undefined && !this.retiredOwnerTokens.has(fallbackOwner)
        const sink = currentOwner?.sink ?? (!hasRegisteredOwner && fallbackIsLive ? fallbackSink : undefined)
        const owner = currentOwner?.token ?? (!hasRegisteredOwner && fallbackIsLive ? fallbackOwner : undefined)
        if (sink === undefined || owner === undefined) return
        state.runningOwner = owner
        clearRetry(state)
        if (mode === 'foreground') setStatus(state, 'saving-results')
        let succeeded = false
        let failure: unknown
        const maxAttempts = mode === 'foreground' ? foregroundAttempts : 1
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await task.run(sink)
            succeeded = true
            break
          } catch (error) {
            failure = error
            if (attempt < maxAttempts) await shortRetryDelay(attempt)
          }
        }
        if (!succeeded) {
          state.retryAttempts += 1
          setStatus(state, 'storage-error')
          this.scheduleRetry(sessionId, state, task.profileId)
          state.runningOwner = undefined
          throw new AcpLocalSettlementError(failure)
        }
        state.runningOwner = undefined
        state.order.shift()
        state.tasks.delete(key)
        state.retryAttempts = 0
        clearRetry(state)
        setStatus(state, state.order.length === 0 ? undefined : 'saving-results')
      }
    })
    state.running = running
    try {
      await running
    } finally {
      if (state.running === running) {
        state.running = undefined
        state.runningOwner = undefined
        state.runningMode = undefined
      }
    }
  }

  /** Register the current profile sink. Replaced owners cannot unregister a newer adapter. */
  registerSink(profileId: string, ownerToken: object, sink: object): () => Promise<void> {
    if (!this.acceptingOwners) throw new Error('ACP_LOCAL_SETTLEMENT_CLOSED')
    const owners = this.owners
    const owner: SettlementOwner = { token: ownerToken, sink, active: true }
    const replaced = owners.get(profileId)
    if (replaced !== undefined) replaced.active = false
    owners.set(profileId, owner)

    for (const [sessionId, state] of this.sessions) {
      if (state.order.some((key) => state.tasks.get(key)?.profileId === profileId)) {
        clearRetry(state)
        if (state.running === undefined)
          void this.drain(state, sessionId, profileId, sink, ownerToken, 'background')
            .catch(() => undefined)
            .finally(() => this.cleanupEmptySession(sessionId, state))
      }
    }

    return async () => {
      owner.active = false
      this.retiredOwnerTokens.add(ownerToken)
      const current = this.owners.get(profileId)
      if (current === owner) {
        for (const state of this.sessions.values()) {
          if (state.retryProfileId === profileId) clearRetry(state)
        }
      }
      const pending = [...this.sessions.values()]
        .filter((state) => state.running !== undefined && state.runningOwner === ownerToken)
        .map((state) => state.running)
      await Promise.allSettled(pending)
      if (this.owners.get(profileId) === owner) this.owners.delete(profileId)
    }
  }

  /** Run a known-terminal response's local writes once, retaining failed work by Host/session. */
  async settle<TSink extends object>(
    sessionId: string,
    key: string,
    task: (sink: TSink) => Promise<void>,
    observerOwner: object,
    onStatusChange: () => void,
    sink: TSink,
    profileId = 'default',
  ): Promise<void> {
    this.assertOpen()
    const state = this.sessionState(sessionId, true)!
    observe(state, observerOwner, onStatusChange)
    if (!state.tasks.has(key)) {
      state.tasks.set(key, { key, profileId, run: (candidate) => task(candidate as TSink) })
      state.order.push(key)
    }
    setStatus(state, 'saving-results')
    try {
      await this.drain(state, sessionId, profileId, sink, observerOwner)
      if (state.order.length > 0) throw new AcpLocalSettlementError()
    } finally {
      this.cleanupEmptySession(sessionId, state)
    }
  }

  /** Retry this DSH session's retained local writes before its next remote prompt. */
  async settlePending<TSink extends object>(sessionId: string, sink: TSink, profileId = 'default'): Promise<void> {
    this.assertOpen()
    const state = this.sessionState(sessionId, false)
    if (state === undefined || state.order.length === 0) return
    try {
      await this.drain(state, sessionId, profileId, sink, this.ownerFor(profileId)?.token ?? sink)
      if (state.order.length > 0) throw new AcpLocalSettlementError()
    } finally {
      this.cleanupEmptySession(sessionId, state)
    }
  }

  /** Wait for an existing settlement to finish without starting or cancelling a batch. */
  wait(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ACP_LOCAL_SETTLEMENT_CLOSED'))
    const state = this.sessionState(sessionId, false)
    if (state === undefined || state.order.length === 0) return Promise.resolve()
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        state.waiters.delete(checkComplete)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onAbort = (): void => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      const checkComplete = (): void => {
        if (state.closed) finish(new Error('ACP_LOCAL_SETTLEMENT_CLOSED'))
        else if (state.order.length === 0) finish()
      }
      state.waiters.add(checkComplete)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Recheck after subscribing so completion cannot be lost between read and wait.
      checkComplete()
    })
  }

  private cleanupEmptySession(sessionId: string, state: SessionSettlement): void {
    if (state.order.length !== 0 || state.tasks.size !== 0 || state.running !== undefined) return
    clearRetry(state)
    if (this.sessions.get(sessionId) !== state) return
    this.sessions.delete(sessionId)
  }

  status(sessionId: string): AcpLocalSettlementStatus | undefined {
    const state = this.sessionState(sessionId, false)
    if (state === undefined || state.order.length === 0) return undefined
    return state.status ?? 'storage-error'
  }

  /** Let another provider adapter for the same Host/session refresh its status view. */
  observe(sessionId: string, owner: object, onStatusChange: () => void): void {
    const state = this.sessionState(sessionId, false)
    if (state !== undefined && state.order.length > 0) observe(state, owner, onStatusChange)
  }
}
