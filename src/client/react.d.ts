/**
 * Ambient face of `react` for the client bundle ( dependency decision).
 *
 * `react` is a dsh platform module: the shell seeds it into the frozen loader
 * module table, so the bundled factory's `require('react')` resolves at
 * runtime without this package declaring a dependency (the same posture
 * `@deepseek-ai/cordis` already has). Adding react/@types/react to
 * package.json is forbidden by the release contract's dependency rule, and the
 * frozen tsconfig has no `jsx` option — so components are written with
 * `createElement` against this structural minimum, exactly how the host half
 * narrows dsh service faces it cannot import.
 *
 * Only the members this package uses are declared: `createElement`,
 * `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, and the `ReactNode` return
 * currency. The intrinsic-
 * element props bag is deliberately loose (`Record<string, unknown>`) — DOM
 * attribute checking is the part of @types/react we do not reproduce; props
 * of our own function components ARE fully checked through the first overload.
 */
declare module 'react' {
  /** The value a component may return; arrays cover mapped children. */
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly ReactNode[]

  /** Opaque element handle; components only ever return these, never inspect them. */
  export interface ReactElement {
    readonly $$typeof: unknown
  }

  /** Registration-position component shape: the bare call signature. */
  export type FunctionComponent<P> = (props: P) => ReactNode

  /** Create one element from one of our own components; props are checked against P (key rides along, React-style). */
  export function createElement<P extends object>(
    type: FunctionComponent<P>,
    props?: (P & { key?: string | number }) | null,
    ...children: ReactNode[]
  ): ReactElement
  /** Create one intrinsic (DOM) element; the attribute bag is unchecked by design (see module doc). */
  export function createElement(
    type: string,
    props?: Record<string, unknown> | null,
    ...children: ReactNode[]
  ): ReactElement

  /** Local component state (the sanctioned component-internal behavioral hook). */
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]

  /** Mount/update side effects; the panel's one-shot health load rides this. */
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void

 /** Mutable instance cell (: focus refs, last-action latches, per-instance ids). */
  export function useRef<T>(initial: T): { current: T }

 /** Memoized derivation (: filtered catalog/effort rows). */
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T

  /** Stable callback identity for effects and injected UI actions. */
  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T

  /** Subscribe to an external snapshot store without duplicating UI state. */
  export function useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T

  /**
   * The JSX namespace: ui-primitives' icon components declare their return as
 * react's `JSX.Element` — mapping it onto our ReactElement keeps
   * those declarations meaningful instead of degrading to any. (Worded to
   * keep the architecture guard's import-specifier regexes from seeing a
   * dynamic-import literal in this comment.)
   */
  export namespace JSX {
    export type Element = ReactElement
  }
}
