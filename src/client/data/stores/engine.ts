/**
 * Local structural replica of the slot store engine contracts.
 *
 * The real `defineStore` lives in `@deepseek-ai/dsh-client-runtime/client`
 * (bound to immer inside the host); its lib/client.js is a
 * `window.__ModuleLoader__.load(...)` wrapper that crashes on import under
 * node/vitest, and this layer's zero-external-import discipline
 * (test/contracts/architecture.spec.ts) forbids a value import regardless. So the
 * contract faces below are copied structurally from ui-slots' store.ts
 * (StoreSpec/StoreHandle/StoreInstance/BakedActions) — the same narrowing
 * posture as react.d.ts — and the engine is the smallest honest
 * implementation: fresh state per instance from `spec.init()`, the declared
 * actions as the complete write set, draft = a structuredClone of the live
 * state so actions may mutate freely (immer-style authoring) without ever
 * touching the published reference.
 *
 * Deliberate deviations from the host engine, all documented and harmless at
 * this plugin's scale:
 * - no immer structural sharing: every action call publishes a fresh root
 *   (slice selectors re-render per action; both seats are tiny);
 * - no persist axis: `clearPersisted()` is a no-op and specs never declare
 *   `persist` (the framework prunes scopes; nothing survives unload here);
 * - no flush modes: notification is synchronous, matching the host default.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/engine
 */

/** Typed selector hook over a snapshot source (ui-slots SnapshotSelectorHook; the framework is the only party that ever constructs one). */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/**
 * Action declaration table: pure draft transforms over the store state,
 * declared as the store's complete write set (the audit face — components
 * can only write through these). `any[]` mirrors the upstream declaration:
 * each action carries its own parameter list and unknown[] would reject
 * every concrete signature under strict parameter contravariance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

/** Draft-stripped callback form of an actions table: what glue (`attach`) receives — the engine bakes the draft parameter away per instance. */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
}

/** Store declaration spec: initial-state factory (a lambda so every instance gets fresh state) plus the actions write set. */
export interface StoreSpec<T, A extends ActionsDecl<T>> {
  init(): T
  actions: A
}

/** Live instance consumed by the render machinery and by tests: a bare snapshot source plus the baked write set. */
export interface StoreInstance<T, A extends ActionsDecl<T>> {
  readonly actions: BakedActions<T, A>
  getSnapshot(): T
  /**
   * Subscribe to state changes (uSES subscribe side).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
  /** Drop persisted state (no-op: this engine declares no persist axis). */
  clearPersisted(): void
}

/**
 * Store handle: spec + instance factory in one value. Registrations pass the
 * FACTORY (`store: createXxxStore`) so the framework mints one handle per
 * entry — never export a handle at module level (module-cache identity is a
 * disguised singleton across plugin reloads).
 */
export interface StoreHandle<T, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  /**
   * Create a fresh instance seeded from `spec.init()`.
   * @param scopeKey - accepted for contract parity (session id under session scope); unused — no persist axis exists to key.
   * @returns the live instance.
   */
  create(scopeKey?: string): StoreInstance<T, A>
}

/**
 * Declare a store: initial state plus the full write set as draft mutators.
 * The returned handle is the registration currency of the store seat. Draft
 * semantics: the engine hands each action a structuredClone of the live
 * state, then publishes the clone — actions mutate freely, the published
 * reference is never touched in place, and state values stay plain data
 * (structuredClone rejects functions/symbols, which never belong in a store).
 * @param spec - init lambda + actions table.
 * @returns the store handle.
 */
export function defineSnapshotStore<T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>): StoreHandle<T, A> {
  return {
    spec,
    create(_scopeKey?: string) {
      let state = spec.init()
      const listeners = new Set<() => void>()
      const baked: Record<string, (...params: unknown[]) => void> = {}
      for (const [name, action] of Object.entries(spec.actions)) {
        baked[name] = (...params: unknown[]) => {
          const draft = structuredClone(state)
          ;(action as (draft: T, ...params: unknown[]) => void)(draft, ...params)
          state = draft
          for (const listener of [...listeners]) listener()
        }
      }
      return {
        actions: baked as BakedActions<T, A>,
        getSnapshot: () => state,
        subscribe(fn: () => void) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
        clearPersisted() {},
      }
    },
  }
}
