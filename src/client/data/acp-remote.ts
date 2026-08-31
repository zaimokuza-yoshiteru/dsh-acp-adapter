/**
 * dshAcp Remote 的 client 侧窄化面：取代 的手写 fetch 管线
 * （`ACP_HEALTH_PATH` / `acpSessionOptionsPath`）。
 *
 * clientEntry（../index.ts）把生成物 contribution（lib/typert.remote-client.js）
 * `$mount` 到 `ctx.get('remote')` 后，namespace 以 cordis 服务键
 * `remote.dshAcp` 注册在独立 fiber 上（gateway 的 RemoteNamespaceService），
 * 消费侧在 mount 就位后直接使用生成的 `ctx.remote.dshAcp` namespace。
 * 本文件只保留公共 payload re-export；方法签名和 `RemoteResult`/`RemoteError`
 * 由 alpha.2 Typert 生成物负责，避免宿主协议升级后手写面漂移。
 *
 * wire payload 类型直接复用 src/contract/remote.ts 的收窄 contract（host 侧
 * strict zod codec 已校验过线数据；本层仍喂防御性 decode 函数，双重保险）。
 * @module @zaimokuza/dsh-acp-adapter/client/acp-remote
 */

import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'

export type {
  AcpActivityView,
  AcpAuditSummaryCode,
  AcpAuditTimelineEntry,
  AcpRecoveryView,
  AcpAgentSessionSnapshotView,
  AcpAgentSessionOptionWrite,
} from '../../contract/remote.ts'

/** Generated alpha.2 namespace mounted from `lib/typert.remote-client.js`. */
export type AcpRemoteLike = TypertRemoteNamespace<'dshAcp'>
