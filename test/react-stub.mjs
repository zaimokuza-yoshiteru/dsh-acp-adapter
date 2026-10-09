// Element-tree tests inspect props without mounting React. Hooks stay inert;
// browser E2E owns rendering, effects, and user interactions.
export const createElement = (type, props, ...children) => ({
  $$typeof: Symbol.for('react.element'),
  type,
  props: {
    ...(props ?? {}),
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  },
})
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
export const useEffect = () => {}
export const useLayoutEffect = () => {}
export const useRef = (value) => ({ current: value })
export const useId = () => ':test-id:'
export const useMemo = (factory) => factory()
export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()

// Keep Context as an element-tree value. Tests that walk a Provider restore
// its previous value after visiting the child, matching a scoped render.
export const createContext = (value) => {
  const context = { _currentValue: value }
  context.Provider = { $$typeof: Symbol.for('react.provider'), _context: context }
  return context
}
export const useContext = (context) => context._currentValue

export const useCallback = (callback) => callback
