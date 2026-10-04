import type { Context } from '@deepseek-ai/cordis'

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

interface SettlementTask {
  readonly key: string
  readonly profileId: string
  readonly run: (sink: object) => Promise<void>
}

interface SessionSettlement {
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

type RootSettlementMap = Map<string, SessionSettlement>
type SettlementRegistry = WeakMap<object, RootSettlementMap>
type OwnerRegistry = WeakMap<object, Map<string, SettlementOwner>>

const registryKey = Symbol.for('dsh-acp-adapter.local-settlement.v2')
const ownerRegistryKey = Symbol.for('dsh-acp-adapter.local-settlement-owners.v2')
const retiredOwnerTokens = new WeakSet<object>()
const retryBaseMs = 1_000
const retryMaxMs = 30_000
const foregroundAttempts = 3

function registry(): SettlementRegistry {
  const host = globalThis as typeof globalThis & { [registryKey]?: SettlementRegistry }
  return (host[registryKey] ??= new WeakMap())
}

function ownerRegistry(): OwnerRegistry {
  const host = globalThis as typeof globalThis & { [ownerRegistryKey]?: OwnerRegistry }
  return (host[ownerRegistryKey] ??= new WeakMap())
}

function canonicalRoot(root: object): object {
  const context = root as Partial<Context>
  return context.root ?? root
}

function sessionState(root: object, sessionId: string, create: boolean): SessionSettlement | undefined {
  const key = canonicalRoot(root)
  let sessions = registry().get(key)
  if (sessions === undefined && create) registry().set(key, (sessions = new Map()))
  let state = sessions?.get(sessionId)
  if (state === undefined && create) {
    state = {
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
    sessions!.set(sessionId, state)
  }
  return state
}

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

function ownerFor(root: object, profileId: string): SettlementOwner | undefined {
  const owner = ownerRegistry().get(canonicalRoot(root))?.get(profileId)
  return owner?.active === true ? owner : undefined
}

function clearRetry(state: SessionSettlement): void {
  if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
  state.retryTimer = undefined
  state.retryProfileId = undefined
}

function shortRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * 2 ** (attempt - 1)))
}

function scheduleRetry(root: object, sessionId: string, state: SessionSettlement, profileId: string): void {
  if (state.retryTimer !== undefined || ownerFor(root, profileId) === undefined) return
  state.retryProfileId = profileId
  const delay = Math.min(retryBaseMs * 2 ** Math.max(0, state.retryAttempts - 1), retryMaxMs)
  const timer = setTimeout(() => {
    if (state.retryTimer !== timer) return
    state.retryTimer = undefined
    state.retryProfileId = undefined
    const owner = ownerFor(root, profileId)
    if (owner === undefined) return
    void drain(state, root, sessionId, profileId, owner.sink, owner.token, 'background')
      .catch(() => undefined)
      .finally(() => cleanupEmptySession(root, sessionId, state))
  }, delay)
  timer.unref?.()
  state.retryTimer = timer
}

async function drain(
  state: SessionSettlement,
  root: object,
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
      return await drain(state, root, sessionId, profileId, fallbackSink, fallbackOwner, 'foreground')
    }
    if (state.order.length > 0) {
      if (mode === 'foreground' && joinedMode === 'background')
        return await drain(state, root, sessionId, profileId, fallbackSink, fallbackOwner, 'foreground')
      throw new AcpLocalSettlementError()
    }
    return
  }
  const firstTask = state.tasks.get(state.order[0] ?? '')
  const scheduledOwner = firstTask === undefined ? undefined : ownerFor(root, firstTask.profileId)
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
      const currentOwner = ownerFor(root, task.profileId)
      const hasRegisteredOwner = ownerRegistry().get(canonicalRoot(root))?.has(task.profileId) === true
      const fallbackIsLive = fallbackOwner !== undefined && !retiredOwnerTokens.has(fallbackOwner)
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
        scheduleRetry(root, sessionId, state, task.profileId)
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
export function registerLocalSettlementSink(
  root: object,
  profileId: string,
  ownerToken: object,
  sink: object,
): () => Promise<void> {
  const keyRoot = canonicalRoot(root)
  let owners = ownerRegistry().get(keyRoot)
  if (owners === undefined) ownerRegistry().set(keyRoot, (owners = new Map()))
  const owner: SettlementOwner = { token: ownerToken, sink, active: true }
  const replaced = owners.get(profileId)
  if (replaced !== undefined) replaced.active = false
  owners.set(profileId, owner)

  for (const [sessionId, state] of registry().get(keyRoot) ?? []) {
    if (state.order.some((key) => state.tasks.get(key)?.profileId === profileId)) {
      clearRetry(state)
      if (state.running === undefined)
        void drain(state, keyRoot, sessionId, profileId, sink, ownerToken, 'background')
          .catch(() => undefined)
          .finally(() => cleanupEmptySession(keyRoot, sessionId, state))
    }
  }

  return async () => {
    owner.active = false
    retiredOwnerTokens.add(ownerToken)
    const current = ownerRegistry().get(keyRoot)?.get(profileId)
    if (current === owner) {
      for (const state of registry().get(keyRoot)?.values() ?? []) {
        if (state.retryProfileId === profileId) clearRetry(state)
      }
    }
    const pending = [...(registry().get(keyRoot)?.values() ?? [])]
      .filter((state) => state.running !== undefined && state.runningOwner === ownerToken)
      .map((state) => state.running)
    await Promise.allSettled(pending)
    if (ownerRegistry().get(keyRoot)?.get(profileId) === owner) ownerRegistry().get(keyRoot)?.delete(profileId)
  }
}

/** Run a known-terminal response's local writes once, retaining failed work by Host/session. */
export async function settleLocally<TSink extends object>(
  root: object,
  sessionId: string,
  key: string,
  task: (sink: TSink) => Promise<void>,
  observerOwner: object,
  onStatusChange: () => void,
  sink: TSink,
  profileId = 'default',
): Promise<void> {
  const keyRoot = canonicalRoot(root)
  const state = sessionState(keyRoot, sessionId, true)!
  observe(state, observerOwner, onStatusChange)
  if (!state.tasks.has(key)) {
    state.tasks.set(key, { key, profileId, run: (candidate) => task(candidate as TSink) })
    state.order.push(key)
  }
  setStatus(state, 'saving-results')
  try {
    await drain(state, keyRoot, sessionId, profileId, sink, observerOwner)
    if (state.order.length > 0) throw new AcpLocalSettlementError()
  } finally {
    cleanupEmptySession(keyRoot, sessionId, state)
  }
}

/** Retry this DSH session's retained local writes before its next remote prompt. */
export async function settlePendingLocally<TSink extends object>(
  root: object,
  sessionId: string,
  sink: TSink,
  profileId = 'default',
): Promise<void> {
  const keyRoot = canonicalRoot(root)
  const state = sessionState(keyRoot, sessionId, false)
  if (state === undefined || state.order.length === 0) return
  try {
    await drain(state, keyRoot, sessionId, profileId, sink, ownerFor(keyRoot, profileId)?.token ?? sink)
    if (state.order.length > 0) throw new AcpLocalSettlementError()
  } finally {
    cleanupEmptySession(keyRoot, sessionId, state)
  }
}

/** Wait for an existing settlement to finish without starting or cancelling a batch. */
export function waitForLocalSettlement(root: object, sessionId: string, signal?: AbortSignal): Promise<void> {
  const state = sessionState(root, sessionId, false)
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
      if (state.order.length === 0) finish()
    }
    state.waiters.add(checkComplete)
    signal?.addEventListener('abort', onAbort, { once: true })
    // Recheck after subscribing so completion cannot be lost between read and wait.
    checkComplete()
  })
}

function cleanupEmptySession(root: object, sessionId: string, state: SessionSettlement): void {
  if (state.order.length !== 0 || state.tasks.size !== 0 || state.running !== undefined) return
  clearRetry(state)
  const sessions = registry().get(root)
  if (sessions?.get(sessionId) !== state) return
  sessions.delete(sessionId)
}

export function localSettlementStatus(root: object, sessionId: string): AcpLocalSettlementStatus | undefined {
  const state = sessionState(root, sessionId, false)
  if (state === undefined || state.order.length === 0) return undefined
  return state.status ?? 'storage-error'
}

/** Let another provider adapter for the same Host/session refresh its status view. */
export function observeLocalSettlement(
  root: object,
  sessionId: string,
  owner: object,
  onStatusChange: () => void,
): void {
  const state = sessionState(root, sessionId, false)
  if (state !== undefined && state.order.length > 0) observe(state, owner, onStatusChange)
}
