/**
 * dshAcp Remote 的 client 侧窄化面：取代 的手写 fetch 管线
 * （`ACP_HEALTH_PATH` / `acpSessionOptionsPath`）。
 *
 * clientEntry（../index.ts）把生成物 contribution（lib/typert.remote-client.js）
 * `$mount` 到 `ctx.get('remote')` 后，namespace 以 cordis 服务键
 * `remote.dshAcp` 注册在独立 fiber 上（gateway 的 RemoteNamespaceService），
 * 消费侧在 mount 就位后经 `ctx.get('remote.dshAcp')` 取实例；本面是
 * controller/live-controller 消费的最小结构
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
  AcpLiveOptionsSnapshot,
  AcpModelSwitchBeginRequest,
  AcpModelSwitchBeginResult,
  AcpModelSwitchResolveRequest,
  AcpOptionWrite,
  AcpPendingPermissionView,
  AcpPermissionAnswerRequest,
  AcpElicitationAnswerRequest,
  AcpPendingElicitationView,
} from '../../contract/remote.ts'

export type { AcpElicitationAnswerRequest, AcpPendingPermissionView, AcpPendingElicitationView } from '../../contract/remote.ts'

/** Minimal `RemoteResult` face the glue consumes (message-only errors). */
export type AcpRemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** Narrowed face of the mounted `dshAcp` remote namespace. */
export interface AcpRemoteLike {
  /**
   * 健康视图。省略 request = 只读缓存视图（面板打开不 spawn probe）；
 * `{recheck: true}` = 重探全部 provider；`{recheck: true, agentId}` = 只重探
   * 指定 provider。
   */
  health(request?: AcpHealthRequest): Promise<AcpRemoteResultLike<AcpHealthView>>
  options(sessionId: string): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
  setOption(
    sessionId: string,
    request: AcpOptionWrite,
  ): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
 /** host 权威的会话 backend 查询（picker 跨 backend 标记/分流的数据面）。 */
  backendOf(sessionId: string): Promise<AcpRemoteResultLike<AcpBackendState>>
 /** 收尾：rebindBlank 逃生门（reconciliation-required 的可执行出路），返回复位后的选项快照。 */
  rebindBlank(sessionId: string): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
  reconnectOriginal?(sessionId: string): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
  recordRecoveryAction?(sessionId: string, action: 'retry-original' | 'rebind-blank' | 'new-session'): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
  pendingPermissions?(sessionId: string): Promise<AcpRemoteResultLike<readonly AcpPendingPermissionView[]>>
  answerPermission?(sessionId: string, request: AcpPermissionAnswerRequest): Promise<AcpRemoteResultLike<null>>
  cancelPermission?(sessionId: string, request: Pick<AcpPermissionAnswerRequest, 'requestId'>): Promise<AcpRemoteResultLike<null>>
  pendingElicitations?(sessionId: string): Promise<AcpRemoteResultLike<readonly AcpPendingElicitationView[]>>
  answerElicitation?(sessionId: string, request: AcpElicitationAnswerRequest): Promise<AcpRemoteResultLike<null>>
  cancelElicitation?(sessionId: string, request: Pick<AcpElicitationAnswerRequest, 'requestId'>): Promise<AcpRemoteResultLike<null>>
 /** 删除确认提示的 binding 计数（该 profile 被多少个既有会话引用；纯读）。 */
  boundSessions(agentId: string): Promise<AcpRemoteResultLike<AcpBoundSessionsView>>
  /**
 * 模型热切换的持久事务（同 profile 内切换的唯一写入口）。流程见
   * src/remote/service.ts；`actualModel` 是 Agent 响应权威快照的实际模型值
   * （DSH 侧 selectModel 必须用本值，不得用请求值）。
   */
  beginModelSwitch(
    sessionId: string,
    request: AcpModelSwitchBeginRequest,
  ): Promise<AcpRemoteResultLike<AcpModelSwitchBeginResult>>
 /** DSH 侧接受 actualModel 后的收束步（幂等；写 committed 后清行）。 */
  commitModelSwitch(
    sessionId: string,
    request: AcpModelSwitchResolveRequest,
  ): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
 /** Agent 侧写回 previousModel 并落 agent-rolled-back；DSH 收敛后另行 commit 清行。 */
  rollbackModelSwitch(
    sessionId: string,
    request: AcpModelSwitchResolveRequest,
  ): Promise<AcpRemoteResultLike<AcpLiveOptionsSnapshot>>
}
