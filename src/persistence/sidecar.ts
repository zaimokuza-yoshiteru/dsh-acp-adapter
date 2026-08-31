/**
 * Sidecar 旁路存储（sidecar 持久化规则，持久化原则）：审批审计与 ACP binding
 * **不落 session log**，落 harness-home 下的插件私有存储（root =
 * `<dshHome>/dsh-acp`）。
 *
 * 为什么不在 session log：live-event ordering evidence 表明（
 * orchestrator 复跑复证）——插件直写 `ctx.sessionPersistence.append` 会在 live
 * session 上每条 marker 静默吞掉其后一条 live 事件（重启才显形）；`Session.append`
 * 又无 ignorable 写入面。在宿主提供可忽略审计事件入口前，sidecar 是审计真源。
 *
 * ## node:sqlite（DatabaseSync）+ WAL 生产化重写
 *
 * 存储引擎从「每 sessionId 一个 JSONL 文件 + tmp/fsync/rename 原子发布」重写为
 * 单库文件 `<root>/sidecar.sqlite`（`journal_mode=WAL`、`synchronous=NORMAL`、
 * `busy_timeout=5000`）。选型定稿理由：Node ≥22.13 `node:sqlite` 免 flag
 * （engines `^22.19||>=24` 全覆盖），零新依赖；WAL 自带崩溃恢复（进程级 kill -9
 * 不丢已 commit 事务）；追加是 O(1) 页写入而非 JSONL 的全文重写。`synchronous=
 * NORMAL` 下 commit 不逐条 fsync（无 fsync 风暴），进程崩溃不丢已提交记录；整库
 * checkpoint 在 {@link AcpSidecar.flush}/{@link AcpSidecar.dispose} 周期性执行。
 *
 * **不自动迁移旧 JSONL**：SQLite 重写发生在 1.0 前的 RC 阶段，旧
 * `<sessionId>.jsonl` 从未成为稳定存储契约。启动时若发现旧文件，仅 warn 并忽略，
 * 不读、不迁、不删；对应旧会话因缺少 binding 进入 reconciliation-required
 * fail-safe（`binding-missing`）。需要保留旧 Agent 上下文时，应先用生成该 JSONL
 * 的旧插件版本处理；否则由用户显式放弃旧 ACP 上下文。当前 SQLite 数据库保持兼容。
 * `.corrupt-*` 坏行隔离概念随之删除——SQLite 要么库损坏要么不损坏，不存在行级
 * 隔离；库无法打开或校验失败时 open 即 fail loud，读路径不吞错继续。
 *
 * `platform` option 与 ./platform.ts（rename/重试画像）随本重写一并移除——SQLite
 * 的 commit/WAL 恢复取代了 tmp+rename 发布面；这是上述 1.0 前 RC 的存储破坏性变更。
 *
 * ## 表结构
 *
 * - `audit` 追加表（全部 kind 的完整历史）：record_id（per-session 唯一）、
 *   dsh_session_id、seq（per-session 单调，1 起）、time、kind、acp_provider_id?、
 *   acp_session_id?、dedupe_key（仅 permission decided 有值，`(dsh_session_id,
 *   dedupe_key)` 部分唯一索引）、payload（canonical JSON 文本，键序稳定）。
 * - `bindings` 最新索引表：dsh_session_id 主键 upsert（payload + envelope 分量），
 *   {@link AcpSidecar.readLatestBinding}/{@link AcpSidecar.listBindings} 只查此表。
 * - `option_snapshots` 冷启动 last-known 配置快照表：每会话
 *   至多一行（dsh_session_id 主键 upsert），payload 为
 *   {@link AcpOptionsSnapshotRecord}——标准化且有界（`_meta`/未知键剥离，
 *   字段/值数/总字节硬上限见 `ACP_SNAPSHOT_*` 常量）；取代 binding 曾携带的
 *   一次性无界 `configSnapshot`（该字段已删除，单一事实副本只在此表）。
 *   活体权威快照到达即刷新（建立/set_config_option/set_mode/turn 收束变更）；
 *   写失败仅 warn（last-known 是展示/参考面，不是提交面）。
 * - `activity_journal` 外部 Agent 活动表：按 DSH session 隔离、以 activity_id
 *   append-only revision，activity_seq 只在首次出现时分配，revision_seq 为每次
 *   mutation 的连续游标；它是机器可读的执行活动面，和面向人的 audit envelope
 *   分开。活动行可独立分页，并作为会话轨迹与外部子代理投影的持久事实源。
 *
 * **recordId 派生**（钉版规则不变）：permission **decided** →
 * `decided:<agentSessionId>:<toolCallId>:<requestId>`（requestId 为
 * `dsh-acp-permission-<randomUUID >`，跨进程/跨重启唯一）；其余 →
 * `h:<sha256-16>`（canonical `[kind,time,payload]` 的键序无关稳定哈希），同会话内
 * 撞名追加 `-2/-3…` 序号。
 *
 * **decided 去重**（幂等语义不变）：待写 decided 的去重键已存在 → 跳过写入并
 * 正常 resolve（`INSERT OR IGNORE` + 影响行数兜底，先 SELECT 预检避免无谓消耗
 * seq）。只对 decided 去重：同 requestId 的 asked 重放是真实事件，审计如实各落
 * 一条；键缺任一分量的 decided 不参与去重（宁多落一条也不丢审计）。
 *
 * **binding 语义门槛（不变）** envelope 落库 ≠ binding 可用。
 * {@link AcpSidecar.readLatestBinding} 对 bindings 表最新 payload 做全字段语义校验
 * （{@link AcpBindingData} 全部必填字段）；不通过判 `{status:'outdated'}`（调用方
 * 映射 'binding-outdated'，绝不回退更早的 binding——索引表只有最新一条）。
 * binding 指纹的扩展分量一律 optional：
 * 缺席（旧版本写出的 binding）不判 outdated，由 profile-adapter.ts 的指纹 canonical 哈希
 * 预检以既有 'profile-changed' 阻断；字段在场时这里只做形态校验。
 *
 * ## 有界审计队列（有界审计队列）
 *
 * 同步 durable 路径（append 落库 commit 后才 resolve）：`binding`（recordBinding
 * fail-closed：binding 先于 prompt）与 `permission`（审批桥 fail-closed：append
 * reject → cancelled，见 src/domain/policy/permissions.ts）。其余 kind
 * （reconciliation/degradation/replay-assessment）进**有界
 * 内存队列**（上限 {@link ACP_SIDECAR_AUDIT_QUEUE_LIMIT}，默认 1024；满 → 丢弃
 * 新记录并 warn 计数，绝不阻塞 turn），microtask 批量事务落库；
 * {@link AcpSidecar.flush} 落齐全部排队记录（生产接线：AcpAgent turn 收束与
 * dispose 前调用）。读路径（list/readLatestBinding/listBindings）先
 * 落齐队列再查库——append → list 的可见性顺序与 JSONL 时代一致。队列是内存面：
 * 进程崩溃丢失未 flush 的非审批审计（可接受，设计既定）；binding/permission 不走
 * 队列，无此窗口。
 *
 * ## 权限位与生命周期
 *
 * 目录 `0700`；`sidecar.sqlite` 及 `-wal`/`-shm` `0600`（打开后显式 chmod 兜底——
 * SQLite 自建的 wal/shm 不吃 umask 之外的约束，flush/checkpoint 后复 chmod）。
 *
 * 宿主仍无插件可消费的会话删除钩子；sidecar 行的生命周期
 * 因此与 harness-home 一致。ACP 审计不随 DSH 官方 `/export`（Alpha 仍无
 * ignorable 事件 seam，DSH 自定义审计 seam 缺失）。
 *
 * stateRoot 来源：dsh 没有 per-profile 插件目录，惯例是 harness-home 全局
 * （settings-file、sessions 同在 `resolveDshHome()` 下，dev/prod 隔离靠
 * `DSH_HOME`）。app-boot `boot()` 在挂载插件树之前 `ctx.provide('dshHomePath',
 * dshHomePath)`（app-boot/src/index.ts:770），故 {@link installAcpSidecar} 用
 * host composition 的 widen-accessor 模式读该 slot；slot 缺席
 * （裸 Context 单测）返回 `undefined` 并 warn—— sidecar 是 ACP 会话的
 * 强制前提：缺席时 ACP 会话一律拒绝启动（fail loud，见
 * provider runtime），不再「退化为纯窥测」。
 *
 * @module @zaimokuza/dsh-acp-adapter/persistence/sidecar
 */

/// <reference types="node" />

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AcpDegradationAuditData,
  AcpPermissionAuditData,
  AcpTerminalAuditData,
  AcpSessionForkAuditData,
} from '../domain/policy/events.ts'
import {
  ACP_SNAPSHOT_TOTAL_BYTES,
  acpOptionsSnapshotOf,
  toOptionsSnapshotRecord,
} from './options-snapshot.ts'
import type { AcpOptionsSnapshotRecord } from './options-snapshot.ts'
import { redactSecretText } from '../domain/observability/redaction.ts'

// Compatibility facade: snapshot callers keep importing from sidecar while the
// bounded codec stays an independent persistence concern.
export {
  ACP_SNAPSHOT_FIELD_MAX,
  ACP_SNAPSHOT_OPTION_LIMIT,
  ACP_SNAPSHOT_TOTAL_BYTES,
  ACP_SNAPSHOT_VALUES_LIMIT,
  acpOptionsSnapshotOf,
  toOptionsSnapshotRecord,
} from './options-snapshot.ts'
export type { AcpOptionsSnapshotRecord, AcpOptionsSnapshotOption } from './options-snapshot.ts'

/** sidecar 记录格式版本（envelope 的 `schemaVersion`）。 */
export const ACP_SIDECAR_SCHEMA_VERSION = 2 as const

/** sidecar 单库文件名（`<root>/sidecar.sqlite`；WAL 旁生 `-wal`/`-shm`）。 */
export const ACP_SIDECAR_DB_FILENAME = 'sidecar.sqlite'

/**
 * 非审批审计内存队列上限：满 → 丢弃新记录并 warn 计数，绝不阻塞 turn。
 * 生产接线在 turn 收束与 dispose 前 {@link AcpSidecar.flush} 落齐。
 */
export const ACP_SIDECAR_AUDIT_QUEUE_LIMIT = 1024 as const

/** Activity presentation/detail bounds keep the journal safe to render and page. */
export const ACP_ACTIVITY_PRESENTATION_MAX = 2_048 as const
export const ACP_ACTIVITY_RAW_MAX = 16_384 as const
export const ACP_ACTIVITY_REF_MAX = 512 as const

/** Durable provider dispatch state. A committed `dispatch-uncertain` row is
 * intentionally visible after a host crash; a later request must not silently
 * replay the same ACP prompt. */
export type AcpDispatchState = 'dispatch-uncertain' | 'settled'
export interface AcpDispatchRecord {
  readonly key: string
  readonly dshSessionId: string
  readonly provider: string
  readonly model: string
  readonly state: AcpDispatchState
  readonly createdAt: number
  readonly settledAt?: number
  readonly provenance?: {
    readonly turn: number
    readonly step: number
    readonly startSeq: number
    readonly endSeq: number | null
    readonly anchorMessageId: string
    readonly acceptedMessageIds: readonly string[]
    /** Absent on rows written by older pre-release builds. */
    readonly projectionFiltered?: boolean
  }
}

export type AcpActivityKind = 'tool' | 'plan' | 'terminal' | 'diff' | 'resource' | 'delegated' | 'other'
export type AcpActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export interface AcpActivityRecord {
  readonly dshSessionId: string
  readonly ownerDshSessionId: string
  readonly promptAnchorMessageId: string
  readonly activityId: string
  /** Stable first-seen ordering used by the trajectory view. */
  readonly activitySeq: number
  /** Monotonic mutation cursor used by page/follow consumers. */
  readonly revisionSeq: number
  /** Last durable update time. */
  readonly time: number
  readonly kind: AcpActivityKind
  readonly status: AcpActivityStatus
  readonly presentation: string
  readonly rawDetail?: string
  readonly rawDetailRef?: string
}
export type AcpActivityInput = Omit<AcpActivityRecord, 'activitySeq' | 'revisionSeq'> & { readonly activitySeq?: number; readonly revisionSeq?: number }

/** Restricts an activity view to one owner/turn anchor.  Both fields are
 * optional so the host can ask for a whole session, but a client that renders
 * a single DSH turn should always provide the anchor. */
export interface AcpActivityFilter {
  readonly ownerDshSessionId?: string
  readonly promptAnchorMessageId?: string
}

/** Called only after the activity revision has committed in SQLite. */
export type AcpActivitySubscriber = (activity: AcpActivityRecord) => void

/**
 * secret-free 启动指纹：profile config 的 command/args 原样 +
 * **排序后的环境变量键名**（`envKeys` 绝不含值）。
 * 恢复预检时与当前 profile config 重组的指纹逐字段比较，不一致即 'profile-changed'。
 *
 * binding 中的扩展分量（组装真源：
 * src/domain/session/launch-fingerprint.ts）一律 **optional** 缺席 = 旧版本写出的
 * 指纹，不靠 readLatestBinding 判 outdated，而靠 canonical 哈希预检（新代码恒写出
 * 全部新键——N/A 记 null（canonical JSON 保留 null 键），旧 binding 缺键 → 哈希
 * 不等 → 既有 'profile-changed' 阻断）。字段在场时 readLatestBinding 只做形态校验。
 */
export interface AcpLaunchFingerprint {
  readonly command: string
  readonly args: readonly string[]
  readonly envKeys: readonly string[]
  /** Explicit profile env values, represented only by secret-free hashes. */
  readonly explicitEnv?: readonly { readonly key: string; readonly hash16: string }[]
 /** 边界：注册表 profile id。 */
  readonly profileId?: string | null
 /** 边界：descriptor 绑定 id（无 descriptor 记 null）。 */
  readonly descriptorId?: string | null
 /** 边界：descriptor versionPolicy 的声明钉版（不钉记 null）。 */
  readonly adapterVersion?: string | null
  readonly wrappedCliVersion?: string | null
 /** 边界：envRef 存在性（`{key,present}`，按 key 排序；无 descriptor 记 null）。 */
  readonly envRefs?: readonly { readonly key: string; readonly present: boolean }[] | null
 /** 边界：executable override env 的 `{name,present}`（无声明记 null）。 */
  readonly executableOverride?: { readonly name: string; readonly present: boolean } | null
  /** Native final state-location env shape: fixed keys, presence, and value hashes only. */
  readonly nativeStateEnv?: readonly { readonly key: string; readonly present: boolean; readonly hash16?: string }[] | null
  /** Legacy continuity slot; formal sessions write null because profile MCP injection was removed. */
  readonly mcpFingerprint?: string | null
}

/** initialize 握手回报的 agent 身份（`agentInfo`；未回报字段如实缺省）。 */
export interface AcpBindingAgentInfo {
  readonly name?: string
  readonly version?: string
}

/**
 * ACP binding：dsh sessionId → ACP 侧会话的绑定事实（resume 路由 marker-first 的
 * 依据）。`provider` 是路由 id（`acp-<id>`），`agentSessionId` 喂给 `session/load`。
 *
 * 下列字段**全部必填**（缺字段 = 不可用 binding，
 * {@link AcpSidecar.readLatestBinding} 判 `{status:'outdated'}`）：
 * - `dshCommittedSeq`：本 binding 担保的 DSH 日志已提交前缀上界（写 binding 时
 *   建立 turn 起点处的 `session.seq`；此后每个 turn 收束时刷新到最新日志尖）。
 *   重启对账以 `[historyBaseSeq, dshCommittedSeq)` 为期望可见历史的取材区间。
 * - `historyBaseSeq`：本 ACP 代际可见历史的起始 seq（全新建立 = 建立 turn 起点；
 *   load 续代 = 沿用被加载 binding 的值；rebindBlank 新代际 = 重开 turn 起点——
 *   显式放弃的旧 ACP 上下文不参与期望序列）。
 * - `generation`：每 dsh session 从 1 单调递增；每次 `session/new` 重建 +1
 *   （load 续代不变）。
 */
export interface AcpBindingData {
  readonly provider: string
  readonly agentSessionId: string
  /** 注册表 profile id（路由 `acp-<id>` 的 `<id>` 部分）。 */
  readonly profileId: string
  /** 建立时会话 cwd 的 canonical 形态（realpath）。 */
  readonly canonicalCwd: string
  readonly launchFingerprint: AcpLaunchFingerprint
  readonly agent: AcpBindingAgentInfo
  /** initialize 协商出的 ACP protocolVersion。 */
  readonly protocolVersion: number
  /** agentCapabilities canonical JSON 的 sha256-16（预检只记录不阻断；loadSession 缺席另有 'capability-missing'）。 */
  readonly capabilityHash: string
  /** configOptions（id+当前值）+ currentModeId canonical JSON 的 sha256-16（预检只记录不阻断）。 */
  readonly configHash: string
  readonly generation: number
  /** Monotonic marker separating ACP rebind generations. */
  readonly bindingEpoch: number
  /** Number of successfully committed ACP prompts represented by this binding. */
  readonly committedPromptOrdinal: number
  /** 本代际可见历史的起始 seq（含；见类型注释）。 */
  readonly historyBaseSeq: number
  /** 建立时间（epoch 毫秒）。 */
  readonly establishedAt: number
  /** 本 binding 担保的 DSH 已提交日志前缀上界（不含；见类型注释）。 */
  readonly dshCommittedSeq: number
}

/** {@link AcpSidecar.readLatestBinding} 的读出模型：最新一条合法 binding + 落盘时间。 */
export type AcpBindingRecord = AcpBindingData & { readonly time: number }

/**
 * {@link AcpSidecar.readLatestBinding} 的结果：最新 binding payload 语义校验通过 →
 * `{status:'ok'}`；存在 binding 行但缺 必填字段/语义畸形 →
 * `{status:'outdated'}`（不可用 binding，调用方映射 'binding-outdated'）；
 * 无 binding 行（或库不存在）→ `undefined`（与「不可用」明确区分）。
 */
export type AcpBindingLookup =
  | { readonly status: 'ok'; readonly binding: AcpBindingRecord }
  | { readonly status: 'outdated' }

/**
 * reconciliation-required 的原因词表（sidecar `reconciliation` 记录的
 * `cause` 字段 + turn 失败错误 `ACP_RECONCILIATION_REQUIRED` 的分类）：
 * - 预检不一致：`cwd-changed`/`profile-changed`/`agent-changed`/`protocol-changed`
 * - 恢复路径失败：`capability-missing`（未广告 loadSession）/`id-not-found`
 *   （list 确定 miss）/`load-failed`（load 抛错）
 * - 回放对账失败：`replay-overflow`（staging 缓冲溢出）/`replay-diverged`
 *   （回放与 DSH 前缀数量/顺序/内容不符）/`dsh-log-diverged`（DSH 日志在
 *   担保前缀之后还有非崩溃尾巴的可见事件）/`dsh-log-truncated`（DSH 可见历史
 *   短于 agent 回放）
 * - binding 不可用：`binding-in-use`（双绑守卫冲突）/`binding-missing`
 *   （日志有 ACP 历史但无 binding——sidecar 丢失）/`binding-outdated`
 * （binding 缺 必填字段）/`backend-conflict`（binding、日志或恢复请求的
 * execution provider 互相矛盾）
 */
export type AcpReconciliationCause =
  | 'cwd-changed'
  | 'profile-changed'
  | 'agent-changed'
  | 'protocol-changed'
  | 'capability-missing'
  | 'id-not-found'
  | 'load-failed'
  | 'replay-overflow'
  | 'replay-diverged'
  | 'dsh-log-diverged'
  | 'dsh-log-truncated'
  | 'binding-in-use'
  | 'binding-missing'
  | 'binding-outdated'
  | 'backend-conflict'

/** Durable current recovery state. Unlike the append-only audit stream this is
 * the small, directly readable state that survives refresh/restart and drives
 * the composer/recovery UI. */
export type AcpRecoveryStateKind =
  | 'healthy'
  | 'reconnect-required'
  | 'outcome-unknown'
  | 'reconciliation-required'
  | 'session-lost'
  | 'local-history-damaged'
  | 'resumed-unverified'

export interface AcpRecoveryState {
  readonly dshSessionId: string
  readonly kind: AcpRecoveryStateKind
  readonly cause?: string
  readonly detail?: string
  readonly provider?: string
  readonly acpSessionId?: string
  readonly generation?: number
  readonly interruptedTurnId?: string
  /** Last time the host attempted a non-healthy recovery transition. */
  readonly lastAttemptAt?: number
  /** Explicit user action, when the recovery surface records one. */
  readonly lastUserAction?: string
  readonly updatedAt: number
}

/**
 * `reconciliation` 记录的载荷：进入 reconciliation-required 的事实。
 * `detail` 是有界、无秘密的人类可读摘要（分叉 index 与两侧截断摘要等）；
 * `acpSessionId`（在场时）由 envelope 的 acpSessionId 冗余一份。
 */
export interface AcpReconciliationData {
  readonly cause: AcpReconciliationCause
  readonly detail?: string
  readonly acpSessionId?: string
  readonly generation?: number
}

/** Non-blocking result of comparing a session/load replay with DSH-visible history. */
export interface AcpReplayAssessmentData {
  readonly status: 'matched' | 'different' | 'overflow' | 'not-compared' | 'unavailable'
  readonly detail?: string
  readonly acpSessionId?: string
  readonly generation?: number
}

/** {@link AcpSidecar.listBindings} 的行项：一份有效 binding + 其所属 dsh sessionId（行键）。 */
export interface AcpBoundSessionBinding {
  readonly dshSessionId: string
  readonly binding: AcpBindingRecord
}

/**
 * v2 envelope 形态（`audit` 表行的逻辑视图）。字段语义见模块注释。
 */
interface AcpSidecarEnvelopeV2 {
  readonly schemaVersion: typeof ACP_SIDECAR_SCHEMA_VERSION
  readonly recordId: string
  readonly seq: number
  readonly time: number
  readonly kind: AcpSidecarKind
  readonly dshSessionId: string
  readonly acpProviderId?: string
  readonly acpSessionId?: string
  readonly payload: AcpSidecarPayloadByKind[AcpSidecarKind]
}

/** 统一读取模型的公共 envelope 字段。 */
interface AcpSidecarEntryBase {
  /** 记录格式版本（恒为 v2）。 */
  readonly schemaVersion: typeof ACP_SIDECAR_SCHEMA_VERSION
  /** 落盘时间（epoch 毫秒）。 */
  readonly time: number
  /** per session 单调序号。 */
  readonly seq: number
  /** 稳定记录 id（派生规则见模块注释）。 */
  readonly recordId: string
  /** 宿主 dsh 会话 id（行键）。 */
  readonly dshSessionId: string
  /** ACP provider 路由 id（`acp-<id>`）；仅 binding 行有（推导自 payload.provider）。 */
  readonly acpProviderId?: string
  /** ACP 侧会话 id；binding 恒有，permission asked/decided（此后）/ reconciliation（在场时）推导自 payload。 */
  readonly acpSessionId?: string
}

/**
 * sidecar 记录的 `kind` 全集（判别联合的判别值）：`binding`/`permission`、
 * `reconciliation`（恢复对账失败 → reconciliation-required 的事实记录，载荷见
 * {@link AcpReconciliationData}）； 新增 `degradation`（tool result 内容
 * 降级事实，载荷见 {@link AcpDegradationAuditData}）； 新增 `session-fork`
 *（DSH fork 是否调用 ACP session/fork 及受控降级原因，载荷见
 * {@link AcpSessionForkAuditData}）。
 */
export interface AcpFileSystemAuditData {
  readonly operation: 'read' | 'write'
  readonly path: string
  readonly bytes: number
  readonly beforeHash: string | null
  readonly afterHash: string | null
  readonly outcome: 'ok' | 'error' | 'aborted' | 'timeout' | 'concurrent-change'
  readonly acpSessionId: string
  readonly profileId: string
  /** Content-free failure classification for diagnosing agent read requests. */
  readonly reason?: string
  /** Original ACP read window when it was a safe integer. */
  readonly line?: number
  readonly limit?: number
}

export type AcpSidecarKind = 'binding' | 'permission' | 'reconciliation' | 'replay-assessment' | 'degradation' | 'filesystem' | 'terminal' | 'session-fork'

/** Single source of truth for sidecar kind → payload decoding/storage shape. */
export interface AcpSidecarPayloadByKind {
  binding: AcpBindingData
  permission: AcpPermissionAuditData
  reconciliation: AcpReconciliationData
  'replay-assessment': AcpReplayAssessmentData
  degradation: AcpDegradationAuditData
  filesystem: AcpFileSystemAuditData
  terminal: AcpTerminalAuditData
  'session-fork': AcpSessionForkAuditData
}

/** 写/读路径共同承认的 v2 kind 全集（行校验用）。 */
const ACP_SIDECAR_KINDS: readonly AcpSidecarKind[] = ['binding', 'permission', 'reconciliation', 'replay-assessment', 'degradation', 'filesystem', 'terminal', 'session-fork']

/**
 * 同步 durable 路径的 kind（有界审计队列）：append 落库 commit 后才 resolve。
 * - `binding`：binding 先于 prompt，见 src/host/composition/profile-adapter.ts；
 * - `permission`：审批桥 fail-closed（append reject → cancelled，见
 *   src/domain/policy/permissions.ts）。
 * `filesystem` 也同步落库：文件操作是已经发生的外部副作用，不能在队列尚未
 * flush 时向调用方返回成功。其余 kind 进有界内存队列（见
 * {@link ACP_SIDECAR_AUDIT_QUEUE_LIMIT}）。
 */
const ACP_SIDECAR_SYNC_KINDS: readonly AcpSidecarKind[] = ['binding', 'permission', 'filesystem', 'terminal', 'session-fork']

/**
 * 统一读取模型（判别联合，`kind` 判别）：`data` 访问器即落库 payload 的原内容
 * （内容消费契约不变，envelope 只是包装层）。
 */
export type AcpSidecarEntry = { [K in AcpSidecarKind]: AcpSidecarEntryBase & { readonly kind: K; readonly data: AcpSidecarPayloadByKind[K] } }[AcpSidecarKind]

/** {@link AcpSidecar.append} 的入参：`time` 可缺省（由 store 的 `now()` 补齐）。 */
export type AcpSidecarEntryInput = { [K in AcpSidecarKind]: { readonly kind: K; readonly time?: number; readonly data: AcpSidecarPayloadByKind[K] } }[AcpSidecarKind]

/** 补齐 `time` 后的待落盘记录（envelope 分量由 store 分配）。 */
type StampedEntry = { [K in AcpSidecarKind]: { readonly kind: K; readonly time: number; readonly data: AcpSidecarPayloadByKind[K] } }[AcpSidecarKind]

/**
 * sidecar 存储面（的唯一审计/binding 通道；SQLite WAL 承载）。
 *
 * 接口语义门槛（JSONL 时代钉版，本实现全数保持）：非法 sessionId **同步**抛
 * TypeError（契约违例，非运行时失败），I/O 失败才走 Promise 拒绝；
 * readLatestBinding 的 ok/outdated/undefined 三态；listBindings 只计入 ok。
 * SQLite 要么库损坏要么不损坏；库无法打开时 open 即 fail loud。
 */
export interface AcpSidecar {
  /** 存储根目录（`<dshHome>/dsh-acp`）。 */
  readonly root: string
  /**
   * 追加一条记录。`binding`/`permission` 同步落库 commit 后才 resolve（durable
   * 语义）；其余 kind 进有界内存队列、入队即 resolve（绝不阻塞 turn，flush 落齐，
   * 见模块注释「有界审计队列」）。幂等去重副作用：待写记录是 permission decided
   * 且同去重键的 decided 已存在 → **跳过本次写入并正常 resolve**——重连重放不
 * 生成重复决定（审批 correlation）。
   * @param sessionId - dsh 会话 id（行键；非法字符抛 TypeError）。
   * @param entry - 待落盘记录；`time` 缺省时由 store 时钟补齐。
   */
  append(sessionId: SessionId, entry: AcpSidecarEntryInput): Promise<void>
  /** Persist the dispatch uncertainty before crossing the ACP process boundary. */
  beginDispatch(record: AcpDispatchRecord): Promise<void>
  /** Mark a previously durable dispatch complete; idempotent for settled rows. */
  settleDispatch(sessionId: SessionId, key: string, settledAt?: number): Promise<void>
  /** Read a dispatch ledger row after restart. */
  readDispatch(sessionId: SessionId, key: string): Promise<AcpDispatchRecord | undefined>
  /** Explicitly resolve a user-reviewed uncertain dispatch without replaying it. */
  clearDispatch(sessionId: SessionId, key?: string): Promise<void>
  /** Upsert one external ACP activity, preserving its first-seen sequence. */
  upsertActivity(record: AcpActivityInput): Promise<AcpActivityRecord>
  /** Opening snapshot, ordered by stable first-seen activity sequence. */
  activitySnapshot(sessionId: SessionId, limit?: number, filter?: AcpActivityFilter): Promise<readonly AcpActivityRecord[]>
  /** Bounded activity revisions after a durable revision cursor. */
  activityPage(sessionId: SessionId, afterSeq: number, limit?: number, filter?: AcpActivityFilter): Promise<readonly AcpActivityRecord[]>
  /** Current durable activity head. */
  activityHead(sessionId: SessionId, filter?: AcpActivityFilter): Promise<number>
  /**
   * Read-only ownership proof for a cold activity source. A session is trusted
   * only when it has a valid persisted ACP binding or an activity row whose
   * durable owner is that same session; missing/corrupt stores return false or
   * reject rather than granting access.
   */
  hasDurableActivityOwner(sessionId: SessionId): Promise<boolean>
  /** Exact child ids created by the external-subagent projection bridge. */
  listProjectedSubagentIds(): Promise<readonly string[]>
  /** Durable projection rows used to converge an interrupted two-store commit. */
  listProjectedSubagentActivities(): Promise<readonly AcpActivityRecord[]>
  /** Subscribe to committed revisions. The returned disposer is idempotent. */
  subscribeActivity(sessionId: SessionId, filter: AcpActivityFilter, subscriber: AcpActivitySubscriber): () => void
  /**
 * 最新一条 binding 的判定（语义门槛）：bindings 索引行的 payload 全字段
   * 语义校验通过 → `{status:'ok', binding}`；不通过 → `{status:'outdated'}`
   * （**不回退**——索引表只保留最新一条，最新即权威）；无 binding 行/库不存在
   * → `undefined`（resume 回退 request/header 窥测的信号）。
   */
  readLatestBinding(sessionId: SessionId): Promise<AcpBindingLookup | undefined>
  /** Read the durable recovery state; missing rows mean healthy/never degraded. */
  readRecoveryState(sessionId: SessionId): Promise<AcpRecoveryState | undefined>
  /** Atomically replace the current recovery state for a DSH session. */
  writeRecoveryState(state: AcpRecoveryState): Promise<void>
  /**
 * 全量 binding 索引（双绑守卫的唯一消费点 = host composition 的
   * resume 路由）：查 bindings 表全部行，仅语义校验通过（`{status:'ok'}`）者计入
   * （畸形行跳过并 warn；库不存在 → 空数组）。
   */
  listBindings(): Promise<readonly AcpBoundSessionBinding[]>
  /** 该 sessionId 全量合法 entry（按 seq 升序；行级校验失败者跳过并 warn）；库不存在 → 空数组。 */
  list(sessionId: SessionId): Promise<readonly AcpSidecarEntry[]>
  /** Cursor-paged audit read. Only the requested bounded window is decoded. */
  listPage(sessionId: SessionId, afterSeq: number, limit: number): Promise<readonly AcpSidecarEntry[]>
  /**
 * 写入（upsert）该会话的 last-known option 快照（输入须先经
   * {@link acpOptionsSnapshotOf} 标准化）。同步 durable；写失败 reject
   * （调用方按「last-known 展示面」纪律降级为 warn，不翻转主链路）。
   */
  writeOptionSnapshot(sessionId: SessionId, snapshot: AcpOptionsSnapshotRecord): Promise<void>
  /** 读该会话的 last-known option 快照；无行/畸形 → `undefined`（畸形行 warn 一次）。 */
  readOptionSnapshot(sessionId: SessionId): Promise<AcpOptionsSnapshotRecord | undefined>
  /**
   * 落齐非审批审计队列：排队记录批量事务落库后做一轮 WAL checkpoint
   * （PASSIVE）并复 chmod wal/shm。生产接线：AcpAgent turn 收束与 dispose 前调用；
   * 读路径内部同样先落齐。队列空 → no-op。
   */
  flush(): Promise<void>
  /** 关闭存储：落齐队列 + WAL checkpoint（TRUNCATE）+ 关闭连接。幂等；之后的方法调用会按需重开库。 */
  dispose(): Promise<void>
}

/** {@link createAcpSidecar} 的构造项。 */
export interface AcpSidecarOptions {
  /** 存储根目录（调用方负责选址；生产为 `dshHomePath('dsh-acp')`）。 */
  readonly root: string
  /** 时钟（`time` 缺省补齐用；默认 `Date.now`，测试注入确定性）。 */
  readonly now?: (() => number) | undefined
  /** 诊断出口（行级校验失败计数、队列丢弃、库打开失败等；默认 noop）。 */
  readonly warn?: ((message: string) => void) | undefined
  /** 非审批审计队列上限（默认 {@link ACP_SIDECAR_AUDIT_QUEUE_LIMIT}；测试注入小队列）。 */
  readonly queueLimit?: number | undefined
}

/**
 * 行键安全边界（JSONL 时代是文件名边界，SQLite 时代保留为纵深防御与契约稳定）：
 * dsh SessionId 实为 ULID 风格安全串，但 sidecar 是持久化边界，不接受信任上游——
 * 白名单字符且排除 `.`/`..`，违例抛 TypeError。
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new TypeError(`dsh-acp sidecar: session id is not safe for storage: ${JSON.stringify(sessionId)}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRecoveryState(raw: unknown): AcpRecoveryState | undefined {
  if (!isPlainObject(raw) || typeof raw.dshSessionId !== 'string' || raw.dshSessionId.length === 0) return undefined
  const kinds: readonly string[] = ['healthy', 'reconnect-required', 'outcome-unknown', 'reconciliation-required', 'session-lost', 'local-history-damaged', 'resumed-unverified']
  if (typeof raw.kind !== 'string' || !kinds.includes(raw.kind)) return undefined
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined
  for (const key of ['cause', 'detail', 'provider', 'acpSessionId', 'interruptedTurnId'] as const) {
    if (key in raw && raw[key] !== undefined && typeof raw[key] !== 'string') return undefined
  }
  if ('generation' in raw && raw.generation !== undefined && (!Number.isInteger(raw.generation) || (raw.generation as number) < 0)) return undefined
  for (const key of ['lastAttemptAt'] as const) {
    if (key in raw && raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number))) return undefined
  }
  if ('lastUserAction' in raw && raw.lastUserAction !== undefined && (typeof raw.lastUserAction !== 'string' || raw.lastUserAction.length > 256)) return undefined
  return raw as unknown as AcpRecoveryState
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 payload 推导 envelope 的 acp 身份字段（可推导才落，不编造）：binding 恒有
 * provider+agentSessionId；permission 的 asked 与 decided 载荷均带 agentSessionId
 * （decided 也落——与 src/domain/policy/events.ts 的载荷定义对齐）；
 * reconciliation 仅 acpSessionId（在场时）；degradation 等 payload 无 acp
 * 身份可推导，恒 `{}`。
 * payload 语义畸形时缺省（语义校验是读路径消费方的事，写路径不抛）。
 */
function deriveAcpIds(
  kind: AcpSidecarKind,
  data: unknown,
): { acpProviderId?: string; acpSessionId?: string } {
  if (!isPlainObject(data)) return {}
  if (kind === 'binding') {
    const agentSessionId = typeof data.agentSessionId === 'string' && data.agentSessionId.length > 0 ? data.agentSessionId : undefined
    const provider = typeof data.provider === 'string' && data.provider.length > 0 ? data.provider : undefined
    return {
      ...(provider === undefined ? {} : { acpProviderId: provider }),
      ...(agentSessionId === undefined ? {} : { acpSessionId: agentSessionId }),
    }
  }
  if (kind === 'reconciliation') {
    const acpSessionId = typeof data.acpSessionId === 'string' && data.acpSessionId.length > 0 ? data.acpSessionId : undefined
    return acpSessionId === undefined ? {} : { acpSessionId }
  }
  if (kind === 'filesystem') {
    const acpSessionId = typeof data.acpSessionId === 'string' && data.acpSessionId.length > 0 ? data.acpSessionId : undefined
    return acpSessionId === undefined ? {} : { acpSessionId }
  }
  if (kind === 'terminal') {
    const acpSessionId = typeof data.acpSessionId === 'string' && data.acpSessionId.length > 0 ? data.acpSessionId : undefined
    return acpSessionId === undefined ? {} : { acpSessionId }
  }
  if (kind === 'session-fork') {
    const acpSessionId = typeof data.agentSessionId === 'string' && data.agentSessionId.length > 0 ? data.agentSessionId : undefined
    return acpSessionId === undefined ? {} : { acpSessionId }
  }
  if (kind !== 'permission') return {}
  const agentSessionId = typeof data.agentSessionId === 'string' && data.agentSessionId.length > 0 ? data.agentSessionId : undefined
  // asked 与 decided 均带 agentSessionId（decided 也落——见 events.ts），
  // 可推导即落 envelope acpSessionId。
  return agentSessionId === undefined ? {} : { acpSessionId: agentSessionId }
}

/**
 * canonical JSON（对象键排序递归；`undefined` 值的对象键跳过——与 JSON.stringify
 * 的落盘语义对齐）：recordId 内容哈希与 payload 列的稳定形态（与生产者键序无关）。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * canonical JSON 的 sha256 前 16 hex（binding 的 capabilityHash/configHash
 * 算法；与 recordId 的内容哈希同源，测试夹具用同一导出保证一致）。
 */
export function acpCanonicalHash16(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16)
}

/**
 * permission decided 载荷的去重/correlation 键：
 * `decided:<agentSessionId>:<toolCallId>:<requestId>`——ACP session + tool call +
 * request occurrence（requestId 为 randomUUID）三元组成；DSH session 分量即行键
 * （去重唯一索引按 `(dsh_session_id, dedupe_key)` 计）。非 decided 或任一分量
 * 缺失 → `undefined`（不去重，recordId 退化为内容哈希）。
 */
function decidedDedupeKeyOf(kind: string, data: unknown): string | undefined {
  if (kind !== 'permission' || !isPlainObject(data)) return undefined
  if (data.phase !== 'decided') return undefined
  const requestId = typeof data.requestId === 'string' && data.requestId.length > 0 ? data.requestId : undefined
  const agentSessionId = typeof data.agentSessionId === 'string' && data.agentSessionId.length > 0 ? data.agentSessionId : undefined
  const toolCallId = typeof data.toolCallId === 'string' && data.toolCallId.length > 0 ? data.toolCallId : undefined
  if (requestId === undefined || agentSessionId === undefined || toolCallId === undefined) return undefined
  return `decided:${agentSessionId}:${toolCallId}:${requestId}`
}

/** 非 decided 记录的 recordId 基座：`h:<sha256(canonical [kind,time,payload])>` 前 16 hex。 */
function contentRecordIdBase(kind: AcpSidecarKind, time: number, data: unknown): string {
  return `h:${createHash('sha256').update(stableStringify([kind, time, data])).digest('hex').slice(0, 16)}`
}

/** audit 表行（SELECT 的原始形态）。 */
interface AuditRow {
  readonly record_id: string
  readonly dsh_session_id: string
  readonly seq: number
  readonly time: number
  readonly kind: string
  readonly acp_provider_id: string | null
  readonly acp_session_id: string | null
  readonly dedupe_key: string | null
  readonly payload: string
}

/** bindings 表行。 */
interface BindingRow {
  readonly dsh_session_id: string
  readonly time: number
  readonly acp_provider_id: string | null
  readonly acp_session_id: string | null
  readonly payload: string
}

interface ActivityRow {
  readonly dsh_session_id?: unknown
  readonly activity_id?: unknown
  readonly owner_dsh_session_id?: unknown
  readonly prompt_anchor_message_id?: unknown
  readonly activity_seq?: unknown
  readonly revision_seq?: unknown
  readonly time?: unknown
  readonly kind?: unknown
  readonly status?: unknown
  readonly presentation?: unknown
  readonly raw_detail?: unknown
  readonly raw_detail_ref?: unknown
}

/** 排队中的非审批审计（seq 在入队时分配——与同步写的 seq 分配同源，保追加序）。 */
interface QueuedAudit {
  readonly sessionId: string
  readonly entry: StampedEntry
  readonly seq: number
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit (
  record_id TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  kind TEXT NOT NULL,
  acp_provider_id TEXT,
  acp_session_id TEXT,
  dedupe_key TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (dsh_session_id, record_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS audit_session_seq ON audit(dsh_session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS audit_session_dedupe ON audit(dsh_session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS bindings (
  dsh_session_id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  acp_provider_id TEXT,
  acp_session_id TEXT,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS option_snapshots (
  dsh_session_id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS recovery_states (
  dsh_session_id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_user_action TEXT,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS dispatch_ledger (
  dsh_session_id TEXT NOT NULL,
  dispatch_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  provenance TEXT,
  PRIMARY KEY (dsh_session_id, dispatch_key)
) STRICT;
CREATE TABLE IF NOT EXISTS activity_journal (
  dsh_session_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  owner_dsh_session_id TEXT NOT NULL,
  prompt_anchor_message_id TEXT NOT NULL,
  activity_seq INTEGER NOT NULL,
  revision_seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  presentation TEXT NOT NULL,
  raw_detail TEXT,
  raw_detail_ref TEXT,
  PRIMARY KEY (dsh_session_id, revision_seq)
) STRICT;
CREATE INDEX IF NOT EXISTS activity_session_id_revision_desc
  ON activity_journal(dsh_session_id, activity_id, revision_seq DESC);
CREATE INDEX IF NOT EXISTS activity_session_anchor_id_revision_desc
  ON activity_journal(dsh_session_id, prompt_anchor_message_id, activity_id, revision_seq DESC);
`

class SidecarStore implements AcpSidecar {
  readonly root: string
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly queueLimit: number
  /** 懒开库（读路径不建库；首个写/显式 flush 需要落库时才建）。 */
  private db: DatabaseSync | undefined
  private stmtInsert: StatementSync | undefined
  private stmtInsertIgnore: StatementSync | undefined
  private stmtMaxSeq: StatementSync | undefined
  private stmtHasRecordId: StatementSync | undefined
  private stmtHasDedupe: StatementSync | undefined
  private stmtList: StatementSync | undefined
  private stmtListPage: StatementSync | undefined
  private stmtGetBinding: StatementSync | undefined
  private stmtListBindings: StatementSync | undefined
  private stmtUpsertBinding: StatementSync | undefined
  private stmtGetOptionSnapshot: StatementSync | undefined
  private stmtUpsertOptionSnapshot: StatementSync | undefined
  private stmtGetDispatch: StatementSync | undefined
  private stmtInsertDispatch: StatementSync | undefined
  private stmtSettleDispatch: StatementSync | undefined
  private stmtClearDispatch: StatementSync | undefined
  private stmtDeleteDispatch: StatementSync | undefined
  private stmtActivityGet: StatementSync | undefined
  private stmtActivityInsert: StatementSync | undefined
  private stmtActivityUpdate: StatementSync | undefined
  private stmtActivityList: StatementSync | undefined
  private stmtActivityPage: StatementSync | undefined
  private stmtActivityHead: StatementSync | undefined
  private stmtGetRecoveryState: StatementSync | undefined
  private stmtUpsertRecoveryState: StatementSync | undefined
  /** per-session 下一个 seq（懒种子 = 库里 MAX(seq)+1；含队列已占号）。 */
  private readonly seqCounters = new Map<string, number>()
  private queue: QueuedAudit[] = []
  private queueDrainScheduled = false
  private queueFullWarned = false
  private droppedEntries = 0
  /** 旧 JSONL 残留的忽略提示每实例只 warn 一次。 */
  private legacyJsonlWarned = false
  /** In-process listeners are only a delivery optimization; SQLite remains the
   * source of truth and reconnecting consumers use activityPage to repair gaps. */
  private readonly activitySubscribers = new Map<string, Set<{ readonly filter: AcpActivityFilter; readonly subscriber: AcpActivitySubscriber }>>()

  constructor(options: AcpSidecarOptions) {
    this.root = options.root
    this.now = options.now ?? ((): number => Date.now())
    this.warn = options.warn ?? ((): void => undefined)
    this.queueLimit = options.queueLimit ?? ACP_SIDECAR_AUDIT_QUEUE_LIMIT
  }

  private get dbPath(): string {
    return path.join(this.root, ACP_SIDECAR_DB_FILENAME)
  }

  /**
   * 打开（或首建）库并备齐预编译 statement。fail loud：库文件损坏/无法打开时
   * CREATE TABLE 首触即抛（SQLITE_NOTADB/CANTOPEN）——warn 后原样上抛，读路径
   * 不再吞错继续（SQLite 没有「坏行」中间态）。
   */
  private ensureDb(): DatabaseSync {
    if (this.db !== undefined) return this.db
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    try {
      chmodSync(this.root, 0o700) // 既有目录兜底收紧
    } catch (error: unknown) {
      this.warn(`dsh-acp sidecar: failed to chmod 0700 on ${this.root} (${errorMessage(error)})`)
    }
    this.warnLegacyJsonl()
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.dbPath)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec(SCHEMA_SQL)
      // v2 databases predate the recovery columns/table. Migrate by schema
      // inspection so an old sidecar remains readable without a reset.
      const recoveryColumns = new Set((db.prepare('PRAGMA table_info(recovery_states)').all() as Array<{ name?: string }>).map((row) => row.name))
      if (!recoveryColumns.has('last_attempt_at')) db.exec('ALTER TABLE recovery_states ADD COLUMN last_attempt_at INTEGER')
      if (!recoveryColumns.has('last_user_action')) db.exec('ALTER TABLE recovery_states ADD COLUMN last_user_action TEXT')
      const dispatchColumns = new Set((db.prepare('PRAGMA table_info(dispatch_ledger)').all() as Array<{ name?: string }>).map((row) => row.name))
      if (!dispatchColumns.has('provenance')) db.exec('ALTER TABLE dispatch_ledger ADD COLUMN provenance TEXT')
      const activitySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activity_journal'").get() as { sql?: unknown } | undefined)?.sql
      if (typeof activitySql === 'string' && !activitySql.includes('PRIMARY KEY (dsh_session_id, revision_seq)')) {
        db.exec('ALTER TABLE activity_journal RENAME TO activity_journal_legacy')
        db.exec(`CREATE TABLE activity_journal (
          dsh_session_id TEXT NOT NULL, activity_id TEXT NOT NULL, owner_dsh_session_id TEXT NOT NULL,
          prompt_anchor_message_id TEXT NOT NULL, activity_seq INTEGER NOT NULL, revision_seq INTEGER NOT NULL,
          time INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, presentation TEXT NOT NULL,
          raw_detail TEXT, raw_detail_ref TEXT, PRIMARY KEY (dsh_session_id, revision_seq)
        ) STRICT`)
        const columns = new Set((db.prepare('PRAGMA table_info(activity_journal_legacy)').all() as Array<{ name?: string }>).map((row) => row.name))
        const time = columns.has('time') ? 'time' : '0'
        const revision = columns.has('revision_seq') ? 'revision_seq' : 'activity_seq'
        db.exec(`INSERT INTO activity_journal (dsh_session_id, activity_id, owner_dsh_session_id, prompt_anchor_message_id, activity_seq, revision_seq, time, kind, status, presentation, raw_detail, raw_detail_ref)
          SELECT dsh_session_id, activity_id, owner_dsh_session_id, prompt_anchor_message_id, activity_seq, ${revision}, ${time}, kind, status, presentation, raw_detail, raw_detail_ref FROM activity_journal_legacy`)
        db.exec('DROP TABLE activity_journal_legacy')
      }
    } catch (error: unknown) {
      try {
        db?.close()
      } catch (closeError: unknown) {
        this.warn(`dsh-acp sidecar: failed to close ${this.dbPath} after an open failure (${errorMessage(closeError)})`)
      }
      this.warn(`dsh-acp sidecar: failed to open ${this.dbPath} (${errorMessage(error)}); the sidecar store fails loud`)
      throw error
    }
    if (db === undefined) throw new Error(`dsh-acp sidecar: failed to open ${this.dbPath}`)
    this.db = db
    this.stmtInsert = db.prepare('INSERT INTO audit (record_id, dsh_session_id, seq, time, kind, acp_provider_id, acp_session_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtInsertIgnore = db.prepare('INSERT OR IGNORE INTO audit (record_id, dsh_session_id, seq, time, kind, acp_provider_id, acp_session_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtMaxSeq = db.prepare('SELECT MAX(seq) AS max_seq FROM audit WHERE dsh_session_id = ?')
    this.stmtHasRecordId = db.prepare('SELECT 1 AS x FROM audit WHERE dsh_session_id = ? AND record_id = ?')
    this.stmtHasDedupe = db.prepare('SELECT 1 AS x FROM audit WHERE dsh_session_id = ? AND dedupe_key = ?')
    this.stmtList = db.prepare('SELECT * FROM audit WHERE dsh_session_id = ? ORDER BY seq ASC')
    this.stmtListPage = db.prepare('SELECT * FROM audit WHERE dsh_session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    this.stmtGetBinding = db.prepare('SELECT * FROM bindings WHERE dsh_session_id = ?')
    this.stmtListBindings = db.prepare('SELECT * FROM bindings ORDER BY dsh_session_id ASC')
    this.stmtUpsertBinding = db.prepare('INSERT INTO bindings (dsh_session_id, time, acp_provider_id, acp_session_id, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, acp_provider_id = excluded.acp_provider_id, acp_session_id = excluded.acp_session_id, payload = excluded.payload')
    this.stmtGetOptionSnapshot = db.prepare('SELECT * FROM option_snapshots WHERE dsh_session_id = ?')
    this.stmtUpsertOptionSnapshot = db.prepare('INSERT INTO option_snapshots (dsh_session_id, time, payload) VALUES (?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, payload = excluded.payload')
    this.stmtGetDispatch = db.prepare('SELECT * FROM dispatch_ledger WHERE dsh_session_id = ? AND dispatch_key = ?')
    this.stmtInsertDispatch = db.prepare('INSERT INTO dispatch_ledger (dsh_session_id, dispatch_key, provider, model, state, created_at, settled_at, provenance) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
    this.stmtSettleDispatch = db.prepare('UPDATE dispatch_ledger SET state = ?, settled_at = ? WHERE dsh_session_id = ? AND dispatch_key = ? AND state = ?')
    this.stmtClearDispatch = db.prepare('DELETE FROM dispatch_ledger WHERE dsh_session_id = ? AND dispatch_key = ?')
    this.stmtDeleteDispatch = db.prepare('DELETE FROM dispatch_ledger WHERE dsh_session_id = ?')
    this.stmtActivityGet = db.prepare('SELECT * FROM activity_journal WHERE dsh_session_id = ? AND activity_id = ? ORDER BY revision_seq DESC LIMIT 1')
    this.stmtActivityInsert = db.prepare('INSERT INTO activity_journal (dsh_session_id, activity_id, owner_dsh_session_id, prompt_anchor_message_id, activity_seq, revision_seq, time, kind, status, presentation, raw_detail, raw_detail_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtActivityUpdate = this.stmtActivityInsert
    this.stmtActivityList = db.prepare('SELECT * FROM (SELECT activity_journal.*, ROW_NUMBER() OVER (PARTITION BY activity_id ORDER BY revision_seq DESC) AS latest_row FROM activity_journal WHERE dsh_session_id = ?) WHERE latest_row = 1 ORDER BY activity_seq ASC LIMIT ?')
    this.stmtActivityPage = db.prepare('SELECT * FROM activity_journal WHERE dsh_session_id = ? AND revision_seq > ? ORDER BY revision_seq ASC LIMIT ?')
    this.stmtActivityHead = db.prepare('SELECT COALESCE(MAX(revision_seq), 0) AS head FROM activity_journal WHERE dsh_session_id = ?')
    this.stmtGetRecoveryState = db.prepare('SELECT * FROM recovery_states WHERE dsh_session_id = ?')
    this.stmtUpsertRecoveryState = db.prepare('INSERT INTO recovery_states (dsh_session_id, time, last_attempt_at, last_user_action, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, last_attempt_at = excluded.last_attempt_at, last_user_action = excluded.last_user_action, payload = excluded.payload')
    try {
      chmodSync(this.dbPath, 0o600)
    } catch (error: unknown) {
      this.warn(`dsh-acp sidecar: failed to chmod 0600 on ${this.dbPath} (${errorMessage(error)})`)
    }
    this.chmodWalFiles()
    return db
  }

  /** 库已开 → 返回；未开但库文件在 → 打开；库文件不在 → undefined（读路径不建库）。 */
  private openIfExists(): DatabaseSync | undefined {
    if (this.db !== undefined) return this.db
    if (!existsSync(this.dbPath)) return undefined
    return this.ensureDb()
  }

  /** SQLite 自建的 -wal/-shm 不吃 umask 之外的约束：显式 chmod 0600 兜底（尽力，不推翻已完成的写）。 */
  private chmodWalFiles(): void {
    for (const suffix of ['-wal', '-shm']) {
      const file = `${this.dbPath}${suffix}`
      try {
        if (existsSync(file)) chmodSync(file, 0o600)
      } catch (error: unknown) {
        this.warn(`dsh-acp sidecar: failed to chmod 0600 on ${file} (${errorMessage(error)})`)
      }
    }
  }

  /** 取舍：root 下旧 `<sessionId>.jsonl` 一律忽略（不读不迁不删），warn 一次提示运维。 */
  private warnLegacyJsonl(): void {
    if (this.legacyJsonlWarned) return
    this.legacyJsonlWarned = true
    let legacy: string[]
    try {
      legacy = readdirSync(this.root).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return
    }
    if (legacy.length > 0) {
      this.warn(
        `dsh-acp sidecar: ignoring ${String(legacy.length)} legacy JSONL file(s) under ${this.root} ` +
        '(no migration layer by design; sessions without a SQLite binding will fail safe into reconciliation-required)',
      )
    }
  }

  /** 下一个 per-session seq（懒种子 = 库里 MAX(seq)+1）。 */
  private nextSeq(sessionId: string): number {
    let next = this.seqCounters.get(sessionId)
    if (next === undefined) {
      const row = this.stmtMaxSeq?.get(sessionId) as { max_seq: number | null } | undefined
      next = (row?.max_seq ?? 0) + 1
    }
    this.seqCounters.set(sessionId, next + 1)
    return next
  }

  /**
   * 同步落库（binding/permission 专用路径）：decided 先去重预检（已存在 → 跳过并
 * 正常返回， 幂等语义）；非 decided 的 recordId 撞名追加 -2/-3… 序号（先查
   * 后插，同进程同步执行无竞争）。binding 同时 upsert 最新索引表。
   */
  private insertSync(sessionId: string, entry: StampedEntry): void {
    const db = this.ensureDb()
    const ids = deriveAcpIds(entry.kind, entry.data)
    const dedupeKey = decidedDedupeKeyOf(entry.kind, entry.data)
    const payload = stableStringify(entry.data)
    if (dedupeKey !== undefined) {
      if (this.stmtHasDedupe?.get(sessionId, dedupeKey) !== undefined) return // 重连重放：已存在即跳过
      const seq = this.nextSeq(sessionId)
      const result = this.stmtInsertIgnore?.run(dedupeKey, sessionId, seq, entry.time, entry.kind, ids.acpProviderId ?? null, ids.acpSessionId ?? null, dedupeKey, payload)
      // 并发臂兜底（跨进程同键竞写）：IGNORE 生效 = 另一进程先落，同样按跳过处理
      if (result !== undefined && Number(result.changes) === 0) return
      return
    }
    if (entry.kind === 'binding') {
      // binding 是恢复索引，不是可被任意最新写覆盖的普通审计行。把迁移校验、
      // audit 追加和最新索引更新放进同一个 IMMEDIATE 事务：错误 provider 或错误
      // generation 即使来自另一进程，也不能先污染 audit 或覆盖正确索引。
      db.exec('BEGIN IMMEDIATE')
      try {
        this.assertBindingTransition(sessionId, entry)
        const { seq, recordId } = this.nextAuditIdentity(sessionId, entry)
        this.stmtInsert?.run(recordId, sessionId, seq, entry.time, entry.kind, ids.acpProviderId ?? null, ids.acpSessionId ?? null, null, payload)
        this.stmtUpsertBinding?.run(sessionId, entry.time, ids.acpProviderId ?? null, ids.acpSessionId ?? null, payload)
        db.exec('COMMIT')
      } catch (error: unknown) {
        try { db.exec('ROLLBACK') } catch { /* 原错误优先 */ }
        // nextSeq 的内存种子可能已在失败事务内前移；丢弃后从 durable MAX 重种。
        this.seqCounters.delete(sessionId)
        throw error
      }
      return
    }
    const { seq, recordId } = this.nextAuditIdentity(sessionId, entry)
    this.stmtInsert?.run(recordId, sessionId, seq, entry.time, entry.kind, ids.acpProviderId ?? null, ids.acpSessionId ?? null, null, payload)
  }

  /** 为一条非去重审计分配 seq 与无碰撞 record id。 */
  private nextAuditIdentity(sessionId: string, entry: StampedEntry): { seq: number; recordId: string } {
    const seq = this.nextSeq(sessionId)
    const base = contentRecordIdBase(entry.kind, entry.time, entry.data)
    let recordId = base
    for (let suffix = 2; ; suffix += 1) {
      if (this.stmtHasRecordId?.get(sessionId, recordId) === undefined) break
      recordId = `${base}-${String(suffix)}`
    }
    return { seq, recordId }
  }

  /**
   * binding 状态迁移门。数据库是最后一道恢复防线，不能只相信调用方的
   * TypeScript 类型：同代只允许推进日志锚点；新代只允许同 provider 的
   * rebindBlank，并且 generation 必须恰好 +1。校验与 upsert 位于同一个
   * `BEGIN IMMEDIATE` 事务内，因此并发进程也不能 last-writer-wins。
   */
  private assertBindingTransition(sessionId: string, entry: Extract<StampedEntry, { kind: 'binding' }>): void {
    const next = toBindingRecord(entry.time, entry.data)
    const row = this.stmtGetBinding?.get(sessionId) as BindingRow | undefined
    // 首条旧形状 binding 仍可被读取为 outdated，保留明确的恢复诊断；但一旦
    // 已有索引，任何畸形写都不得破坏一条可恢复 binding。
    if (row === undefined) return
    const current = this.parseBindingRow(row)
    if (current === undefined) {
      throw new Error(`dsh-acp sidecar: refusing to overwrite an outdated binding for session ${JSON.stringify(sessionId)}`)
    }
    if (next === undefined) {
      throw new Error(`dsh-acp sidecar: refusing to overwrite a valid binding with an invalid binding for session ${JSON.stringify(sessionId)}`)
    }
    if (current.provider !== next.provider) {
      throw new Error(
        `dsh-acp sidecar: execution backend for session ${JSON.stringify(sessionId)} is immutable ` +
        `(${JSON.stringify(current.provider)} cannot be replaced by ${JSON.stringify(next.provider)})`,
      )
    }
    if (current.profileId !== next.profileId) {
      throw new Error(`dsh-acp sidecar: refusing to change the ACP profile for session ${JSON.stringify(sessionId)}`)
    }
    if (next.generation === current.generation) {
      if (next.agentSessionId !== current.agentSessionId) {
        throw new Error(`dsh-acp sidecar: refusing to change the Agent session id without a new generation for session ${JSON.stringify(sessionId)}`)
      }
      if (next.historyBaseSeq !== current.historyBaseSeq || next.establishedAt !== current.establishedAt) {
        throw new Error(`dsh-acp sidecar: refusing to rewrite same-generation continuity anchors for session ${JSON.stringify(sessionId)}`)
      }
      if (next.dshCommittedSeq < current.dshCommittedSeq) {
        throw new Error(`dsh-acp sidecar: refusing to move the committed DSH sequence backwards for session ${JSON.stringify(sessionId)}`)
      }
      return
    }
    if (next.generation !== current.generation + 1) {
      throw new Error(`dsh-acp sidecar: binding generation must advance by exactly one for session ${JSON.stringify(sessionId)}`)
    }
    if (next.historyBaseSeq < current.dshCommittedSeq || next.establishedAt < current.establishedAt) {
      throw new Error(`dsh-acp sidecar: refusing a new binding generation with regressed continuity anchors for session ${JSON.stringify(sessionId)}`)
    }
  }

  /** 入队（非审批审计）：满 → 丢弃 + warn 计数（绝不阻塞 turn）。 */
  private enqueueAudit(sessionId: string, entry: StampedEntry): void {
    this.ensureDb() // open 失败 fail loud（与同步路径同门槛）；同时让 seq 计数器种子落位
    if (this.queue.length >= this.queueLimit) {
      this.droppedEntries += 1
      if (!this.queueFullWarned) {
        this.queueFullWarned = true
        this.warn(`dsh-acp sidecar: audit queue is full (limit ${String(this.queueLimit)}); dropping non-approval audit records (dropped ${String(this.droppedEntries)} so far)`)
      }
      return
    }
    this.queue.push({ sessionId, entry, seq: this.nextSeq(sessionId) })
    if (!this.queueDrainScheduled) {
      this.queueDrainScheduled = true
      queueMicrotask(() => {
        this.queueDrainScheduled = false
        this.drainQueue()
      })
    }
  }

  /** 队列批量落库（单事务）；失败 → 整批丢弃 + warn 计数（非审批审计不阻塞主链路）。 */
  private drainQueue(): void {
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    this.queueFullWarned = false
    const db = this.ensureDb()
    db.exec('BEGIN')
    try {
      for (const item of batch) {
        const ids = deriveAcpIds(item.entry.kind, item.entry.data)
        const base = contentRecordIdBase(item.entry.kind, item.entry.time, item.entry.data)
        let recordId = base
        for (let suffix = 2; ; suffix += 1) {
          if (this.stmtHasRecordId?.get(item.sessionId, recordId) === undefined) break
          recordId = `${base}-${String(suffix)}`
        }
        this.stmtInsert?.run(recordId, item.sessionId, item.seq, item.entry.time, item.entry.kind, ids.acpProviderId ?? null, ids.acpSessionId ?? null, null, stableStringify(item.entry.data))
      }
      db.exec('COMMIT')
    } catch (error: unknown) {
      try {
        db.exec('ROLLBACK')
      } catch { /* 连接级失败时 ROLLBACK 也可能抛，尽力而为 */ }
      this.droppedEntries += batch.length
      this.warn(`dsh-acp sidecar: failed to flush ${String(batch.length)} queued audit record(s); dropping them (${errorMessage(error)})`)
    }
  }

  /** WAL checkpoint + wal/shm 权限位兜底（flush/dispose 的周期 sync 点；维护性动作，失败仅 warn——已 commit 的数据不受影响）。 */
  private checkpoint(mode: 'PASSIVE' | 'TRUNCATE'): void {
    const db = this.openIfExists()
    if (db === undefined) return
    try {
      db.exec(`PRAGMA wal_checkpoint(${mode})`)
      this.chmodWalFiles()
    } catch (error: unknown) {
      this.warn(`dsh-acp sidecar: WAL checkpoint (${mode}) failed on ${this.dbPath} (${errorMessage(error)})`)
    }
  }

  append(sessionId: SessionId, entry: AcpSidecarEntryInput): Promise<void> {
    assertSafeSessionId(sessionId)
    const stamped: StampedEntry = {
      kind: entry.kind,
      time: entry.time ?? this.now(),
      data: entry.data,
    } as StampedEntry
    try {
      if (ACP_SIDECAR_SYNC_KINDS.includes(entry.kind)) this.insertSync(sessionId as string, stamped)
      else this.enqueueAudit(sessionId as string, stamped)
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  async beginDispatch(record: AcpDispatchRecord): Promise<void> {
    assertSafeSessionId(record.dshSessionId)
    if (record.state !== 'dispatch-uncertain') throw new TypeError('dsh-acp dispatch begin must use state dispatch-uncertain')
    if (record.key.length === 0 || record.key.length > 1024) throw new TypeError('dsh-acp dispatch key must be 1..1024 characters')
    if (record.provider.length === 0 || record.model.length === 0 || !Number.isSafeInteger(record.createdAt)) throw new TypeError('dsh-acp dispatch record is malformed')
    const provenance = record.provenance === undefined ? null : JSON.stringify(record.provenance)
    if (provenance !== null && provenance.length > 32_768) throw new TypeError('dsh-acp dispatch provenance exceeds 32 KiB')
    const db = this.ensureDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare('SELECT dispatch_key, state FROM dispatch_ledger WHERE dsh_session_id = ?').all(record.dshSessionId) as Array<{ dispatch_key?: unknown; state?: unknown }>
      for (const row of existing) {
        if (row.dispatch_key === record.key) throw new Error(`ACP_RECOVERY_REQUIRED: dispatch ${record.key} already exists`)
        if (row.state === 'dispatch-uncertain') throw new Error(`ACP_RECOVERY_REQUIRED: dispatch ${String(row.dispatch_key)} is dispatch-uncertain`)
      }
      db.prepare('DELETE FROM dispatch_ledger WHERE dsh_session_id = ?').run(record.dshSessionId)
      this.stmtInsertDispatch?.run(record.dshSessionId, record.key, record.provider, record.model, 'dispatch-uncertain', record.createdAt, provenance)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  async settleDispatch(dshSessionId: SessionId, key: string, settledAt: number = this.now()): Promise<void> {
    assertSafeSessionId(dshSessionId)
    const db = this.ensureDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.stmtGetDispatch?.get(dshSessionId, key) as { state?: unknown } | undefined
      if (existing === undefined) throw new Error(`ACP_LEDGER_MISSING: dispatch ${key} was not begun`)
      if (existing.state === 'settled') { db.exec('COMMIT'); return }
      const result = this.stmtSettleDispatch?.run('settled', settledAt, dshSessionId, key, 'dispatch-uncertain')
      if (Number(result?.changes ?? 0) !== 1) throw new Error(`ACP_LEDGER_STATE: dispatch ${key} was not uncertain`)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  readDispatch(dshSessionId: SessionId, key: string): Promise<AcpDispatchRecord | undefined> {
    assertSafeSessionId(dshSessionId)
    const row = this.openIfExists() === undefined ? undefined : this.stmtGetDispatch?.get(dshSessionId, key) as {
      dsh_session_id?: unknown; dispatch_key?: unknown; provider?: unknown; model?: unknown; state?: unknown; created_at?: unknown; settled_at?: unknown; provenance?: unknown
    } | undefined
    if (row === undefined || typeof row.dsh_session_id !== 'string' || typeof row.dispatch_key !== 'string' || typeof row.provider !== 'string' || typeof row.model !== 'string' || (row.state !== 'dispatch-uncertain' && row.state !== 'settled') || typeof row.created_at !== 'number') return Promise.resolve(undefined)
    let provenance: AcpDispatchRecord['provenance']
    if (typeof row.provenance === 'string') {
      try {
        const parsed = JSON.parse(row.provenance)
        if (isPlainObject(parsed)) provenance = parsed as AcpDispatchRecord['provenance']
      } catch { /* malformed provenance is omitted from diagnostics */ }
    }
    return Promise.resolve({ key: row.dispatch_key, dshSessionId: row.dsh_session_id, provider: row.provider, model: row.model, state: row.state, createdAt: row.created_at, ...(typeof row.settled_at === 'number' ? { settledAt: row.settled_at } : {}), ...(provenance === undefined ? {} : { provenance }) })
  }

  async clearDispatch(dshSessionId: SessionId, key?: string): Promise<void> {
    assertSafeSessionId(dshSessionId)
    if (key !== undefined && (key.length === 0 || key.length > 1024)) throw new TypeError('dsh-acp dispatch key must be 1..1024 characters')
    const db = this.openIfExists()
    if (db === undefined) return
    db.exec('BEGIN IMMEDIATE')
    try {
      if (key === undefined) this.stmtDeleteDispatch?.run(dshSessionId)
      else this.stmtClearDispatch?.run(dshSessionId, key)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve original */ }
      throw error
    }
  }

  async upsertActivity(record: AcpActivityInput): Promise<AcpActivityRecord> {
    assertSafeSessionId(record.dshSessionId)
    assertSafeSessionId(record.ownerDshSessionId)
    if (!isActivityKind(record.kind) || !isActivityStatus(record.status)) throw new TypeError('dsh-acp activity record has an unknown kind or status')
    if (record.activityId.length === 0 || record.activityId.length > 256) throw new TypeError('dsh-acp activity id must be 1..256 characters')
    if (record.promptAnchorMessageId.length === 0 || record.promptAnchorMessageId.length > 256) throw new TypeError('dsh-acp activity anchor must be 1..256 characters')
    if (!Number.isSafeInteger(record.time) || record.time < 0) throw new TypeError('dsh-acp activity time must be a non-negative safe integer')
    const presentation = boundedActivityText(record.presentation, ACP_ACTIVITY_PRESENTATION_MAX) ?? ''
    if (presentation.length === 0) throw new TypeError('dsh-acp activity presentation must not be empty')
    const rawDetail = boundedActivityText(redactActivityDetail(record.rawDetail), ACP_ACTIVITY_RAW_MAX)
    const rawDetailRef = boundedActivityText(record.rawDetailRef, ACP_ACTIVITY_REF_MAX)
    const db = this.ensureDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.stmtActivityGet?.get(record.dshSessionId, record.activityId) as ActivityRow | undefined
      if (existing !== undefined) {
        const current = rowToActivity(existing)
        if (current === undefined) throw new Error(`ACP_ACTIVITY_CORRUPT: activity ${record.activityId} is malformed`)
        if (record.ownerDshSessionId !== current.ownerDshSessionId || record.promptAnchorMessageId !== current.promptAnchorMessageId || record.kind !== current.kind) throw new Error(`ACP_ACTIVITY_IMMUTABLE: activity ${record.activityId} owner, anchor, and kind cannot change`)
        if (isTerminalActivityStatus(current.status) && record.status === 'running') throw new Error(`ACP_ACTIVITY_STATE: terminal activity ${record.activityId} cannot return to running`)
        const revisionSeq = Number((this.stmtActivityHead?.get(record.dshSessionId) as { head?: number | bigint } | undefined)?.head ?? 0) + 1
        this.stmtActivityUpdate?.run(
          record.dshSessionId,
          record.activityId,
          current.ownerDshSessionId,
          current.promptAnchorMessageId,
          current.activitySeq,
          revisionSeq,
          record.time,
          record.kind,
          record.status,
          presentation,
          rawDetail ?? null,
          rawDetailRef ?? null,
        )
        db.exec('COMMIT')
        const committed = { ...current, revisionSeq, time: record.time, status: record.status, presentation, ...(rawDetail === undefined ? {} : { rawDetail }), ...(rawDetailRef === undefined ? {} : { rawDetailRef }) }
        this.notifyActivitySubscribers(committed)
        return committed
      }
      const firstSeenHead = Number((db.prepare('SELECT COALESCE(MAX(activity_seq), 0) AS head FROM activity_journal WHERE dsh_session_id = ?').get(record.dshSessionId) as { head?: number | bigint } | undefined)?.head ?? 0)
      const revisionHead = Number((this.stmtActivityHead?.get(record.dshSessionId) as { head?: number | bigint } | undefined)?.head ?? 0)
      const activitySeq = firstSeenHead + 1
      const revisionSeq = revisionHead + 1
      this.stmtActivityInsert?.run(record.dshSessionId, record.activityId, record.ownerDshSessionId, record.promptAnchorMessageId, activitySeq, revisionSeq, record.time, record.kind, record.status, presentation, rawDetail ?? null, rawDetailRef ?? null)
      db.exec('COMMIT')
      const committed = { dshSessionId: record.dshSessionId, ownerDshSessionId: record.ownerDshSessionId, promptAnchorMessageId: record.promptAnchorMessageId, activityId: record.activityId, activitySeq, revisionSeq, time: record.time, kind: record.kind, status: record.status, presentation, ...(rawDetail === undefined ? {} : { rawDetail }), ...(rawDetailRef === undefined ? {} : { rawDetailRef }) }
      this.notifyActivitySubscribers(committed)
      return committed
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  activitySnapshot(sessionId: SessionId, limit = 100, filter?: AcpActivityFilter): Promise<readonly AcpActivityRecord[]> {
    assertSafeSessionId(sessionId)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('dsh-acp activity limit must be a positive integer')
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (filter === undefined || (filter.ownerDshSessionId === undefined && filter.promptAnchorMessageId === undefined))
        ? (this.stmtActivityList?.all(sessionId, Math.min(limit, 200)) ?? []) as unknown as ActivityRow[]
        : this.activitySnapshotRows(db, sessionId, Math.min(limit, 200), filter)
      return Promise.resolve(rows.map(rowToActivity).filter((row): row is AcpActivityRecord => row !== undefined))
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error))) }
  }

  activityPage(sessionId: SessionId, afterSeq: number, limit = 100, filter?: AcpActivityFilter): Promise<readonly AcpActivityRecord[]> {
    assertSafeSessionId(sessionId)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('dsh-acp activity cursor must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('dsh-acp activity limit must be a positive integer')
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (filter === undefined || (filter.ownerDshSessionId === undefined && filter.promptAnchorMessageId === undefined))
        ? (this.stmtActivityPage?.all(sessionId, afterSeq, Math.min(limit, 200)) ?? []) as unknown as ActivityRow[]
        : this.activityPageRows(db, sessionId, afterSeq, Math.min(limit, 200), filter)
      return Promise.resolve(rows.map(rowToActivity).filter((row): row is AcpActivityRecord => row !== undefined))
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error))) }
  }

  activityHead(sessionId: SessionId, filter?: AcpActivityFilter): Promise<number> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve(0)
      if (filter === undefined || (filter.ownerDshSessionId === undefined && filter.promptAnchorMessageId === undefined)) {
        return Promise.resolve(Number((this.stmtActivityHead?.get(sessionId) as { head?: number | bigint } | undefined)?.head ?? 0))
      }
      return Promise.resolve(Number((this.activityHeadRow(db, sessionId, filter) as { head?: number | bigint } | undefined)?.head ?? 0))
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error))) }
  }

  async hasDurableActivityOwner(sessionId: SessionId): Promise<boolean> {
    assertSafeSessionId(sessionId)
    // A valid binding is the strongest persisted owner fact and also covers a
    // newly-created ACP session before its first activity row is committed.
    const binding = await this.readLatestBinding(sessionId)
    if (binding?.status === 'ok') return true
    const db = this.openIfExists()
    if (db === undefined) return false
    try {
      const row = db.prepare(
        'SELECT 1 AS present FROM activity_journal WHERE dsh_session_id = ? AND owner_dsh_session_id = ? LIMIT 1',
      ).get(sessionId, sessionId) as { present?: number } | undefined
      return row?.present === 1
    } catch (error) {
      throw error instanceof Error ? error : new Error(errorMessage(error))
    }
  }

  async listProjectedSubagentIds(): Promise<readonly string[]> {
    const db = this.openIfExists()
    if (db === undefined) return []
    const rows = db.prepare(
      'SELECT DISTINCT dsh_session_id FROM activity_journal WHERE prompt_anchor_message_id = ? ORDER BY dsh_session_id ASC',
    ).all('external-subagent-record') as Array<{ dsh_session_id?: unknown }>
    return rows.flatMap(row => typeof row.dsh_session_id === 'string' ? [row.dsh_session_id] : [])
  }

  async listProjectedSubagentActivities(): Promise<readonly AcpActivityRecord[]> {
    const db = this.openIfExists()
    if (db === undefined) return []
    const rows = db.prepare(
      `SELECT * FROM (
        SELECT activity_journal.*, ROW_NUMBER() OVER (
          PARTITION BY dsh_session_id, activity_id ORDER BY revision_seq DESC
        ) AS latest_row
        FROM activity_journal WHERE prompt_anchor_message_id = ?
      ) WHERE latest_row = 1 ORDER BY dsh_session_id ASC, activity_seq ASC`,
    ).all('external-subagent-record') as unknown as ActivityRow[]
    return rows.map(rowToActivity).filter((row): row is AcpActivityRecord => row !== undefined)
  }

  subscribeActivity(sessionId: SessionId, filter: AcpActivityFilter, subscriber: AcpActivitySubscriber): () => void {
    assertSafeSessionId(sessionId)
    validateActivityFilter(filter)
    if (typeof subscriber !== 'function') throw new TypeError('dsh-acp activity subscriber must be a function')
    const entry = { filter: { ...filter }, subscriber }
    let listeners = this.activitySubscribers.get(sessionId as string)
    if (listeners === undefined) {
      listeners = new Set()
      this.activitySubscribers.set(sessionId as string, listeners)
    }
    listeners.add(entry)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      listeners?.delete(entry)
      if (listeners?.size === 0) this.activitySubscribers.delete(sessionId as string)
    }
  }

  private notifyActivitySubscribers(activity: AcpActivityRecord): void {
    const listeners = this.activitySubscribers.get(activity.dshSessionId)
    if (listeners === undefined) return
    for (const { filter, subscriber } of listeners) {
      if (!activityMatchesFilter(activity, filter)) continue
      try { subscriber(activity) } catch (error) { this.warn(`dsh-acp activity subscriber failed: ${errorMessage(error)}`) }
    }
  }

  private activitySnapshotRows(db: DatabaseSync, sessionId: SessionId, limit: number, filter: AcpActivityFilter): ActivityRow[] {
    const { where, params } = activityFilterSql(sessionId, filter)
    return db.prepare(`SELECT * FROM (SELECT activity_journal.*, ROW_NUMBER() OVER (PARTITION BY activity_id ORDER BY revision_seq DESC) AS latest_row FROM activity_journal WHERE ${where}) WHERE latest_row = 1 ORDER BY activity_seq ASC LIMIT ?`).all(...params, limit) as unknown as ActivityRow[]
  }

  private activityPageRows(db: DatabaseSync, sessionId: SessionId, afterSeq: number, limit: number, filter: AcpActivityFilter): ActivityRow[] {
    const { where, params } = activityFilterSql(sessionId, filter)
    return db.prepare(`SELECT * FROM activity_journal WHERE ${where} AND revision_seq > ? ORDER BY revision_seq ASC LIMIT ?`).all(...params, afterSeq, limit) as unknown as ActivityRow[]
  }

  private activityHeadRow(db: DatabaseSync, sessionId: SessionId, filter: AcpActivityFilter): unknown {
    const { where, params } = activityFilterSql(sessionId, filter)
    return db.prepare(`SELECT COALESCE(MAX(revision_seq), 0) AS head FROM activity_journal WHERE ${where}`).get(...params)
  }

  flush(): Promise<void> {
    try {
      this.drainQueue()
      this.checkpoint('PASSIVE')
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  dispose(): Promise<void> {
    try {
      this.activitySubscribers.clear()
      this.drainQueue()
      this.checkpoint('TRUNCATE')
      if (this.db !== undefined) {
        this.db.close()
        this.db = undefined
      }
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  readLatestBinding(sessionId: SessionId): Promise<AcpBindingLookup | undefined> {
    assertSafeSessionId(sessionId)
    try {
      this.drainQueue() // 读前落齐：append → read 的可见性顺序与 JSONL 时代一致
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve(undefined)
      const row = this.stmtGetBinding?.get(sessionId) as BindingRow | undefined
      if (row === undefined) return Promise.resolve(undefined)
      const record = this.parseBindingRow(row)
      if (record === undefined) {
        this.warn(`dsh-acp sidecar: latest binding row for session ${JSON.stringify(sessionId as string)} fails semantic validation; binding is outdated`)
        return Promise.resolve({ status: 'outdated' })
      }
      return Promise.resolve({ status: 'ok', binding: record })
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  readRecoveryState(sessionId: SessionId): Promise<AcpRecoveryState | undefined> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve(undefined)
      const row = this.stmtGetRecoveryState?.get(sessionId) as { payload: string } | undefined
      if (row === undefined) return Promise.resolve(undefined)
      let payload: unknown
      try { payload = JSON.parse(row.payload) } catch { payload = undefined }
      const state = toRecoveryState(payload)
      if (state === undefined || state.dshSessionId !== (sessionId as string)) {
        throw new Error(`dsh-acp sidecar: recovery state for session ${JSON.stringify(sessionId as string)} is malformed; local recovery history is damaged`)
      }
      return Promise.resolve(state)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  writeRecoveryState(state: AcpRecoveryState): Promise<void> {
    assertSafeSessionId(state.dshSessionId)
    const validated = toRecoveryState(state)
    if (validated === undefined) throw new TypeError(`dsh-acp sidecar: malformed recovery state for session ${JSON.stringify(state.dshSessionId)}`)
    try {
      const db = this.ensureDb()
      db.exec('BEGIN IMMEDIATE')
      try {
        this.stmtUpsertRecoveryState?.run(
          validated.dshSessionId,
          validated.updatedAt,
          validated.lastAttemptAt ?? null,
          validated.lastUserAction ?? null,
          stableStringify(validated),
        )
        db.exec('COMMIT')
      } catch (error: unknown) {
        try { db.exec('ROLLBACK') } catch { /* preserve original failure */ }
        throw error
      }
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  listBindings(): Promise<readonly AcpBoundSessionBinding[]> {
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (this.stmtListBindings?.all() ?? []) as unknown as BindingRow[]
      const bound: AcpBoundSessionBinding[] = []
      let skipped = 0
      for (const row of rows) {
        const record = this.parseBindingRow(row)
        if (record === undefined) {
          skipped += 1
          continue
        }
        bound.push({ dshSessionId: row.dsh_session_id, binding: record })
      }
      if (skipped > 0) this.warn(`dsh-acp sidecar: skipped ${String(skipped)} outdated binding row(s) in the bindings index`)
      return Promise.resolve(bound)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  list(sessionId: SessionId): Promise<readonly AcpSidecarEntry[]> {
    assertSafeSessionId(sessionId)
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (this.stmtList?.all(sessionId) ?? []) as unknown as AuditRow[]
      const entries: AcpSidecarEntry[] = []
      let skipped = 0
      for (const row of rows) {
        const entry = rowToEntry(row)
        if (entry === undefined) skipped += 1
        else entries.push(entry)
      }
      if (skipped > 0) this.warn(`dsh-acp sidecar: skipped ${String(skipped)} malformed audit row(s) for session ${JSON.stringify(sessionId as string)}`)
      return Promise.resolve(entries)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  listPage(sessionId: SessionId, afterSeq: number, limit: number): Promise<readonly AcpSidecarEntry[]> {
    assertSafeSessionId(sessionId)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('dsh-acp sidecar: audit cursor must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('dsh-acp sidecar: audit page size must be between 1 and 100')
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (this.stmtListPage?.all(sessionId, afterSeq, limit) ?? []) as unknown as AuditRow[]
      const entries: AcpSidecarEntry[] = []
      let skipped = 0
      for (const row of rows) {
        const entry = rowToEntry(row)
        if (entry === undefined) skipped += 1
        else entries.push(entry)
      }
      if (skipped > 0) this.warn(`dsh-acp sidecar: skipped ${String(skipped)} malformed audit row(s) in page for session ${JSON.stringify(sessionId as string)}`)
      return Promise.resolve(entries)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  writeOptionSnapshot(sessionId: SessionId, snapshot: AcpOptionsSnapshotRecord): Promise<void> {
    assertSafeSessionId(sessionId)
    const validated = toOptionsSnapshotRecord(snapshot)
    if (validated === undefined) {
      throw new TypeError(`dsh-acp sidecar: malformed option snapshot for session ${JSON.stringify(sessionId as string)}`)
    }
    const payload = stableStringify(validated)
    if (payload.length > ACP_SNAPSHOT_TOTAL_BYTES) {
      throw new TypeError(`dsh-acp sidecar: option snapshot for session ${JSON.stringify(sessionId as string)} exceeds the ${String(ACP_SNAPSHOT_TOTAL_BYTES)}-byte bound (${String(payload.length)}); pass it through acpOptionsSnapshotOf first`)
    }
    try {
      this.ensureDb()
      this.stmtUpsertOptionSnapshot?.run(sessionId, this.now(), payload)
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  readOptionSnapshot(sessionId: SessionId): Promise<AcpOptionsSnapshotRecord | undefined> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve(undefined)
      const row = this.stmtGetOptionSnapshot?.get(sessionId) as { payload: string } | undefined
      if (row === undefined) return Promise.resolve(undefined)
      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        payload = undefined
      }
      const record = toOptionsSnapshotRecord(payload)
      if (record === undefined) {
        this.warn(`dsh-acp sidecar: option snapshot row for session ${JSON.stringify(sessionId as string)} is malformed; ignoring it`)
        return Promise.resolve(undefined)
      }
      return Promise.resolve(record)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

 /** bindings 行 → 全字段语义校验 + 窄化（不通过 → undefined = outdated）。 */
  private parseBindingRow(row: BindingRow): AcpBindingRecord | undefined {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      return undefined
    }
    return toBindingRecord(row.time, payload)
  }
}

/**
 * audit 行 → 统一读取模型（行级校验：known kind / seq 正整数 / recordId 非空 /
 * dshSessionId 非空 / payload 可 parse 且 plain-object；败者 undefined 由调用方
 * 跳过 + warn——读路径的行级容错门槛与 JSONL 时代的坏行跳过等价）。
 */
function rowToEntry(row: AuditRow): AcpSidecarEntry | undefined {
  const envelope = rowToEnvelope(row)
  if (envelope === undefined) return undefined
  return {
    schemaVersion: ACP_SIDECAR_SCHEMA_VERSION,
    recordId: envelope.recordId,
    seq: envelope.seq,
    kind: envelope.kind,
    time: envelope.time,
    dshSessionId: envelope.dshSessionId,
    ...(envelope.acpProviderId === undefined ? {} : { acpProviderId: envelope.acpProviderId }),
    ...(envelope.acpSessionId === undefined ? {} : { acpSessionId: envelope.acpSessionId }),
    data: envelope.payload,
  } as unknown as AcpSidecarEntry
}

const ACP_ACTIVITY_KINDS: readonly AcpActivityKind[] = ['tool', 'plan', 'terminal', 'diff', 'resource', 'delegated', 'other']
const ACP_ACTIVITY_STATUSES: readonly AcpActivityStatus[] = ['running', 'completed', 'failed', 'cancelled']

function isActivityKind(value: unknown): value is AcpActivityKind {
  return typeof value === 'string' && ACP_ACTIVITY_KINDS.includes(value as AcpActivityKind)
}

function isActivityStatus(value: unknown): value is AcpActivityStatus {
  return typeof value === 'string' && ACP_ACTIVITY_STATUSES.includes(value as AcpActivityStatus)
}

function isTerminalActivityStatus(value: AcpActivityStatus): boolean {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

function validateActivityFilter(filter: AcpActivityFilter): void {
  if (filter === null || typeof filter !== 'object') throw new TypeError('dsh-acp activity filter must be an object')
  for (const [name, value] of Object.entries(filter)) {
    if (name !== 'ownerDshSessionId' && name !== 'promptAnchorMessageId') throw new TypeError(`dsh-acp activity filter has unknown field ${name}`)
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 256)) throw new TypeError(`dsh-acp activity filter ${name} must be 1..256 characters`)
  }
}

function activityMatchesFilter(activity: AcpActivityRecord, filter: AcpActivityFilter): boolean {
  return (filter.ownerDshSessionId === undefined || activity.ownerDshSessionId === filter.ownerDshSessionId)
    && (filter.promptAnchorMessageId === undefined || activity.promptAnchorMessageId === filter.promptAnchorMessageId)
}

function activityFilterSql(sessionId: SessionId, filter: AcpActivityFilter): { where: string; params: string[] } {
  validateActivityFilter(filter)
  const clauses = ['dsh_session_id = ?']
  const params: string[] = [sessionId as string]
  if (filter.ownerDshSessionId !== undefined) {
    clauses.push('owner_dsh_session_id = ?')
    params.push(filter.ownerDshSessionId)
  }
  if (filter.promptAnchorMessageId !== undefined) {
    clauses.push('prompt_anchor_message_id = ?')
    params.push(filter.promptAnchorMessageId)
  }
  return { where: clauses.join(' AND '), params }
}

function boundedActivityText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max - 15)}… [truncated]`
}

/** Defense in depth for callers other than the built-in adapter. */
function redactActivityDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    const redact = (item: unknown, depth: number): unknown => {
      if (depth > 5) return '[nested value omitted]'
      if (Array.isArray(item)) return item.slice(0, 64).map((entry) => redact(entry, depth + 1))
      if (typeof item === 'string') return redactSecretText(item)
      if (isPlainObject(item)) {
        const output: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(item).slice(0, 128)) output[key] = /(?:token|secret|password|authorization|api[_-]?key|cookie|credential)/i.test(key) ? '[redacted]' : redact(entry, depth + 1)
        return output
      }
      return item
    }
    return JSON.stringify(redact(parsed, 0))
  } catch {
    return redactSecretText(value)
  }
}

function rowToActivity(row: ActivityRow): AcpActivityRecord | undefined {
  if (typeof row.dsh_session_id !== 'string' || typeof row.activity_id !== 'string' || typeof row.owner_dsh_session_id !== 'string' || typeof row.prompt_anchor_message_id !== 'string' || typeof row.activity_seq !== 'number' || !Number.isSafeInteger(row.activity_seq) || row.activity_seq < 1 || typeof row.revision_seq !== 'number' || !Number.isSafeInteger(row.revision_seq) || row.revision_seq < 1 || typeof row.time !== 'number' || !Number.isSafeInteger(row.time) || row.time < 0 || !isActivityKind(row.kind) || !isActivityStatus(row.status) || typeof row.presentation !== 'string') return undefined
  if (row.raw_detail !== null && row.raw_detail !== undefined && typeof row.raw_detail !== 'string') return undefined
  if (row.raw_detail_ref !== null && row.raw_detail_ref !== undefined && typeof row.raw_detail_ref !== 'string') return undefined
  return {
    dshSessionId: row.dsh_session_id,
    ownerDshSessionId: row.owner_dsh_session_id,
    promptAnchorMessageId: row.prompt_anchor_message_id,
    activityId: row.activity_id,
    activitySeq: row.activity_seq,
    revisionSeq: row.revision_seq,
    time: row.time,
    kind: row.kind,
    status: row.status,
    presentation: row.presentation,
    ...(row.raw_detail === undefined || row.raw_detail === null ? {} : { rawDetail: row.raw_detail }),
    ...(row.raw_detail_ref === undefined || row.raw_detail_ref === null ? {} : { rawDetailRef: row.raw_detail_ref }),
  }
}

/** audit 行 → v2 envelope（export/list 共用；行级校验败者 undefined）。 */
function rowToEnvelope(row: AuditRow): AcpSidecarEnvelopeV2 | undefined {
  if (!ACP_SIDECAR_KINDS.includes(row.kind as AcpSidecarKind)) return undefined
  if (typeof row.time !== 'number' || !Number.isFinite(row.time)) return undefined
  if (typeof row.seq !== 'number' || !Number.isInteger(row.seq) || row.seq < 1) return undefined
  if (typeof row.record_id !== 'string' || row.record_id.length === 0) return undefined
  if (typeof row.dsh_session_id !== 'string' || row.dsh_session_id.length === 0) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return undefined
  }
  if (!isPlainObject(payload)) return undefined
  return {
    schemaVersion: ACP_SIDECAR_SCHEMA_VERSION,
    recordId: row.record_id,
    seq: row.seq,
    time: row.time,
    kind: row.kind as AcpSidecarKind,
    dshSessionId: row.dsh_session_id,
    ...(row.acp_provider_id === null ? {} : { acpProviderId: row.acp_provider_id }),
    ...(row.acp_session_id === null ? {} : { acpSessionId: row.acp_session_id }),
    payload: payload as unknown as AcpSidecarEnvelopeV2['payload'],
  }
}

/**
 * binding data 的 全字段语义校验 + 窄化（门槛见模块注释「binding 语义
 * 门槛」）；任何字段违例 → `undefined`（该记录按不可用 binding 处理）。
 */
function toBindingRecord(time: number, raw: unknown): AcpBindingRecord | undefined {
  if (!isPlainObject(raw)) return undefined
  const {
    provider, agentSessionId, profileId, canonicalCwd,
    launchFingerprint, agent, protocolVersion, capabilityHash, configHash,
    generation, bindingEpoch, committedPromptOrdinal, historyBaseSeq, establishedAt, dshCommittedSeq,
  } = raw
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof agentSessionId !== 'string' || agentSessionId.length === 0) return undefined
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined
  if (typeof canonicalCwd !== 'string' || canonicalCwd.length === 0) return undefined
  if (!isPlainObject(launchFingerprint)) return undefined
  if (typeof launchFingerprint.command !== 'string' || launchFingerprint.command.length === 0) return undefined
  if (!Array.isArray(launchFingerprint.args) || !launchFingerprint.args.every((arg) => typeof arg === 'string')) return undefined
  if (!Array.isArray(launchFingerprint.envKeys) || !launchFingerprint.envKeys.every((key) => typeof key === 'string')) return undefined
  if (launchFingerprint.explicitEnv !== undefined) {
    if (!Array.isArray(launchFingerprint.explicitEnv)) return undefined
    for (const entry of launchFingerprint.explicitEnv as unknown[]) {
      if (!isPlainObject(entry) || typeof entry.key !== 'string' || !/^[0-9a-f]{16}$/.test(String(entry.hash16))) return undefined
    }
  }
 // 指纹分量：optional——缺席（旧版本 binding）不判 outdated（由指纹哈希
  // 预检以 'profile-changed' 阻断）；在场时只做形态校验。
  const fpNullableStrings = ['profileId', 'descriptorId', 'adapterVersion', 'wrappedCliVersion'] as const
  for (const key of fpNullableStrings) {
    const value = launchFingerprint[key] as unknown
    if (value !== undefined && value !== null && typeof value !== 'string') return undefined
  }
  if (launchFingerprint.envRefs !== undefined && launchFingerprint.envRefs !== null) {
    if (!Array.isArray(launchFingerprint.envRefs)) return undefined
    for (const ref of launchFingerprint.envRefs as unknown[]) {
      if (!isPlainObject(ref) || typeof ref.key !== 'string' || typeof ref.present !== 'boolean') return undefined
    }
  }
  if (launchFingerprint.executableOverride !== undefined && launchFingerprint.executableOverride !== null) {
    const override = launchFingerprint.executableOverride as unknown
    if (!isPlainObject(override) || typeof override.name !== 'string' || typeof override.present !== 'boolean') return undefined
  }
  if (launchFingerprint.nativeStateEnv !== undefined && launchFingerprint.nativeStateEnv !== null) {
    if (!Array.isArray(launchFingerprint.nativeStateEnv)) return undefined
    for (const entry of launchFingerprint.nativeStateEnv as unknown[]) {
      if (!isPlainObject(entry) || typeof entry.key !== 'string' || typeof entry.present !== 'boolean') return undefined
      if (entry.hash16 !== undefined && (typeof entry.hash16 !== 'string' || !/^[0-9a-f]{16}$/.test(entry.hash16))) return undefined
      if (!entry.present && entry.hash16 !== undefined) return undefined
    }
  }
  if (launchFingerprint.mcpFingerprint !== undefined && launchFingerprint.mcpFingerprint !== null
    && (typeof launchFingerprint.mcpFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(launchFingerprint.mcpFingerprint))) return undefined
  if (!isPlainObject(agent)) return undefined
  if (agent.name !== undefined && typeof agent.name !== 'string') return undefined
  if (agent.version !== undefined && typeof agent.version !== 'string') return undefined
  if (typeof protocolVersion !== 'number' || !Number.isFinite(protocolVersion)) return undefined
  if (typeof capabilityHash !== 'string' || capabilityHash.length === 0) return undefined
  if (typeof configHash !== 'string' || configHash.length === 0) return undefined
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return undefined
  if (typeof bindingEpoch !== 'number' || !Number.isInteger(bindingEpoch) || bindingEpoch < 1) return undefined
  if (typeof committedPromptOrdinal !== 'number' || !Number.isInteger(committedPromptOrdinal) || committedPromptOrdinal < 0) return undefined
  if (typeof historyBaseSeq !== 'number' || !Number.isInteger(historyBaseSeq) || historyBaseSeq < 0) return undefined
  if (typeof establishedAt !== 'number' || !Number.isFinite(establishedAt)) return undefined
  if (typeof dshCommittedSeq !== 'number' || !Number.isInteger(dshCommittedSeq) || dshCommittedSeq < 0) return undefined
  return {
    time,
    provider,
    agentSessionId,
    profileId,
    canonicalCwd,
    launchFingerprint: launchFingerprint as unknown as AcpLaunchFingerprint,
    agent: agent as unknown as AcpBindingAgentInfo,
    protocolVersion,
    capabilityHash,
    configHash,
    generation,
    bindingEpoch,
    committedPromptOrdinal,
    historyBaseSeq,
    establishedAt,
    dshCommittedSeq,
  }
}

/**
 * 创建 sidecar 存储（库懒建：读路径不建库，首个 append/flush 需要落库时才创建
 * `<root>/sidecar.sqlite`）。
 * @param options - 见 {@link AcpSidecarOptions}。
 * @returns sidecar 存储面。
 */
export function createAcpSidecar(options: AcpSidecarOptions): AcpSidecar {
  return new SidecarStore(options)
}

/**
 * 生产接线：从 `dshHomePath` slot 选址（`<dshHome>/dsh-acp`）。slot 缺席 →
 * warn 并返回 `undefined`： sidecar 是 ACP 会话启动的强制前提——
 * provider runtime 拿到 undefined 即抛错，
 * ACP 会话拒绝启动（fail loud，不再「退化为纯窥测」）。widen-accessor 模式照抄
 * host composition 的 `getCtxSlot`（slot 的 Context 增强声明住在
 * app-boot，本包不依赖它编译）。
 */
export function installAcpSidecar(ctx: Context): AcpSidecar | undefined {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  if (typeof holder.get !== 'function') {
    ctx.logger.warn('dsh-acp: Context has no get() slot accessor; sidecar storage unavailable')
    return undefined
  }
  const dshHomePath = holder.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  if (dshHomePath === undefined) {
    ctx.logger.warn('dsh-acp: dshHomePath slot is absent; sidecar storage unavailable — ACP sessions will refuse to start (fail-closed to preserve binding and audit integrity)')
    return undefined
  }
  return createAcpSidecar({
    // 数据目录命名空间同 ACP_SETTINGS_NS：不随 npm 包名改（改名会丢下既有 sidecar）。
    root: dshHomePath('dsh-acp'),
    warn: (message) => { ctx.logger.warn(message) },
  })
}
