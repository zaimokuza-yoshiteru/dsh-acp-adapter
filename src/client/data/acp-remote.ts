/**
 * dshAcp Remote 的 client 侧窄化面：取代 的手写 fetch 管线
 * （`ACP_HEALTH_PATH` / `acpSessionOptionsPath`）。
 *
 * clientEntry（../index.ts）把生成物 contribution（lib/typert.remote-client.js）
 * `$mount` 到 `ctx.get('remote')` 后，namespace 以 cordis 服务键
 * `remote.dshAcp` 注册在独立 fiber 上（gateway 的 RemoteNamespaceService），
 * 消费侧在 mount 就位后经 `ctx.get('remote.dshAcp')` 取实例；本面是
 * additive client activity/settings 消费的最小结构
 * ——错误只取 `error.message`（host 侧 throw 折叠为
 * `{code:'internal', message}` 的 RemoteResult 错误分支；kind/HTTP status
 * 不再过线，与 HTTP 时代 parseHttpErrorMessage 同款口径）。
 *
 * wire payload 类型直接复用 src/contract/remote.ts 的收窄 contract（host 侧
 * strict zod codec 已校验过线数据；本层仍喂防御性 decode 函数，双重保险）。
 * @module @zaimokuza/dsh-acp-adapter/client/acp-remote
 */

import type {
  AcpBackendState,
  AcpBoundSessionsView,
  AcpHealthRequest,
  AcpHealthView,
  AcpAuditTimelinePage,
  AcpActivitySnapshotView,
  AcpActivityPageView,
  AcpActivityJournalFrame,
  AcpAgentSessionSnapshotView,
  AcpAgentSessionOptionWrite,
  AcpOwnedRoutesView,
  AcpProjectedSubagentsView,
} from '../../contract/remote.ts'
import type { AcpRecoveryView } from '../../contract/remote.ts'

export type {
  AcpActivityView,
  AcpAuditSummaryCode,
  AcpAuditTimelineEntry,
  AcpRecoveryView,
  AcpAgentSessionSnapshotView,
  AcpAgentSessionOptionWrite,
} from '../../contract/remote.ts'

/** Minimal `RemoteResult` face the glue consumes (message-only errors). */
export type AcpRemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/**
 * The Alpha Gateway stream seam consumed by the activity hub. Kept as a
 * local client-data contract so the journal does not import generated remote
 * types directly; the generated `ctx.remote` is structurally compatible.
 */
export interface AcpActivityStreamFactory {
  $stream<Item>(options: {
    readonly name: string
    readonly open: (signal: AbortSignal) => AsyncIterable<Item>
    readonly ended: (accepted: boolean) => Error
  }): {
    [Symbol.asyncIterator](): AsyncIterator<{ readonly value: Item; readonly accept: () => void }>
    readonly dispose: () => Promise<void>
  }
}

/** Narrowed face of the mounted `dshAcp` remote namespace. */
export interface AcpRemoteLike {
  /**
   * 健康视图。省略 request = 只读缓存视图（面板打开不 spawn probe）；
 * `{recheck: true}` = 重探全部 provider；`{recheck: true, agentId}` = 只重探
   * 指定 provider。
   */
  health(request?: AcpHealthRequest): Promise<AcpRemoteResultLike<AcpHealthView>>
  ownedProviderRoutes?(): Promise<AcpRemoteResultLike<AcpOwnedRoutesView>>
  projectedSubagentIds?(): Promise<AcpRemoteResultLike<AcpProjectedSubagentsView>>
 /** host 权威的会话 backend 查询（picker 跨 backend 标记/分流的数据面）。 */
  backendOf(sessionId: string): Promise<AcpRemoteResultLike<AcpBackendState>>
  recoverySnapshot?(sessionId: string): Promise<AcpRemoteResultLike<AcpRecoveryView>>
  retryOriginal?(sessionId: string): Promise<AcpRemoteResultLike<AcpRecoveryView>>
  rebindRecoveryBlank?(sessionId: string): Promise<AcpRemoteResultLike<AcpRecoveryView>>
  agentSessionSnapshot?(sessionId: string): Promise<AcpRemoteResultLike<AcpAgentSessionSnapshotView>>
  setAgentSessionOption?(sessionId: string, request: AcpAgentSessionOptionWrite): Promise<AcpRemoteResultLike<AcpAgentSessionSnapshotView>>
  auditTimeline?(sessionId: string, request?: { readonly afterSeq?: number; readonly limit?: number }): Promise<AcpRemoteResultLike<AcpAuditTimelinePage>>
  activitySnapshot?(sessionId: string, request?: { readonly limit?: number }): Promise<AcpRemoteResultLike<AcpActivitySnapshotView>>
  activityPage?(sessionId: string, request?: { readonly afterRevision?: number; readonly limit?: number }): Promise<AcpRemoteResultLike<AcpActivityPageView>>
  activityFollow(sessionId: string, request?: { readonly limit?: number }, signal?: AbortSignal): AsyncIterable<AcpActivityJournalFrame>
 /** 删除确认提示的 binding 计数（该 profile 被多少个既有会话引用；纯读）。 */
  boundSessions(agentId: string): Promise<AcpRemoteResultLike<AcpBoundSessionsView>>
}
