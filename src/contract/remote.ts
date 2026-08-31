/**
 * dshAcp Remote 边界的 wire contract：host 与 client 共享的收窄载荷
 * 类型词汇，typert strict codec 的生成输入。本层是零 import 叶子（分层守卫见
 * test/contracts/architecture.spec.ts）——刻意不从 ACP SDK 取类型：SDK v1 的
 * `AuthMethod`/`SessionConfigOption` 携带 `_meta?: Record<string, unknown> | null`，
 * `unknown` 被 strict boundary 拒绝（spike 实证：本机兼容性探针），
 * 且 client 本就只消费这里的字段；host 侧负责 SDK → contract 的显式映射（src/remote/service.ts），
 * 映射同时是数据最小化（auth 的 vars/env 等键名不过线）。
 *
 * 形状纪律：全部字段只含 string/number/boolean/字面量联合/null/readonly 数组与
 * `Record<string, string>` 标签——strict 生成已验证保真（readonly/union/literal/
 * null 联合/z.record）。改这里的形状必须重跑 `pnpm gen:typert` 并全绿门禁。
 * @module @zaimokuza/dsh-acp-adapter/contract/remote
 */

/** Stable ACP diagnostics preserved by alpha.2's typed Remote failure carrier. */
export interface AcpRemoteErrorDetails {
  readonly kind: string | null
  readonly correlationId: string | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dsh-acp/config': AcpRemoteErrorDetails
    'dsh-acp/not-installed': AcpRemoteErrorDetails
    'dsh-acp/auth-required': AcpRemoteErrorDetails
    'dsh-acp/protocol-incompatible': AcpRemoteErrorDetails
    'dsh-acp/timeout': AcpRemoteErrorDetails
    'dsh-acp/agent-crash': AcpRemoteErrorDetails
    'dsh-acp/user-rejected': AcpRemoteErrorDetails
    'dsh-acp/resume-conflict': AcpRemoteErrorDetails
  }
}

/** initialize 握手广告能力的展示事实（未握手/未广告归 null/false，绝不编造）。 */
export interface AcpCapabilityFacts {
  /** `session/load`（重启后恢复 ACP 上下文的前提）。 */
  readonly loadSession: boolean
  /** `session/list`（恢复前查重/列会话）。 */
  readonly sessionList: boolean
 /** `session/close`（probe/会话清理的「释放资源」步）。 */
  readonly sessionClose: boolean
 /** `session/delete`（probe/会话清理的「移出 session/list」步）。 */
  readonly sessionDelete: boolean
  /** prompt 可携带图片。 */
  readonly promptImage: boolean
  /** prompt 可携带音频。 */
  readonly promptAudio: boolean
  /** prompt 可携带嵌入上下文（Resource 块）。 */
  readonly promptEmbeddedContext: boolean
  /** MCP over HTTP。 */
  readonly mcpHttp: boolean
  /** MCP over SSE。 */
  readonly mcpSse: boolean
}

/**
 * 端到端能力矩阵一行的三值状态词表（domain 真源与派生规则见
 * src/domain/policy/capability-matrix.ts `acpCapabilityMatrix`，本类型是它的
 * wire 字面量副本）。
 */
export type AcpCapabilityMatrixStatus = 'supported' | 'degraded' | 'unsupported'

/**
 * 端到端能力矩阵的一行（wire 副本）：每行同时记录三列事实——
 * advertised（Agent initialize 广告值；无握手数据归 null）、adapterPath
 * （adapter 实现路径的短事实词）、hostSeam（参与的宿主 seam 短事实词，无
 * 参与归 null）——外加派生的三值 status 与可选 note（host 侧事实陈述原文，
 * client 只做次级展示不过 locale）。
 */
export interface AcpCapabilityMatrixRow {
  readonly id: string
  readonly advertised: boolean | null
  readonly adapterPath: string
  readonly hostSeam: string | null
  readonly status: AcpCapabilityMatrixStatus
  readonly note?: string
}

/**
 * probe 会话清理事实（镜像 src/protocol/v1/types.ts
 * `AcpProbeCleanup`，message 收窄为 null 词表）。三态如实：done = 已清理；
 * not-advertised = agent 未广告该能力（probe session 可能残留在 agent 的
 * session/list——UI 须展示明确降级说明）；failed = 清理 RPC 失败/超时。
 */
export interface AcpProbeCleanupView {
  readonly close: 'done' | 'not-advertised' | 'failed'
  readonly delete: 'done' | 'not-advertised' | 'failed'
  readonly message: string | null
}


/**
 * 收窄的 ACP `AuthMethod`：每个变体都有的 id/name/description 三键；
 * `vars`/`args`/`env`/`type`/`_meta` 不过线（面板只按 id+name 列登录方法，
 * 凭证键名属数据最小化剔除项）。
 */
export interface AcpAuthMethod {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}

/** 收窄的 ACP `SessionConfigSelectOption`（select 选项的一个扁平值）。 */
export interface AcpConfigSelectValue {
  readonly value: string
  readonly name: string
  readonly description?: string | null
}

/** 收窄的 ACP `SessionConfigSelectGroup`（值分组）。 */
export interface AcpConfigSelectGroup {
  readonly group: string
  readonly name: string
  readonly options: readonly AcpConfigSelectValue[]
}

/**
 * 收窄的 ACP `SessionConfigOption`（select/boolean 两变体判别联合，剔 `_meta`）。
 * 未知 type 由 host 映射丢弃——协议 SHOULD-ignore 语义下 client 解码器本就跳过，
 * UI 行为不变（agent 默认值在位）。
 */
export type AcpConfigOption =
  | {
      readonly type: 'select'
      readonly id: string
      readonly name: string
      readonly description?: string | null
      readonly category?: string | null
      readonly currentValue: string
      readonly options: readonly (AcpConfigSelectValue | AcpConfigSelectGroup)[]
    }
  | {
      readonly type: 'boolean'
      readonly id: string
      readonly name: string
      readonly description?: string | null
      readonly category?: string | null
      readonly currentValue: boolean
    }

/** probe 失败阶段（四层分层判据；镜像 src/protocol/v1/types.ts `AcpProbePhase`）。 */
export type AcpProbePhaseView = 'initialize' | 'session'

/**
 * `health()` 的一行 provider 健康事实。`probe.error.failureKind` 线上是
 * `AcpErrorKind`（src/protocol/v1/types.ts）的字面量成员，wire 面按 string 收窄
 * （client 只当字符串展示与比对 `auth_required`）。
 * **密钥边界** 只回显 command/args/loginHint，env 永不在响应里（钉版）。
 */
export interface AcpProviderHealth {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** Panel login guidance；provider 配置未带时为 null。 */
  readonly loginHint: string | null
  /** `command -v` 等价物：PATH（或路径直给）上存在可执行文件。 */
  readonly executable: boolean
  /** `<command> --version` 首行（尽力而为）；超时/失败/跳过时为 null。 */
  readonly version: string | null
 /** 五态状态（派生规则见 src/domain/session/agent-state.ts）。 */
  readonly state: AcpAgentConfigState
  /**
   * 上次 probe 快照（llm-stub 缓存；首次目录构建前为 'never'）。成功分支携带
   * authMethods（收窄后）、agentInfo/capabilities（initialize 握手实际值）、
 * cleanup（清理事实）与 capabilityHash（握手能力的 sha256-16，
   * 缺失归 null——条目早于本特性时如实为空，不编造）；失败分支携带 phase
   * （probe 失败阶段；未标记归 null）。
   */
  readonly probe:
    | { readonly status: 'never'; readonly at: null }
    | {
        readonly status: 'ok'
        readonly at: number
        readonly modelCount: number
        readonly authMethods: readonly AcpAuthMethod[] | null
        readonly agentInfo: { readonly name: string; readonly version: string } | null
        readonly capabilities: AcpCapabilityFacts | null
        readonly cleanup: AcpProbeCleanupView | null
        readonly capabilityHash: string | null
        /**
 * readiness：initialize 协商的 ACP 协议版本（probe 缓存条目早于
         * 本特性/握手未给出时归 null，不编造）。
         */
        readonly protocolVersion: number | null
        /**
 * readiness：绑定 descriptor 声明的钉版（versionPolicy 原值收窄；
         * 字段缺席归 null 成员）。无 descriptor 的普通 profile 整体归 null。
         */
        readonly versionPolicy: { readonly adapter: string | null; readonly wrappedCli: string | null } | null
        /**
 * 兼容状态（agent-config.ts `acpVersionCompatibility` 直通）：无
         * descriptor 或握手无版本 → null；descriptor 无钉版 → 'unpinned'；握手
         * 版本等于钉版 → 'pinned'；不等 → 'drifted'（不阻断，仅如实展示）。
         */
        readonly versionCompatibility: 'pinned' | 'drifted' | 'unpinned' | null
        /**
 * 端到端能力矩阵：host 侧由 capabilities（广告事实）
         * × adapter path 计算（src/domain/policy/
         * capability-matrix.ts）；capabilities 为 null 时矩阵照常下发（广告列
         * 全 null）。UI 只许展示本矩阵的交集结论，不再直译广告布尔。
         */
        readonly matrix: readonly AcpCapabilityMatrixRow[]
      }
    | {
        readonly status: 'error'
        readonly at: number
        readonly failureKind: string
        readonly message: string
        readonly phase: AcpProbePhaseView | null
      }
}

/** `health()` 的整包视图。 */
export interface AcpHealthView {
  readonly providers: readonly AcpProviderHealth[]
 /** 活体 ACP 会话的连续性清单（未接线/无活体会话归 null 或空数组，如实区分）。 */
  readonly liveSessions: readonly AcpLiveSessionContinuity[] | null
}

/** Exact provider routes currently configured by this plugin or durably
 * referenced by one of its historical bindings. */
export interface AcpOwnedRoutesView {
  readonly providers: readonly string[]
}

export interface AcpProjectedSubagentsView {
  readonly sessionIds: readonly string[]
}

/** ACP 审计视图的本地化无关摘要事实；客户端按当前语言生成文案。 */
export type AcpAuditSummaryCode =
  | 'binding.established'
  | 'permission.asked'
  | 'permission.decided'
  | 'reconciliation.required'
  | 'replay.matched'
  | 'replay.different'
  | 'replay.overflow'
  | 'replay.not-compared'
  | 'replay.unavailable'
  | 'degradation.recorded'
  | 'filesystem.operation'
  | 'terminal.operation'
  | 'session-fork.completed'
  | 'agent.event'

/** ACP 审计视图的一条有界 sidecar 记录；UI 文案由客户端 locale 生成。 */
export interface AcpAuditTimelineEntry {
  readonly seq: number
  readonly time: number
  readonly kind: string
  readonly category: 'recovery' | 'permission' | 'agent' | 'files'
  readonly summaryCode: AcpAuditSummaryCode
  readonly subject: string | null
  readonly status: string | null
  readonly detail: string | null
}

/** Cursor-paged ACP audit ledger. Cursor is the last returned per-session seq. */
export interface AcpAuditTimelinePage {
  readonly sessionId: string
  readonly entries: readonly AcpAuditTimelineEntry[]
  readonly nextCursor: number | null
  readonly hasMore: boolean
}

/** Host-projected ACP activity journal row. This is not a DSH tool call and
 * never authorizes execution; it is an observable Agent activity record. */
export type AcpActivityKindView = 'tool' | 'plan' | 'terminal' | 'diff' | 'resource' | 'delegated' | 'other'
export type AcpActivityStatusView = 'running' | 'completed' | 'failed' | 'cancelled'
export interface AcpActivityView {
  readonly dshSessionId: string
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
  readonly activityId: string
  readonly activitySeq: number
  readonly revisionSeq: number
  readonly time: number
  readonly kind: AcpActivityKindView
  readonly status: AcpActivityStatusView
  readonly presentation: string
  readonly rawDetail?: string
  readonly rawDetailRef?: string
}
export interface AcpActivityFilterView {
  readonly ownerDshSessionId?: string
  readonly promptAnchorMessageId?: string
}
export interface AcpActivitySnapshotView {
  readonly sessionId: string
  readonly activities: readonly AcpActivityView[]
  readonly head: number
}
export interface AcpActivityPageView {
  readonly sessionId: string
  readonly activities: readonly AcpActivityView[]
  readonly head: number
  readonly nextCursor: number | null
  readonly hasMore: boolean
}

/** Opening window and durable revisions emitted by the ACP activity stream. */
export type AcpActivityJournalFrame =
  | {
      readonly type: 'opened'
      readonly cursor: number
      readonly activities: readonly AcpActivityView[]
      readonly head: number
    }
  | {
      readonly type: 'entry'
      readonly activity: AcpActivityView
    }

/**
 * `boundSessions(agentId)` 的应答（删除确认提示，）：
 * 该 profile 当前被多少个既有 DSH 会话的 sidecar binding 引用——删除 profile
 * 后这些会话显示 backend-unavailable（不静默改用其他 profile），面板在确认
 * 文案中如实预告计数。纯读零副作用。
 */
export interface AcpBoundSessionsView {
  readonly agentId: string
  readonly count: number
}

/**
 * 会话连续性状态（wire 副本；domain 真源是 src/domain/session/agent.ts 的
 * `AcpSessionContinuityState`，host 侧直通映射）：'ok' = 已对齐；'blocked' =
 * reconciliation-required（cause 是 src/persistence/sidecar.ts
 * `AcpReconciliationCause` 词表的字面量成员，wire 面按 string 收窄；detail 是有界
 * 人类可读摘要）。ok 时 cause/detail 恒 null。
 */
export interface AcpSessionContinuity {
  readonly status: 'ok' | 'blocked'
  readonly cause: string | null
  readonly detail: string | null
}

/** `health()` 的一行活体会话连续性事实。 */
export interface AcpLiveSessionContinuity {
  readonly sessionId: string
  readonly continuity: AcpSessionContinuity
}

/**
 * `health()` 的请求：缺省/省略 = 只读缓存视图（面板打开不 spawn
 * probe）；`recheck: true` = 重新检查。`agentId` 在场时只检查并返回该
 * provider，缺席时检查并返回全部 provider。`agentId` 只允许与
 * `recheck: true` 同时使用。
 */
export interface AcpHealthRequest {
  readonly recheck?: boolean
  readonly agentId?: string
}

/**
 * `backendOf(sessionId)` 的应答（「backend 不可变」的 host 权威查询）。
 * - `'blank'`：尚无 ACP backend 承诺——无活体 ACP agent、无 sidecar binding、日志无
 *   request/header。若 DSH 已为该会话实例化 native wrapper，`current.provider` 会
 *   暴露该事实；0.1.2-alpha.2 仍没有 live wrapper 替换 seam，跨到 ACP 会自动新建会话。
 * - `'draft'`：空白会话已启动 ACP wrapper、可读取会话级配置，但首条 prompt 尚未
 *   提交 ACP binding；同一 ACP profile 可原地选模型，跨 profile/native 会自动新建会话。
 * - `'established'`：backend 已锁定；`provider` 即路由 id（`acp-<id>` 前缀 =
 *   ACP profile，其余 = native）。executionBackend 的持久化真源：ACP 侧 =
 * sidecar binding（创建时即写）+ 日志 request/header（首 turn 落）；
 *   native 侧 = request/header。backend 创建后不可变，跨 backend 只能新建会话。
 */
export type AcpBackendState =
  | { readonly state: 'blank' }
  | { readonly state: 'draft'; readonly provider: string; readonly model?: string }
  | { readonly state: 'established'; readonly provider: string }

export type AcpRecoveryKind = 'healthy' | 'reconnect-required' | 'outcome-unknown' | 'reconciliation-required' | 'session-lost' | 'local-history-damaged' | 'resumed-unverified'

/** Minimal recovery view used by the independent session recovery surface. */
export interface AcpRecoveryView {
  readonly dshSessionId: string
  readonly kind: AcpRecoveryKind
  readonly cause: string | null
  readonly detail: string | null
  readonly provider: string | null
  readonly acpSessionId: string | null
  readonly generation: number | null
  readonly interruptedTurnId: string | null
  readonly lastAttemptAt: number | null
  readonly lastUserAction: string | null
  readonly updatedAt: number
}

/** Explicit user decisions recorded by the recovery surface. */
/** Agent 明确提供的累计成本事实（wire 副本；amount/currency 原样透传，不换算不聚合）。 */
export interface AcpContextUsageCostView {
  readonly amount: number
  readonly currency: string
}

/** 最新已知 ACP 上下文占用的 wire 视图（used/size 为 agent 报告原值，percent 保留一位小数）。 */
export interface AcpContextUsageView {
  readonly used: number
  readonly size: number
  readonly percent: number
  /** agent 明确提供的累计成本；未提供为 null。 */
  readonly cost: AcpContextUsageCostView | null
}

/** Agent-owned session controls/context facts.  This is deliberately separate
 * from the stock model-selection surface and from DSH TokenUsage. */
export interface AcpAgentModeView {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}

export interface AcpAgentSessionSnapshotView {
  readonly sessionId: string
  readonly profileId: string
  readonly freshness: 'live' | 'stale'
  readonly editable: boolean
  readonly configOptions: readonly AcpConfigOption[] | null
  readonly modes: readonly AcpAgentModeView[] | null
  readonly currentModeId: string | null
  readonly contextUsage: AcpContextUsageView | null
  readonly note: string | null
}

export type AcpAgentSessionOptionWrite =
  | { readonly kind: 'config'; readonly id: string; readonly value: string | boolean }
  | { readonly kind: 'mode'; readonly id: string }

/**
 * ACP agent 配置的五态词表（domain 真源与派生规则见
 * src/domain/session/agent-state.ts `deriveAcpAgentState`，本类型是它的 wire
 * 字面量副本）：saved-unverified = 已存未探测；ready = 新鲜 probe 成功且
 * （绑定的 descriptor 声明 auth refs 时）模型目录非空；auth-required = 需要登录（出路是
 * agent 自家 CLI——external-login-only， Remote 面不再有
 * authenticate）；unavailable = probe 失败/配置无效；incompatible = 宿主结构
 * 门未通过。
 */
export type AcpAgentConfigState = 'saved-unverified' | 'ready' | 'auth-required' | 'unavailable' | 'incompatible'
