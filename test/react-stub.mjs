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
export const useRef = (value) => ({ current: value })
export const useMemo = (factory) => factory()
