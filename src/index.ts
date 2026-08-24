/**
 * @zaimokuza/dsh-acp-adapter host entry, root face（package.json `exports["."]` →
 * lib/index.js，不能变）。 分层起瘦身为组合根 re-export：插件入口面在
 * src/host/composition/，创建/恢复路由的 AcpAgentLoop 类在
 * src/host/factory/agent-loop.ts。
 * @module @zaimokuza/dsh-acp-adapter
 */

export { default } from './host/composition/index.ts'
