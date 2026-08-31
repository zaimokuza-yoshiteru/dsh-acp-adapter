/**
 * dshAcp Remote service。
 *
 * 登录遵循 external-login-only：用户只在 Agent 自带 CLI 中登录，面板仅展示
 * 探针状态和 loginHint。ACP 会话的控制面只通过 host-owned recovery/session-control 方法暴露；模型选择、
 * 权限和 elicitation 仍由 DSH 原生面或 host handler 处理。公开方法为 health、
 * backendOf、boundSessions、audit/activity timeline、recovery 和 agent session controls。
 * 所有调用都走宿主 typed Remote，不保留手写 HTTP 写旁路。
 *
 * 边界形态：
 * - `AcpRemoteService extends TypertRemoteService`（`super(ctx, 'dshAcp')`），方法
 *   以 `@Remote` 标注；strict descriptor/zod codec 由构建期
 *   `scripts/gen-typert.mjs` 生成（lib/typert.host.{js,d.ts} +
 *   lib/typert.remote-client.{js,d.ts}），host 侧经 typert-loader 自动注册进
 *   `ctx.typert`，client 侧 `ctx.remote.$mount(contribution)` 挂载。
 * - wire 类型全部来自 src/contract/remote.ts 的收窄 contract（SDK v1 类型的
 *   `_meta: Record<string, unknown>` 过不了 strict boundary，且 client 本就只
 *   消费收窄字段）；SDK → contract 的显式映射在本文件（数据最小化：auth 的
 *   vars/env 键名、config option 的 `_meta` 不过线）。
 * - 活体解析用 JSON `sessionId: string` 参数 + 方法体内 `resolveLiveAgent`：
 *   标准 agent lookup 的 wire 类型外部不可命名。写路径仍只服务
 * 活体会话的 backend/recovery 事实按需读取；不会把旧 Agent 控制面重新暴露到 Remote。
 * - 错误纪律：业务失败一律 throw（message 即用户可见文案，与 HTTP 时代逐字
 *   一致）；gateway 把 throw 折叠成 `{code:'internal', message}` 的
 *   RemoteResult 错误分支（kind/HTTP status 不再过线，client 从来只消费
 *   message——parseHttpErrorMessage 同款口径）。
 *
 * Subprocess seam（不变）：两个缺省实现（可执行预检 / `<command> --version`）
 * 全经宿主公共 seam `ctx.subprocess` 的解析产物（deps.subprocess 注入）——
 * 本模块不触碰 `node:child_process`。seam 缺席时缺省实现 fail closed：
 * executable=false、version=null。
 *
 * 本包 tsconfig 用 `types: []`（不含 node 全局类型）；本文件是 host 侧
 * 子进程模块，经下方 triple-slash reference 显式引入 @types/node
 * （src/protocol/v1/connection.ts 同款先例），不改动共享 tsconfig。
 * @module @zaimokuza/dsh-acp-adapter/remote/service
 */

/// <reference types="node" />

import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type * as acp from '@agentclientprotocol/sdk'
import { acpRouteId, ACP_AGENT_ID_PATTERN } from '../domain/session/agent-config.ts'
import { acpProbeConfigKey, acpProbeFresh, acpVersionCompatibility, descriptorOf } from '../domain/session/agent-config.ts'
import type { AcpAgentConfig, AcpAgentRuntimeDescriptor } from '../domain/session/agent-config.ts'
import { deriveAcpAgentState } from '../domain/session/agent-state.ts'
import type { AcpAgentStateProbeView } from '../domain/session/agent-state.ts'
import { acpCapabilityMatrix } from '../domain/policy/capability-matrix.ts'
import type { AcpSessionContinuityState } from '../runtime/session/continuity.ts'
import { ACP_SUBPROCESS_UNAVAILABLE_MESSAGE } from '../runtime/process/subprocess.ts'
import { abortAfter } from '../runtime/process/timeout.ts'
import type { AcpSubprocessHandle, SubprocessSeam, SubprocessSeamResolution } from '../runtime/process/subprocess.ts'
import { AcpClientError } from '../protocol/v1/errors.ts'
import type {
  AcpAuthMethod,
  AcpBackendState,
  AcpBoundSessionsView,
  AcpCapabilityFacts,
  AcpRecoveryView,
  AcpHealthView,
  AcpHealthRequest,
  AcpLiveSessionContinuity,
  AcpProbeCleanupView,
  AcpProviderHealth,
  AcpAuditTimelinePage,
  AcpAuditSummaryCode,
  AcpActivityFilterView,
  AcpActivityPageView,
  AcpActivitySnapshotView,
  AcpActivityView,
  AcpActivityJournalFrame,
  AcpAgentSessionSnapshotView,
  AcpAgentSessionOptionWrite,
  AcpOwnedRoutesView,
  AcpProjectedSubagentsView,
} from '../contract/remote.ts'

export type { AcpAuditSummaryCode } from '../contract/remote.ts'

/** `<command> --version` 尽力而为的短超时（毫秒）。 */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 3_000

// ---------- SDK → contract 收窄映射（数据最小化； strict boundary 前提） ----------

/**
 * 把 initialize 响应的 `AgentCapabilities` 实际值归一化为展示事实；
 * 未握手/未广告（undefined/null）归 null（UI 显示「未知」，绝不编造）。
 */
export function capabilityFactsOf(caps: acp.AgentCapabilities | null | undefined): AcpCapabilityFacts | null {
  if (caps === undefined || caps === null) return null
  return {
    loadSession: caps.loadSession === true,
    sessionList: caps.sessionCapabilities?.list != null,
    sessionClose: caps.sessionCapabilities?.close != null,
    sessionDelete: caps.sessionCapabilities?.delete != null,
    promptImage: caps.promptCapabilities?.image === true,
    promptAudio: caps.promptCapabilities?.audio === true,
    promptEmbeddedContext: caps.promptCapabilities?.embeddedContext === true,
    mcpHttp: caps.mcpCapabilities?.http === true,
    mcpSse: caps.mcpCapabilities?.sse === true,
  }
}

/** AuthMethod → 收窄三键（每个变体都有 id/name/description；vars/args/env/_meta 不过线）。 */
function contractAuthMethodOf(method: acp.AuthMethod): AcpAuthMethod {
  return {
    id: method.id,
    name: method.name,
    ...(method.description === undefined ? {} : { description: method.description }),
  }
}

function healthyRecoveryView(sessionId: string): AcpRecoveryView {
  return {
    dshSessionId: sessionId,
    kind: 'healthy',
    cause: null,
    detail: null,
    provider: null,
    acpSessionId: null,
    generation: null,
    interruptedTurnId: null,
    lastAttemptAt: null,
    lastUserAction: null,
    updatedAt: 0,
  }
}

function recoveryViewOf(state: AcpLiveAgentFace['recoveryState'] | undefined, sessionId: string): AcpRecoveryView {
  if (state === undefined) return healthyRecoveryView(sessionId)
  return {
    dshSessionId: state.dshSessionId,
    kind: state.kind,
    cause: state.cause ?? null,
    detail: state.detail ?? null,
    provider: state.provider ?? null,
    acpSessionId: state.acpSessionId ?? null,
    generation: state.generation ?? null,
    interruptedTurnId: state.interruptedTurnId ?? null,
    lastAttemptAt: state.lastAttemptAt ?? null,
    lastUserAction: state.lastUserAction ?? null,
    updatedAt: state.updatedAt,
  }
}

// ---------- 依赖注入面（接线；测试给假） ----------

/**
 * Probe-cache face the health method uses
 * （`AcpStubAdapter.probeSnapshot/invalidateProbe/listModels` 结构面；ok 分支的
 * authMethods 现在随缓存保留、过线前收窄）。`listModels` 是「重新检查」
 * （收尾）的重探触发器：失败同样落缓存（缓存的错误即失败事实），调用方
 * catch 后读新快照。
 */
export interface AcpProbeCacheLike {
  probeSnapshot(routeId: string): AcpProbeSnapshotLike | undefined
  invalidateProbe(routeId: string): void
  /** 触发一次重探（结果落缓存）；reject = 探测失败（失败条目已落缓存）。 */
  listModels(routeId: string): Promise<unknown>
}

/**
 * llm-stub 探针缓存条目的结构面（key 配置哈希 + at 时间戳 + 成功/失败分支；
 * SDK 原值，出栈前收窄）。新鲜度判定集中在 agent-config.ts
 * `acpProbeFresh`：key 与当前配置的 `acpProbeConfigKey` 相等且未过 TTL
 * （ok 10min / error 30s）才算新鲜；不新鲜/缺席按「从未探测」计入 state
 * （probe 行仍如实展示上次探测事实）。ok 分支的 cleanup/capabilityHash 是
 * 新增——旧条目（或测试夹具）缺席时 health 行如实归 null。
 */
export interface AcpProbeSnapshotLike {
  readonly key: string
  readonly at: number
  readonly result:
    | {
        readonly kind: 'ok'
        readonly models: readonly unknown[]
        readonly authMethods?: readonly acp.AuthMethod[]
 /** initialize 握手原值（现在随缓存保留；缺失时 health 行归 null）。 */
        readonly agentInfo?: acp.Implementation | null | undefined
        readonly agentCapabilities?: acp.AgentCapabilities | undefined
 /** probe 会话清理事实（缺席时 health 行归 null）。 */
        readonly cleanup?: { readonly close: string; readonly delete: string; readonly message?: string | undefined } | undefined
 /** initialize 握手能力的 sha256-16（缺席时 health 行归 null）。 */
        readonly capabilityHash?: string | undefined
 /** initialize 协商的协议版本（边界；缺席时 health 行归 null）。 */
        readonly protocolVersion?: number | undefined
        /**
         * configOptions 是否含 `category=model` 项（ 五态目录口径；
         * 旧条目/测试夹具缺席时按「无 model 类 configOption」计，与引入前逐字节一致）。
         */
        readonly hasModelConfigOption?: boolean | undefined
      }
    | {
        readonly kind: 'error'
        readonly failureKind: string
        readonly error: { readonly message: string }
 /** probe 失败阶段（未标记时 health 行归 null）。 */
        readonly probePhase?: 'initialize' | 'session' | undefined
      }
}

/** Registry face: agent 列表 + probe 缓存（快照/刷新）。 */
export interface AcpHealthRegistryLike {
  agents(): ReadonlyMap<string, AcpAgentConfig>
  /** Resolve the registered profile adapter that owns this route's probe cache. */
  readonly probeCacheFor: (profileId: string) => AcpProbeCacheLike | undefined
}

/**
 * Minimal live-agent seam used to classify a session backend and expose recovery state.
 */
export interface AcpLiveAgentFace {
  readonly status: 'idle' | 'running'
  /** Live ACP wrapper phase; draft is not yet a committed execution backend. */
  readonly backendState?: 'blank' | 'draft' | 'established'
 /** 本会话的 provider 路由（`acp-<id>`； `backendOf` 的权威 backend 判定之一）。 */
  readonly providerRoute: string
  /** 构造该 wrapper 时采用的会话模型；draft 阶段用于覆盖 DSH 的全局默认影子。 */
  readonly selectedModel?: string | undefined
  /** Live state used only by backend/recovery read paths. */
  readonly continuityState: AcpSessionContinuityState
  readonly recoveryState?: {
    readonly dshSessionId: string
    readonly kind: AcpRecoveryView['kind']
    readonly cause?: string
    readonly detail?: string
    readonly provider?: string
    readonly acpSessionId?: string
    readonly generation?: number
    readonly interruptedTurnId?: string
    readonly lastAttemptAt?: number
    readonly lastUserAction?: string
    readonly updatedAt: number
  }
}

/** Resolve a dsh session id to its live ACP agent；undefined = 无活体（调用即抛错）。 */
export type AcpResolveLiveAgent = (sessionId: string) => AcpLiveAgentFace | undefined

/** Host-owned recovery verbs for the provider composition.  This deliberately
 * exposes no legacy Agent object or model/options surface. */
export interface AcpRecoveryAdapterLike {
  retryOriginal(sessionId: string): Promise<void>
  rebindBlank(sessionId: string): Promise<void>
}

/** New additive provider control seam. It never exposes the legacy Agent. */
export interface AcpAgentSessionControlLike {
  agentSessionSnapshot(sessionId: string): Promise<AcpAgentSessionSnapshotView>
  setAgentSessionOption(sessionId: string, request: AcpAgentSessionOptionWrite): Promise<AcpAgentSessionSnapshotView>
}

export interface AcpRemoteServiceDeps {
  /** Registry：agent 列表 + probe 缓存（快照/刷新）。 */
  registry: AcpHealthRegistryLike
 /** 活体 agent 解析器（接线提供真实实现）。 */
  resolveLiveAgent: AcpResolveLiveAgent
  /**
 * 宿主结构门事实（；缺省恒 true）：health 行的五态 `state` 字段在
   * 结构门未通过时归 `incompatible`。生产接线由 host composition 以公开宿主
   * 服务组装（remote 层不依赖宿主私有实现
   * ——test/contracts/architecture.spec.ts 白名单）。
   */
  hostCompatible?: () => boolean
  /** 可执行存在性检查；缺省 `seam.resolveExecutable`（seam 缺席时恒 false）。 */
  checkExecutable?: (command: string) => Promise<boolean>
  /** 版本查询；缺省经 seam 的 `<command> --version` 尽力而为（seam 缺席时恒 null）。 */
  queryVersion?: (command: string) => Promise<string | null>
  /**
 * 加载期解析的 subprocess seam（host composition 注入）。
   * 仅驱动两个缺省实现：ok 时 checkExecutable=resolveExecutable 预检、
   * queryVersion=经 seam spawn `<command> --version`；缺席/未接线时缺省实现
   * fail closed（false / null）。显式注入的 checkExecutable/queryVersion 不受
   * 本字段影响。
   */
  subprocess?: SubprocessSeamResolution
  /**
  /**
 * 活体 ACP 会话的连续性清单（health 视图 `liveSessions` 字段的数据源）。
   * 缺省 → 该字段归 null（如实区分「未接线」与「无活体会话」的空数组）。生产
   * 接线 = host composition 过滤当前 ACP runtime。
   */
  listLiveSessions?: () => readonly { readonly sessionId: string; readonly continuity: AcpSessionContinuityState }[]
  /**
 * `backendOf` 的 backend 事实源（缺席时 backendOf 响亮拒绝——未接线
   * 不冒充 blank）。生产接线 = host composition：
   * - `readBindingProvider`：sidecar 最新 binding 的 provider（ok 且语义门槛
   *   通过）；无记录/读取失败/outdated 归 undefined（binding 读取失败非权威，
   *   与 resume 的 readBindingFor 同款容错）；
   * - `peekHeaderProvider`：日志末条 request/header 的 provider（只读
   *   inspect 窥测，resume 同款手法）；会话存在但无 header 归 undefined，
   *   会话不存在/日志不可读/无持久化后端则 throw；
   * - `hasLiveAgent`：任意 backend 的活体 agent 在场判定（session 存在性证据）。
   */
  backendFacts?: {
    readonly readBindingProvider: (sessionId: string) => Promise<string | undefined>
    readonly peekHeaderProvider: (sessionId: string) => Promise<string | undefined>
    readonly hasLiveAgent: (sessionId: string) => boolean
  }
  /**
 * `boundSessions` 的 binding 计数源（删除确认提示；缺席时 boundSessions
   * 响亮拒绝——未接线不冒充 0）。生产接线 = host composition 以
   * sidecar.listBindings 按 provider 过滤计数（只读）。
   */
  bindingFacts?: {
    readonly countBoundSessions: (provider: string) => Promise<number>
    readonly listBoundProviders?: () => Promise<readonly string[]>
  }
  /** Durable recovery state used when a session is not currently live. */
  recoveryStateStore?: {
    readonly read: (sessionId: string) => Promise<AcpRecoveryView | undefined>
  }
  /** Resolves the ACP profile adapter named by a durable binding. */
  recoveryAdapter?: (provider: string) => AcpRecoveryAdapterLike | undefined
  /** Resolves only the new per-profile provider control surface. */
  agentSessionControl?: (provider: string) => AcpAgentSessionControlLike | undefined
  /** Host-projected, bounded sidecar rows. Raw persistence payloads stay host-side. */
  auditTimeline?: {
    readonly list: (sessionId: string, afterSeq: number, limit: number) => Promise<readonly {
      readonly seq: number
      readonly time: number
      readonly kind: string
      readonly category: 'recovery' | 'permission' | 'agent' | 'files'
      readonly summaryCode: AcpAuditSummaryCode
      readonly subject: string | null
      readonly status: string | null
      readonly detail: string | null
    }[]>
    readonly hasMore: (sessionId: string, seq: number) => Promise<boolean>
  }
  /** Host-owned ACP activity journal. All reads are bounded and session-scoped;
   * raw sidecar handles never cross the Remote boundary. */
  activityTimeline?: {
    readonly snapshot: (sessionId: string, limit: number, filter?: AcpActivityFilterView) => Promise<readonly AcpActivityView[]>
    readonly page: (sessionId: string, afterRevision: number, limit: number, filter?: AcpActivityFilterView) => Promise<readonly AcpActivityView[]>
    readonly head: (sessionId: string, filter?: AcpActivityFilterView) => Promise<number>
    readonly subscribe?: (sessionId: string, filter: AcpActivityFilterView | undefined, subscriber: (activity: AcpActivityView) => void) => () => void
  }
  /** Authorizes a client-facing activity read against the current DSH session.
   * Missing authorization is fail-closed; it is never inferred from a string id. */
  activityAccess?: (sessionId: string) => boolean | Promise<boolean>
  /** Shared strict gate for audit and activity reads; production uses durable ownership only. */
  ownedSessionReadGate?: (sessionId: string) => boolean | Promise<boolean>
  projectedSubagentIds?: () => Promise<readonly string[]>
  /** Whether the DSH durable attachment service is mounted for ACP image input. */
  imageInputAvailable?: boolean
}

// ---------- 缺省实现：executable / version（全经宿主 subprocess seam） ----------

/**
 * `<command> --version` 尽力而为：首行 stdout（空则 stderr 首行），截 200 字符；
 * 超时（terminate 升级，SIGKILL 必杀，不留孤儿）/spawn 失败/无输出 → null。
 * env 不传：provider 的 scrub 底座（去 credential 形名 + DSH_*，PATH/代理穿透）
 * 已够版本探针用，比旧「全量继承 process.env」更安全。
 */
async function acpQueryVersion(
  seam: SubprocessSeam,
  command: string,
  timeoutMs: number = DEFAULT_VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  let handle: AcpSubprocessHandle
  try {
    handle = seam.spawn({
      argv: [command, '--version'],
      cwd: os.tmpdir(),
      // 超时后 terminate 的升级间隔：版本探针求快死，不铺 2s 的会话级礼貌窗口
      graceMs: VERSION_PROBE_TERM_GRACE_MS,
    })
  } catch {
    return null
  }
  const { stdin, stdout, stderr } = handle
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    // pipe/pipe/pipe 由窄化适配器固定；缺场 = 实现违约，收回进程按失败处理
    handle.terminate()
    return null
  }
  const done = handle.done.catch((): null => null)
  let out = ''
  let err = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => {
    out += chunk
  })
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => {
    err += chunk
  })
  try {
    stdin.end()
  } catch {
    // 对端抢跑退出不阻塞读取
  }
  const deadline = abortAfter(timeoutMs)
  try {
    // waitForExit（整树）与 done（close 结算，含 spawn 级失败）先到先赢
    const gone = await Promise.race([handle.waitForExit(deadline.signal), done.then(() => true)])
    if (!gone) {
      // 超时：terminate（SIGTERM → graceMs → SIGKILL；Windows taskkill /T /F）后无界等整树死绝
      handle.terminate()
      await handle.waitForExit()
      await done
      return null
    }
    await done
    return firstLine(out) ?? firstLine(err)
  } finally {
    deadline.cancel()
  }
}

/** 版本探针 terminate 的 SIGTERM → SIGKILL 升级间隔（毫秒）：探针求快死，不用会话级的 2s。 */
const VERSION_PROBE_TERM_GRACE_MS = 500

function firstLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line !== '') return line.length > 200 ? line.slice(0, 200) : line
  }
  return null
}

// ---------- Remote service ----------

interface ResolvedDeps {
  readonly registry: AcpHealthRegistryLike
  readonly resolveLiveAgent: AcpResolveLiveAgent
  readonly hostCompatible: () => boolean
  readonly checkExecutable: (command: string) => Promise<boolean>
  readonly queryVersion: (command: string) => Promise<string | null>
 /** 缺省 null（host 未接线时视图如实不带活体会话连续性清单）。 */
  readonly listLiveSessions: (() => readonly { readonly sessionId: string; readonly continuity: AcpSessionContinuityState }[]) | null
 /** 缺省 null（backendOf 未接线时响亮拒绝，不冒充 blank）。 */
  readonly backendFacts: NonNullable<AcpRemoteServiceDeps['backendFacts']> | null
 /** 缺省 null（boundSessions 未接线时响亮拒绝，不冒充 0）。 */
  readonly bindingFacts: NonNullable<AcpRemoteServiceDeps['bindingFacts']> | null
  readonly recoveryStateStore: NonNullable<AcpRemoteServiceDeps['recoveryStateStore']> | null
  readonly recoveryAdapter: NonNullable<AcpRemoteServiceDeps['recoveryAdapter']> | null
  readonly agentSessionControl: NonNullable<AcpRemoteServiceDeps['agentSessionControl']> | null
  readonly auditTimeline: NonNullable<AcpRemoteServiceDeps['auditTimeline']> | null
  readonly activityTimeline: NonNullable<AcpRemoteServiceDeps['activityTimeline']> | null
  readonly activityAccess: NonNullable<AcpRemoteServiceDeps['activityAccess']> | null
  readonly ownedSessionReadGate: NonNullable<AcpRemoteServiceDeps['ownedSessionReadGate']> | null
  readonly projectedSubagentIds: NonNullable<AcpRemoteServiceDeps['projectedSubagentIds']> | null
  readonly imageInputAvailable: boolean
}

/**
 * dshAcp namespace 的 Remote service（构造即注册 cordis service，gateway 经
 * strict descriptor 找到实例并调用）。当前公开面：health/backendOf/boundSessions、
 * audit/activity timeline、recoverySnapshot/retryOriginal/rebindRecoveryBlank、
 * agentSessionSnapshot/setAgentSessionOption。
 * - `health()`                    ← GET /dsh-acp/health（provider 行 + 顶层
 *   健康快照；**密钥边界** 只回显 command/args/loginHint，
 * env 永不在响应里——钉版见 test/integration/host/health.spec.ts；每行携带五态
 *   `state`，派生规则见 src/domain/session/agent-state.ts）
 * - `recoverySnapshot(sessionId)` ←：读取 sidecar 的恢复闩锁，不解析旧 Agent
 * - `retryOriginal(sessionId)` ←：恢复原 ACP binding，不重发中断 prompt
 *
 * 全部依赖注入（{@link AcpRemoteServiceDeps}）；测试直接 new 实例驱动方法，
 * 不再经过 HTTP req/res 假件。
 */
export class AcpRemoteService extends TypertRemoteService {
  private readonly resolved: ResolvedDeps

  constructor(ctx: Context, deps: AcpRemoteServiceDeps) {
    super(ctx, 'dshAcp')
 // seam 解析产物只驱动缺省实现；显式注入的 deps 原样优先（测试全注入假实现）。
    const subprocess = deps.subprocess ?? { ok: false as const, message: ACP_SUBPROCESS_UNAVAILABLE_MESSAGE }
    this.resolved = {
      registry: deps.registry,
      resolveLiveAgent: deps.resolveLiveAgent,
 // host 未接线结构门事实时按兼容处理（纯模块单测路径；生产恒注入）
      hostCompatible: deps.hostCompatible ?? (() => true),
      checkExecutable: deps.checkExecutable ?? (subprocess.ok
        ? // `command -v` 等价物：宿主 seam 的 PATH 解析（Windows 含 PATHEXT 语义），零 spawn 副作用
          (command: string) => subprocess.seam.resolveExecutable(command).then(() => true, () => false)
        : () => Promise.resolve(false)),
      queryVersion: deps.queryVersion ?? (subprocess.ok
        ? (command: string) => acpQueryVersion(subprocess.seam, command)
        : () => Promise.resolve(null)),
      listLiveSessions: deps.listLiveSessions ?? null,
      backendFacts: deps.backendFacts ?? null,
      bindingFacts: deps.bindingFacts ?? null,
      recoveryStateStore: deps.recoveryStateStore ?? null,
      recoveryAdapter: deps.recoveryAdapter ?? null,
      agentSessionControl: deps.agentSessionControl ?? null,
      auditTimeline: deps.auditTimeline ?? null,
      activityTimeline: deps.activityTimeline ?? null,
      activityAccess: deps.activityAccess ?? null,
      ownedSessionReadGate: deps.ownedSessionReadGate ?? deps.activityAccess ?? null,
      projectedSubagentIds: deps.projectedSubagentIds ?? null,
      imageInputAvailable: deps.imageInputAvailable ?? false,
    }
  }

  /** Read a bounded sidecar page. Raw payloads never cross the Remote boundary. */
  @Remote
  async auditTimeline(sessionId: string, request?: { readonly afterSeq?: number; readonly limit?: number }): Promise<AcpAuditTimelinePage> {
    const source = this.resolved.auditTimeline
    if (source === null) throw new Error('ACP audit history is unavailable on this host')
    await this.requireOwnedSessionRead(sessionId)
    const afterSeq = request?.afterSeq ?? 0
    const limit = request?.limit ?? 50
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('ACP audit cursor is invalid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('ACP audit page size is invalid')
    const entries = await source.list(sessionId, afterSeq, limit)
    const lastSeq = entries.at(-1)?.seq ?? afterSeq
    const hasMore = entries.length === limit && await source.hasMore(sessionId, lastSeq)
    return { sessionId, entries, nextCursor: hasMore ? lastSeq : null, hasMore }
  }

  /** Opening snapshot for the activity panel. Authorization is deliberately
   * separate from the sidecar query: a caller cannot turn an arbitrary string
   * into access to another DSH session's Agent trace. */
  @Remote
  async activitySnapshot(sessionId: string, request?: { readonly limit?: number; readonly filter?: AcpActivityFilterView }): Promise<AcpActivitySnapshotView> {
    await this.requireActivityRead(sessionId)
    const source = this.resolved.activityTimeline
    if (source === null) throw new Error('ACP activity history is unavailable on this host')
    const limit = request?.limit ?? 100
    validateActivityReadRequest(limit, request?.filter)
    const activities = await source.snapshot(sessionId, limit, request?.filter)
    const head = await source.head(sessionId, request?.filter)
    return { sessionId, activities, head }
  }

  /** Revision-cursor page used for reconnect/gap repair. The page contains
   * every committed revision, while the snapshot contains only current rows. */
  @Remote
  async activityPage(sessionId: string, request?: { readonly afterRevision?: number; readonly limit?: number; readonly filter?: AcpActivityFilterView }): Promise<AcpActivityPageView> {
    await this.requireActivityRead(sessionId)
    const source = this.resolved.activityTimeline
    if (source === null) throw new Error('ACP activity history is unavailable on this host')
    const afterRevision = request?.afterRevision ?? 0
    const limit = request?.limit ?? 100
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new Error('ACP activity cursor is invalid')
    validateActivityReadRequest(limit, request?.filter)
    const activities = await source.page(sessionId, afterRevision, limit, request?.filter)
    const lastRevision = activities.at(-1)?.revisionSeq ?? afterRevision
    const head = await source.head(sessionId, request?.filter)
    return { sessionId, activities, head, nextCursor: activities.length === limit && lastRevision < head ? lastRevision : null, hasMore: activities.length === limit && lastRevision < head }
  }

  /**
   * Snapshot-first live journal. The subscription is attached before the
   * opening read, so a revision committed during the opening window is either
   * present in the opening snapshot or remains queued for delivery. The
   * opening cursor is the unfiltered session head; clients filter activities
   * locally while retaining a contiguous reconnect cursor.
   */
  @Remote({ mode: 'stream' })
  async *activityFollow(
    sessionId: string,
    request: { readonly limit?: number; readonly filter?: AcpActivityFilterView } | undefined,
    signal: AbortSignal,
  ): AsyncIterable<AcpActivityJournalFrame> {
    await this.requireActivityRead(sessionId)
    const source = this.resolved.activityTimeline
    if (source === null || source.subscribe === undefined) throw new Error('ACP activity live stream is unavailable on this host')
    const limit = request?.limit ?? 100
    validateActivityReadRequest(limit, request?.filter)
    const queue: AcpActivityView[] = []
    let wake: (() => void) | undefined
    let openingHead = 0
    let closed = false
    const seen = new Set<number>()
    const unsubscribe = source.subscribe(sessionId, undefined, activity => {
      if (closed) return
      queue.push(activity)
      wake?.()
      wake = undefined
    })
    try {
      // Subscribe first, then rebuild the complete current-state projection
      // from bounded revision pages up to one fixed head.  A bounded snapshot
      // cannot safely advance to the full head: when a session owns more rows
      // than the opening limit, doing so permanently skips every undisclosed
      // revision.  Folding revision pages keeps transport bounded without
      // making the user-visible journal lossy.
      openingHead = await source.head(sessionId, undefined)
      const current = new Map<string, AcpActivityView>()
      let cursor = 0
      while (cursor < openingHead) {
        const before = cursor
        const page = await source.page(sessionId, cursor, limit, undefined)
        if (page.length === 0) break
        for (const activity of page) {
          if (activity.revisionSeq > openingHead) break
          current.set(activity.activityId, activity)
          seen.add(activity.revisionSeq)
          cursor = Math.max(cursor, activity.revisionSeq)
        }
        // A racing writer may make a backend page contain only revisions above
        // the fixed opening head. No row was consumed in that case; stop the
        // opening fold and let the already-subscribed queue deliver them.
        if (cursor === before) break
      }
      const activities = [...current.values()].sort((left, right) => left.activitySeq - right.activitySeq)
      yield { type: 'opened', cursor: openingHead, activities, head: openingHead }
      while (!signal.aborted) {
        while (queue.length > 0) {
          const activity = queue.shift()!
          if (activity.revisionSeq <= openingHead || seen.has(activity.revisionSeq)) continue
          seen.add(activity.revisionSeq)
          yield { type: 'entry', activity }
        }
        if (signal.aborted) break
        await new Promise<void>((resolve) => {
          wake = resolve
          if (signal.aborted) { wake = undefined; resolve() }
          else signal.addEventListener('abort', () => { wake = undefined; resolve() }, { once: true })
        })
      }
    } finally {
      closed = true
      unsubscribe()
      wake?.()
    }
  }

  private async requireActivityRead(sessionId: string): Promise<void> {
    await this.requireOwnedSessionRead(sessionId)
  }

  /** Validate identity and ownership before touching either sidecar source. */
  private async requireOwnedSessionRead(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) throw new Error('ACP activity session id is invalid')
    const access = this.resolved.ownedSessionReadGate
    if (access === null || !(await access(sessionId))) throw new Error('ACP activity access is not authorized for this DSH session')
  }

  /** Exact ownership proof consumed by additive client observers. Historical
   * routes remain owned after profile removal so old Activity still renders;
   * an unrelated plugin merely using the `acp-` prefix is never claimed. */
  @Remote('ownedProviderRoutes')
  async ownedProviderRoutes(): Promise<AcpOwnedRoutesView> {
    const configured = [...this.resolved.registry.agents().keys()]
      .map(key => key.startsWith('acp-') ? key : acpRouteId(key))
    const durable = this.resolved.bindingFacts?.listBoundProviders === undefined
      ? []
      : await this.resolved.bindingFacts.listBoundProviders()
    return { providers: [...new Set([...configured, ...durable])].sort() }
  }

  @Remote('projectedSubagentIds')
  async projectedSubagentIds(): Promise<AcpProjectedSubagentsView> {
    return { sessionIds: this.resolved.projectedSubagentIds === null ? [] : await this.resolved.projectedSubagentIds() }
  }

  /**
 * 全部 provider 的健康行（executable/version/probe 快照收窄透传 + 五态
 * `state`）+ 沙箱/指标/活体会话连续性事实。`request.recheck === true` 时重探：
   * `agentId` 在场只检查并返回该 provider，缺席检查并返回全部。这样卡片操作
   * 不会为无关 Agent 运行 executable/version/protocol probe；缺省只读缓存视图
   * （面板打开不 spawn probe）。
   */
  @Remote
  async health(request?: AcpHealthRequest): Promise<AcpHealthView> {
    const allEntries = [...this.resolved.registry.agents().entries()].sort(([left], [right]) => left.localeCompare(right))
    // 五态派生的宿主结构门输入（每行共享同一事实；deps 缺省恒 true）
    const hostCompatible = this.resolved.hostCompatible()
    const recheck = request?.recheck === true
    const targetAgentId = request?.agentId
    if (targetAgentId !== undefined) {
      if (!recheck) throw new Error('dsh-acp: health agentId requires recheck=true')
      if (!ACP_AGENT_ID_PATTERN.test(targetAgentId)) {
        throw new Error(`dsh-acp: invalid health agent id ${JSON.stringify(targetAgentId)}`)
      }
      if (!allEntries.some(([id]) => id === targetAgentId)) {
        throw new Error(`dsh-acp: unknown ACP agent ${JSON.stringify(targetAgentId)}`)
      }
    }
    const entries = targetAgentId === undefined
      ? allEntries
      : allEntries.filter(([id]) => id === targetAgentId)
    const providers: AcpProviderHealth[] = await Promise.all(
      entries.map(async ([id, config]) => {
        // The model picker and Settings health must address the same
        // registered profile adapter. A detached top-level stub would create
        // a second cache and can report a different readiness result.
        const probeCache = this.resolved.registry.probeCacheFor(id)
        if (probeCache === undefined) {
          return {
            id, name: config.name, command: config.command, args: [...config.args], loginHint: config.loginHint ?? null,
            executable: false, version: null,
            probe: { status: 'never', at: null },
            state: deriveAcpAgentState({ hostCompatible, configValid: true, probe: undefined }),
          }
        }
        if (recheck && (targetAgentId === undefined || targetAgentId === id)) {
 // 「重新检查」强制丢弃 probe cache 并重探（条文的接线路径）；重探
          // 失败不抛出——失败条目落缓存，下方照常按新鲜度产出 unavailable 行。
          const routeId = acpRouteId(id)
          probeCache.invalidateProbe(routeId)
          await probeCache.listModels(routeId).catch(() => undefined)
        }
        const snapshot = probeCache.probeSnapshot(acpRouteId(id))
        // Opening Settings is a read-only cache view: resolving PATH is
        // side-effect free, while `--version` is a subprocess and therefore
        // belongs exclusively to an explicit recheck. Never make a panel
        // mount spawn an ACP process (or a version helper).
        const executable = await this.resolved.checkExecutable(config.command)
        const cachedAgentVersion = snapshot?.result.kind === 'ok' && snapshot.result.agentInfo?.version !== undefined
          ? snapshot.result.agentInfo.version
          : null
        const version = recheck && executable ? await this.resolved.queryVersion(config.command) : cachedAgentVersion
 // 新鲜度集中判定（agent-config.ts acpProbeFresh）：key 相等且未过
        // TTL（ok 10min / error 30s）才算新鲜；不新鲜/缺席按「从未探测」计入
        // state（probe 行仍如实展示上次探测事实）。
        const fresh = snapshot !== undefined && acpProbeFresh(snapshot, acpProbeConfigKey(config), Date.now()) ? snapshot : undefined
        // readiness 派生：probe 握手事实与配置状态共同决定 readiness
        // 版本字段（versionPolicy/兼容状态）共用同一绑定事实。
        const descriptor = descriptorOf(id, config)
        return {
          id,
          name: config.name,
          command: config.command,
          args: [...config.args],
          loginHint: config.loginHint ?? null,
          executable,
          version,
          probe: probeRow(snapshot, descriptor, this.resolved.imageInputAvailable),
          // registry 的 agents map 经 settings schema 校验（非法值根本写不进来），configValid 恒 true
          state: deriveAcpAgentState({
            hostCompatible,
            configValid: true,
            probe: fresh === undefined ? undefined : probeStateView(fresh),
          }),
        }
      }),
    )
    const liveSessions: AcpLiveSessionContinuity[] | null = this.resolved.listLiveSessions === null
      ? null
      : this.resolved.listLiveSessions().map((entry) => ({ sessionId: entry.sessionId, continuity: entry.continuity }))
    return {
      providers,
      liveSessions,
    }
  }

  /** Additive Agent-owned controls/context surface. It intentionally does not
   * reuse the legacy live Agent/options service, model picker, or DSH usage. */
  @Remote
  async agentSessionSnapshot(sessionId: string): Promise<AcpAgentSessionSnapshotView> {
    const adapter = await this.agentSessionControlFor(sessionId)
    return await adapter.agentSessionSnapshot(sessionId)
  }

  @Remote
  async setAgentSessionOption(sessionId: string, request: AcpAgentSessionOptionWrite): Promise<AcpAgentSessionSnapshotView> {
    const adapter = await this.agentSessionControlFor(sessionId)
    return await adapter.setAgentSessionOption(sessionId, request)
  }

  private async agentSessionControlFor(sessionId: string): Promise<AcpAgentSessionControlLike> {
    const provider = this.resolved.backendFacts === null
      ? undefined
      : await this.resolved.backendFacts.readBindingProvider(sessionId)
    if (provider === undefined) throw new Error('No established ACP Agent session is available')
    const resolver = this.resolved.agentSessionControl
    if (resolver === null) throw new Error('ACP Agent session controls are unavailable on this host')
    const adapter = resolver(provider)
    if (adapter === undefined) throw new Error('No plugin-owned ACP Agent session is available')
    return adapter
  }

  /**
   * backendOf（「backend 不可变」的 picker 主防线数据面）：host 权威的
   * 会话 backend 查询，纯读零副作用。判定优先级：sidecar binding（ACP 会话
   * 创建即有）→ 尚未建立 binding 的活体 AcpAgent → 日志末条 request/header 的 provider（只读
   * inspect 窥测）→ 都没有 = 'blank'（blank
   * 会话的 current.provider 只是实时默认的影子，不算定 backend）。
   * 会话不存在/日志不可读且无任何在场证据 → 响亮报错（protocol-error）：调用方
   * 手里应都是真实 session，冒充 blank 会让 picker 放行一个不可判定的会话。
   */
  /** Read the durable recovery state without resolving a legacy live Agent. */
  @Remote('recoverySnapshot')
  async recoverySnapshot(sessionId: string): Promise<AcpRecoveryView> {
    const persisted = this.resolved.recoveryStateStore === null
      ? undefined
      : await this.resolved.recoveryStateStore.read(sessionId)
    if (persisted !== undefined) return persisted
    const live = this.resolved.resolveLiveAgent(sessionId)
    return live === undefined ? healthyRecoveryView(sessionId) : recoveryViewOf(live.recoveryState, sessionId)
  }

  private async recoveryAdapterFor(sessionId: string): Promise<AcpRecoveryAdapterLike> {
    const provider = this.resolved.backendFacts === null
      ? undefined
      : await this.resolved.backendFacts.readBindingProvider(sessionId)
    if (provider === undefined) throw new Error(`ACP recovery binding is unavailable for session "${sessionId}"`)
    const adapter = this.resolved.recoveryAdapter?.(provider)
    if (adapter === undefined) throw new Error(`ACP recovery profile is unavailable for provider "${provider}"`)
    return adapter
  }

  /** Retry the original durable Agent binding; never resends the interrupted prompt. */
  @Remote('retryOriginal')
  async retryOriginal(sessionId: string): Promise<AcpRecoveryView> {
    const adapter = await this.recoveryAdapterFor(sessionId)
    await adapter.retryOriginal(sessionId)
    return await this.recoverySnapshot(sessionId)
  }

  /** Provider-composition blank rebind. Unlike the legacy rebindBlank method,
   * this returns the recovery state directly and never depends on an option
   * snapshot being present. */
  @Remote('rebindRecoveryBlank')
  async rebindRecoveryBlank(sessionId: string): Promise<AcpRecoveryView> {
    const adapter = await this.recoveryAdapterFor(sessionId)
    await adapter.rebindBlank(sessionId)
    return await this.recoverySnapshot(sessionId)
  }

  @Remote('backendOf')
  async backendOf(sessionId: string): Promise<AcpBackendState> {
    const facts = this.resolved.backendFacts
    if (facts === null) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: backend facts are not wired on this host; cannot determine the backend of session "${sessionId}"`,
        { category: 'config' },
      )
    }
    const bound = await facts.readBindingProvider(sessionId)
    if (bound !== undefined) return { state: 'established', provider: bound }
    // A newly-created session whose default model is ACP already owns an ACP
    // wrapper. Before session/new it has no durable binding yet, but its
    // execution-backend identity is not blank: Alpha cannot replace that live
    // wrapper in place. Report it as a provider-qualified draft so the client
    // can converge Native Agent Access and route model choices without asking
    // the user to select the same Agent a second time.
    const liveAcp = this.resolved.resolveLiveAgent(sessionId)
    if (liveAcp !== undefined) {
      const state = liveAcp.backendState ?? 'established'
      return state === 'blank'
        ? {
            state: 'draft',
            provider: liveAcp.providerRoute,
            ...(liveAcp.selectedModel === undefined || liveAcp.selectedModel === ''
              ? {}
              : { model: liveAcp.selectedModel }),
          }
        : { state, provider: liveAcp.providerRoute }
    }
    try {
      const header = await facts.peekHeaderProvider(sessionId)
      return header === undefined ? { state: 'blank' } : { state: 'established', provider: header }
    } catch (error: unknown) {
      // 无日志可读时活体（任意 backend，含尚未落 header 的新 native 会话）仍是
      // 存在性证据：无 header 即 blank。
      if (facts.hasLiveAgent(sessionId)) return { state: 'blank' }
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: cannot determine the execution backend of session "${sessionId}": the session does not exist or its log is unreadable (${error instanceof Error ? error.message : String(error)})`,
        { category: 'config' },
      )
    }
  }

  /**
 * boundSessions（删除确认提示）：该 profile（按 agent id）当前被多少个
   * 既有 DSH 会话的 sidecar binding 引用——删除 profile 后这些会话显示
   * backend-unavailable，面板在确认文案中如实预告。纯读零副作用；agent id
   * 非法或未接线一律 throw（不冒充 0）。
   */
  @Remote('boundSessions')
  async boundSessions(agentId: string): Promise<AcpBoundSessionsView> {
    if (!ACP_AGENT_ID_PATTERN.test(agentId)) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: invalid agent id ${JSON.stringify(agentId)} (must match ${String(ACP_AGENT_ID_PATTERN)})`,
        { category: 'config' },
      )
    }
    const facts = this.resolved.bindingFacts
    if (facts === null) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: binding facts are not wired on this host; cannot count sessions bound to "${agentId}"`,
        { category: 'config' },
      )
    }
    return { agentId, count: await facts.countBoundSessions(acpRouteId(agentId)) }
  }

}

function validateActivityReadRequest(limit: number, filter: AcpActivityFilterView | undefined): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('ACP activity page size is invalid')
  if (filter === undefined) return
  for (const [key, value] of Object.entries(filter)) {
    if (key !== 'ownerDshSessionId' && key !== 'promptAnchorMessageId') throw new Error(`ACP activity filter field is invalid: ${key}`)
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 256)) throw new Error('ACP activity filter value is invalid')
  }
}

/** 新鲜 probe 条目 → 五态派生的最小视图（ok 留目录事实，error 留分流 kind）。 */
function probeStateView(snapshot: AcpProbeSnapshotLike): AcpAgentStateProbeView {
  const { result } = snapshot
  return result.kind === 'ok'
    ? { result: { kind: 'ok', modelCount: result.models.length, hasModelConfigOption: result.hasModelConfigOption === true } }
    : { result: { kind: 'error', failureKind: result.failureKind } }
}

/** cleanup 三态词表收窄（结构面按 string 进；词表外值诚实归 null，不猜测）。 */
function contractCleanupOf(cleanup: { readonly close: string; readonly delete: string; readonly message?: string | undefined } | undefined): AcpProbeCleanupView | null {
  if (cleanup === undefined) return null
  const steps = ['done', 'not-advertised', 'failed'] as const
  const close = steps.find((step) => step === cleanup.close)
  const del = steps.find((step) => step === cleanup.delete)
  if (close === undefined || del === undefined) return null
  return { close, delete: del, message: cleanup.message ?? null }
}

function probeRow(snapshot: AcpProbeSnapshotLike | undefined, descriptor: AcpAgentRuntimeDescriptor | undefined, imageInputAvailable: boolean): AcpProviderHealth['probe'] {  if (snapshot === undefined) return { status: 'never', at: null }
  const { result, at } = snapshot
  if (result.kind === 'ok') {
    const capabilities = capabilityFactsOf(result.agentCapabilities)
    return {
      status: 'ok',
      at,
      modelCount: result.models.length,
      authMethods: result.authMethods === undefined ? null : result.authMethods.map(contractAuthMethodOf),
      agentInfo: result.agentInfo == null
        ? null
        : { name: result.agentInfo.name, version: result.agentInfo.version },
      capabilities,
      cleanup: contractCleanupOf(result.cleanup),
      capabilityHash: result.capabilityHash ?? null,
 // readiness：协议版本 / 钉版 / 兼容状态（兼容状态由 agent-config.ts
      // 纯函数派生，比对握手 agentInfo.version 与 descriptor versionPolicy）
      protocolVersion: result.protocolVersion ?? null,
      versionPolicy: descriptor === undefined
        ? null
        : { adapter: descriptor.versionPolicy.adapter ?? null, wrappedCli: descriptor.versionPolicy.wrappedCli ?? null },
      versionCompatibility: acpVersionCompatibility(descriptor, result.agentInfo?.version),
 // 端到端能力矩阵（广告 × adapter path；纯函数
      // 直通，形状与 contract `AcpCapabilityMatrixRow` 结构一致，无映射）
      matrix: acpCapabilityMatrix(capabilities, {
        imageInput: imageInputAvailable,
      }),
    }
  }
  return {
    status: 'error',
    at,
    failureKind: result.failureKind,
    message: result.error.message,
    phase: result.probePhase ?? null,
  }
}
