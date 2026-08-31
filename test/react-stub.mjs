// Test-only stub of the platform module 'react'（注册测试用）。宿主 loader
// 的模块表在运行时应答 react；本包按 依赖纪律不安装它。组件渲染从不被
// 测试消费——stub 只需让值级 import 可解析（client-registration.spec.ts 经
// apply → AcpSection/ModelPicker 模块加载路径）。行为断言全部落在 data/glue 层。

// Keep enough of React's element shape for UI contract tests to inspect the
// rendered DOM tree. Hooks remain inert because these tests do not mount a
// browser renderer.
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
