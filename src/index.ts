/**
 * @zaimokuza/dsh-acp-adapter host entry, root face（package.json `exports["."]` →
 * lib/index.js，不能变）。 分层起瘦身为组合根 re-export：插件入口面在
 * src/host/composition/，ACP 路由由 per-profile provider composition 注册，
 * 不替换 DSH 原生 AgentLoop、ModelPicker 或 Chat。
 * @module @zaimokuza/dsh-acp-adapter
 */

export { name, inject, apply } from './host/composition/index.ts'
export * from './host/composition/index.ts'
