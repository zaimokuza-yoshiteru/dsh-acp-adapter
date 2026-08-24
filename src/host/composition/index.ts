/**
 * 插件组合根（分层）：Cordis Loader 挂载的默认导出面。cordis.patch.yml
 * 生效后，patch 禁用原生 `agent-loop` 行并把本包插在新 id 下，Loader 以行配
 * 置挂载本默认导出。服务注册（ACP registry / sidecar / dshAcp Remote service）全部
 * 发生在 `AcpAgentLoop` 构造器内——类实现见 ../factory/agent-loop.ts，本模块
 * 只做组合出口，不新增行为。
 * @module @zaimokuza/dsh-acp-adapter/host/composition
 */

export { default } from '../factory/agent-loop.ts'
