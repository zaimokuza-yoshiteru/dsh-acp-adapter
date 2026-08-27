/**
 * Sidecar 旁路存储（sidecar 持久化规则，持久化原则）：审批审计与 ACP binding
 * **不落 session log**，落 harness-home 下的插件私有存储（root =
 * `<dshHome>/dsh-acp`）。
 *
 * 为什么不在 session log：live-event ordering evidence 表明（
 * orchestrator 复跑复证）——插件直写 `ctx.sessionPersistence.append` 会在 live
 * session 上每条 marker 静默吞掉其后一条 live 事件（重启才显形）；`Session.append`
 * 又无 ignorable 写入面。dsh core 增 ignorable 写入口（根治方案）留 backlog。
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
 * **不做 JSONL 迁移层**（项目未投产，硬约束「不为未发布实现增加迁移层」）：启动时
 * root 下若存在旧 `<sessionId>.jsonl` 一律忽略（打开库时 warn 一次提示运维），不读
 * 不迁不删；旧会话 resume 因查无 binding 自然落 reconciliation-required
 * fail-safe（'binding-missing'，既有行为）。`.corrupt-*` 坏行隔离概念随之删除——
 * SQLite 要么库损坏要么不损坏，不存在行级隔离；库无法打开/校验失败 → open 即
 * fail loud（warn 并抛），读路径不再吞错继续。
 *
 * `platform` option 与 ./platform.ts（rename/重试画像）随本重写一并移除——SQLite
 * 的 commit/WAL 恢复取代了 tmp+rename 发布面，包未发布，允许此 breaking。
 *
 * ## 表结构
 *
 * - `audit` 追加表（全部 kind 的完整历史）：record_id（per-session 唯一）、
 *   dsh_session_id、seq（per-session 单调，1 起）、time、kind、acp_provider_id?、
 *   acp_session_id?、dedupe_key（仅 permission decided 有值，`(dsh_session_id,
 *   dedupe_key)` 部分唯一索引）、payload（canonical JSON 文本，键序稳定）。
 * - `bindings` 最新索引表：dsh_session_id 主键 upsert（payload + envelope 分量），
 *   {@link AcpSidecar.readLatestBinding}/{@link AcpSidecar.listBindings} 只查此表。
 * - `model_switches` 待定模型切换事务表：每会话至多一行
 *   （dsh_session_id 主键 upsert），payload 为 {@link AcpPendingModelSwitch}。
 *   写路径同步 durable（fail-closed：'started' 落库先于任何 ACP RPC——写失败
 *   即拒绝切换，零副作用外泄）；崩溃恢复只读此表收敛，绝不 last-writer-wins。
 * - `option_snapshots` 冷启动 last-known 配置快照表：每会话
 *   至多一行（dsh_session_id 主键 upsert），payload 为
 *   {@link AcpOptionsSnapshotRecord}——标准化且有界（`_meta`/未知键剥离，
 *   字段/值数/总字节硬上限见 `ACP_SNAPSHOT_*` 常量）；取代 binding 曾携带的
 *   一次性无界 `configSnapshot`（该字段已删除，单一事实副本只在此表）。
 *   活体权威快照到达即刷新（建立/set_config_option/set_mode/turn 收束变更）；
 *   写失败仅 warn（last-known 是展示/参考面，不是提交面）。
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
 * 缺席（旧版本写出的 binding）不判 outdated，由 agent.ts 的指纹 canonical 哈希
 * 预检以既有 'profile-changed' 阻断；字段在场时这里只做形态校验。
 *
 * ## 有界审计队列（有界审计队列）
 *
 * 同步 durable 路径（append 落库 commit 后才 resolve）：`binding`（recordBinding
 * fail-closed：binding 先于 prompt）与 `permission`（审批桥 fail-closed：append
 * reject → cancelled，见 src/domain/policy/permissions.ts）。其余 kind
 * （permission-scope/agent-mode/agent-config/reconciliation/degradation）进**有界
 * 内存队列**（上限 {@link ACP_SIDECAR_AUDIT_QUEUE_LIMIT}，默认 1024；满 → 丢弃
 * 新记录并 warn 计数，绝不阻塞 turn），microtask 批量事务落库；
 * {@link AcpSidecar.flush} 落齐全部排队记录（生产接线：AcpAgent turn 收束与
 * dispose 前调用）。读路径（list/readLatestBinding/listBindings/exportAudit）先
 * 落齐队列再查库——append → list 的可见性顺序与 JSONL 时代一致。队列是内存面：
 * 进程崩溃丢失未 flush 的非审批审计（可接受，设计既定）；binding/permission 不走
 * 队列，无此窗口。
 *
 * ## 权限位与生命周期
 *
 * 目录 `0700`；`sidecar.sqlite` 及 `-wal`/`-shm` `0600`（打开后显式 chmod 兜底——
 * SQLite 自建的 wal/shm 不吃 umask 之外的约束，flush/checkpoint 后复 chmod）。
 *
 * fork/删除连带清理（调研结论，dsh rc.2）：宿主无会话删除钩子，不做代码
 * 接线；sidecar 行的生命周期 = harness-home 的生命周期（{@link AcpSidecar.remove}
 * 原语保留给未来真正的删除钩子与运维手清）。ACP 审计不随 DSH 官方 `/export`
 * （rc.2 无 ignorable 事件 seam，DSH 自定义审计 seam 缺失）；运维导出走 {@link AcpSidecar.exportAudit}。
 *
 * stateRoot 来源：dsh 没有 per-profile 插件目录，惯例是 harness-home 全局
 * （settings-file、sessions 同在 `resolveDshHome()` 下，dev/prod 隔离靠
 * `DSH_HOME`）。app-boot `boot()` 在挂载插件树之前 `ctx.provide('dshHomePath',
 * dshHomePath)`（app-boot/src/index.ts:770），故 {@link installAcpSidecar} 用
 * src/host/factory/agent-loop.ts 已有的 widen-accessor 模式读该 slot；slot 缺席
 * （裸 Context 单测）返回 `undefined` 并 warn—— sidecar 是 ACP 会话的
 * 强制前提：缺席时 ACP 会话一律拒绝启动（fail loud，见
 * src/host/factory/agent-loop.ts createAcpMachine），不再「退化为纯窥测」。
 *
 * @module @zaimokuza/dsh-acp-adapter/persistence/sidecar
 */

/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AcpAgentConfigAuditData,
  AcpAgentModeAuditData,
  AcpDegradationAuditData,
  AcpElicitationAuditData,
  AcpPermissionAuditData,
  AcpPermissionScopeAuditData,
  AcpTerminalAuditData,
} from '../domain/policy/events.ts'
import {
  ACP_SNAPSHOT_TOTAL_BYTES,
  acpOptionsSnapshotOf,
  toOptionsSnapshotRecord,
} from './options-snapshot.ts'
import type { AcpOptionsSnapshotRecord } from './options-snapshot.ts'

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

/** sidecar 记录格式版本（envelope 的 `schemaVersion`；导出面 {@link AcpSidecar.exportAudit} 逐行重建此形态）。 */
export const ACP_SIDECAR_SCHEMA_VERSION = 2 as const

/** sidecar 单库文件名（`<root>/sidecar.sqlite`；WAL 旁生 `-wal`/`-shm`）。 */
export const ACP_SIDECAR_DB_FILENAME = 'sidecar.sqlite'

/**
 * 非审批审计内存队列上限：满 → 丢弃新记录并 warn 计数，绝不阻塞 turn。
 * 生产接线在 turn 收束与 dispose 前 {@link AcpSidecar.flush} 落齐。
 */
export const ACP_SIDECAR_AUDIT_QUEUE_LIMIT = 1024 as const

/** {@link AcpSidecar.compact}/{@link AcpSidecar.enforceRetention} 的默认保留期（30 天）。 */
export const ACP_SIDECAR_DEFAULT_RETENTION_MS: number = 30 * 24 * 60 * 60 * 1000

// ---------- 待定模型切换事务（model_switches 表） ----------

/**
 * 待定模型切换的状态机词表：
 * - `started`：已持久化、尚未确认 Agent 应用（崩溃点①：Agent 可能已应用也可能没有）；
 * - `agent-applied`：Agent 响应的权威快照已确认应用（崩溃点②：DSH 侧 selectModel
 *   与 committed 标记的状态未知）；
 * - `committed`：DSH 侧已接受（保留词表位；当前实现 committed 与清行同步连贯执行，
 *   崩溃留下的 committed 行按「已收敛」清理）；
 * - `rollback-required`：失败后回滚 Agent 侧也失败（崩溃点③/回滚失败）——双侧
 *   一致性无法自证，composer 锁定直到用户选择恢复路径。
 */
export type AcpPendingModelSwitchState =
  | 'started'
  | 'agent-applied'
  | 'agent-rolled-back'
  | 'committed'
  | 'rollback-required'

/**
 * 待定模型切换事务记录（`model_switches` 表 payload，每会话至多一行）。
 * 同 profile 热切换的唯一写入口（ModelSwitchCoordinator）经此表跨进程崩溃
 * 恢复：恢复时比较 DSH 当前值、Agent 当前值与 previous/target，只收敛到可
 * 证明的状态；无法判定 → reconciliation-required（用户选择回滚或新会话）。
 */
export interface AcpPendingModelSwitch {
  /** 本次切换的唯一操作 id（uuid；重复投递幂等判定的依据）。 */
  readonly operationId: string
  readonly dshSessionId: string
  /** ACP 路由 id（`acp-<id>`；binding/profile 匹配预检的事实源）。 */
  readonly provider: string
  /** Agent 侧 model 类 config option 的 id（回滚写回的落点）。 */
  readonly optionId: string
  readonly previousModel: string
  /** 用户请求值；Agent 可能把它归一化成不同的 appliedModel。 */
  readonly targetModel: string
  /** Agent 响应确认的实际值；仅在成功应用后出现。 */
  readonly appliedModel?: string
  readonly state: AcpPendingModelSwitchState
  /** ISO 时间串（展示/诊断；不参与判定）。 */
  readonly createdAt: string
}

/**
 * {@link AcpSidecar.readPendingModelSwitch} 的结果：行存在且全字段语义校验通过
 * → `{status:'ok'}`；行存在但畸形 → `{status:'corrupt'}`（无法自证一致——调用方
 * 按 reconciliation-required 处理，绝不静默忽略）；无行 → `undefined`。
 */
export type AcpPendingModelSwitchLookup =
  | { readonly status: 'ok'; readonly record: AcpPendingModelSwitch }
  | { readonly status: 'corrupt' }

function toPendingModelSwitch(raw: unknown): AcpPendingModelSwitch | undefined {
  if (!isPlainObject(raw)) return undefined
  const states: readonly string[] = ['started', 'agent-applied', 'agent-rolled-back', 'committed', 'rollback-required']
  for (const key of ['operationId', 'dshSessionId', 'provider', 'optionId', 'previousModel', 'targetModel', 'createdAt'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) return undefined
  }
  if (typeof raw.state !== 'string' || !states.includes(raw.state)) return undefined
  if ('appliedModel' in raw && (typeof raw.appliedModel !== 'string' || raw.appliedModel.length === 0)) return undefined
  return raw as unknown as AcpPendingModelSwitch
}

/**
 * secret-free 启动指纹：profile config 的 command/args 原样 +
 * **排序后的环境变量键名**（`envKeys` 绝不含值——密钥纪律与 agent-config 审计同源）。
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

/** Append-only recovery transition evidence. The current row is not enough to
 * explain who/when cleared a blocker after a restart. */
export interface AcpRecoveryTransition {
  readonly transitionId: string
  readonly dshSessionId: string
  readonly time: number
  readonly fromKind?: AcpRecoveryStateKind
  readonly toKind: AcpRecoveryStateKind
  readonly cause?: string
  readonly userAction?: string
  readonly detail?: string
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

/** {@link AcpSidecar.listBindings} 的行项：一份有效 binding + 其所属 dsh sessionId（行键）。 */
export interface AcpBoundSessionBinding {
  readonly dshSessionId: string
  readonly binding: AcpBindingRecord
}

/**
 * v2 envelope 形态（`audit` 表行的逻辑视图；{@link AcpSidecar.exportAudit} 的 JSONL
 * 行逐字段重建此形态——此后磁盘上是 SQLite 行而不是 JSONL 行，但对外读取/导出
 * 契约不变）。字段语义见模块注释。
 */
export interface AcpSidecarEnvelopeV2 {
  readonly schemaVersion: typeof ACP_SIDECAR_SCHEMA_VERSION
  readonly recordId: string
  readonly seq: number
  readonly time: number
  readonly kind: AcpSidecarKind
  readonly dshSessionId: string
  readonly acpProviderId?: string
  readonly acpSessionId?: string
  readonly payload: AcpBindingData | AcpPermissionAuditData | AcpPermissionScopeAuditData | AcpAgentModeAuditData | AcpAgentConfigAuditData | AcpReconciliationData | AcpDegradationAuditData | AcpElicitationAuditData | AcpFileSystemAuditData | AcpTerminalAuditData
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
 * sidecar 记录的 `kind` 全集（判别联合的判别值）：`binding`/`permission` 原有
 * 两类； 分轴审计两类——`permission-scope`（每次 spawn 的 Native Agent Access
 * 准入事实）与 `agent-mode`（ACP agent mode 轴：建立与每次
 * 经本插件 seam 下发的切换），两轴各自独立条目、互不推导（权限与模式双轴展示）； 新增
 * `agent-config`（agent 配置改动审计摘要：command/args 变更记新值快照，env 只记
 * 键名级 diff——值永不落盘），落配置审计专档（伪 sessionId
 * {@link ACP_SIDECAR_CONFIG_AUDIT_ID}），不进任何会话行集； 新增
 * `reconciliation`（恢复对账失败 → reconciliation-required 的事实记录，载荷见
 * {@link AcpReconciliationData}）； 新增 `degradation`（tool result 内容
 * 降级事实，载荷见 {@link AcpDegradationAuditData}）。
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
}

export type AcpSidecarKind = 'binding' | 'permission' | 'permission-scope' | 'agent-mode' | 'agent-config' | 'reconciliation' | 'degradation' | 'elicitation' | 'filesystem' | 'terminal'

/** 写/读路径共同承认的 v2 kind 全集（行校验用）。 */
const ACP_SIDECAR_KINDS: readonly AcpSidecarKind[] = ['binding', 'permission', 'permission-scope', 'agent-mode', 'agent-config', 'reconciliation', 'degradation', 'elicitation', 'filesystem', 'terminal']

/**
 * 同步 durable 路径的 kind（有界审计队列）：append 落库 commit 后才 resolve。
 * - `binding`：recordBinding fail-closed（binding 先于 prompt，见
 *   src/domain/session/agent.ts）；
 * - `permission`：审批桥 fail-closed（append reject → cancelled，见
 *   src/domain/policy/permissions.ts）。
 * `filesystem` 也同步落库：文件操作是已经发生的外部副作用，不能在队列尚未
 * flush 时向调用方返回成功。其余 kind 进有界内存队列（见
 * {@link ACP_SIDECAR_AUDIT_QUEUE_LIMIT}）。
 */
const ACP_SIDECAR_SYNC_KINDS: readonly AcpSidecarKind[] = ['binding', 'permission', 'elicitation', 'filesystem', 'terminal']

/**
 * agent 配置改动审计的 sidecar 行键（伪 dsh sessionId）：配置改动先于
 * /独立于任何会话存在，故以 `agent-config` 为键落库而非某个会话键。该键通过
 * SAFE_SESSION_ID 校验；它永远不会是真会话 id（宿主 id 是 ULID 风格，且本键带
 * 连字符前缀语义预留）。双绑守卫的 listBindings 扫描对它天然无感（专档无
 * binding 行）。
 */
export const ACP_SIDECAR_CONFIG_AUDIT_ID = 'agent-config'

/**
 * 统一读取模型（判别联合，`kind` 判别）：`data` 访问器即落库 payload 的原内容
 * （内容消费契约不变，envelope 只是包装层）。
 */
export type AcpSidecarEntry =
  | (AcpSidecarEntryBase & { readonly kind: 'binding'; readonly data: AcpBindingData })
  | (AcpSidecarEntryBase & { readonly kind: 'permission'; readonly data: AcpPermissionAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'permission-scope'; readonly data: AcpPermissionScopeAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'agent-mode'; readonly data: AcpAgentModeAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'agent-config'; readonly data: AcpAgentConfigAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'reconciliation'; readonly data: AcpReconciliationData })
  | (AcpSidecarEntryBase & { readonly kind: 'degradation'; readonly data: AcpDegradationAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'elicitation'; readonly data: AcpElicitationAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'filesystem'; readonly data: AcpFileSystemAuditData })
  | (AcpSidecarEntryBase & { readonly kind: 'terminal'; readonly data: AcpTerminalAuditData })

/** {@link AcpSidecar.append} 的入参：`time` 可缺省（由 store 的 `now()` 补齐）。 */
export type AcpSidecarEntryInput =
  | { readonly kind: 'binding'; readonly time?: number; readonly data: AcpBindingData }
  | { readonly kind: 'permission'; readonly time?: number; readonly data: AcpPermissionAuditData }
  | { readonly kind: 'permission-scope'; readonly time?: number; readonly data: AcpPermissionScopeAuditData }
  | { readonly kind: 'agent-mode'; readonly time?: number; readonly data: AcpAgentModeAuditData }
  | { readonly kind: 'agent-config'; readonly time?: number; readonly data: AcpAgentConfigAuditData }
  | { readonly kind: 'reconciliation'; readonly time?: number; readonly data: AcpReconciliationData }
  | { readonly kind: 'degradation'; readonly time?: number; readonly data: AcpDegradationAuditData }
  | { readonly kind: 'elicitation'; readonly time?: number; readonly data: AcpElicitationAuditData }
  | { readonly kind: 'filesystem'; readonly time?: number; readonly data: AcpFileSystemAuditData }
  | { readonly kind: 'terminal'; readonly time?: number; readonly data: AcpTerminalAuditData }

/** 补齐 `time` 后的待落盘记录（envelope 分量由 store 分配）。 */
type StampedEntry =
  | { readonly kind: 'binding'; readonly time: number; readonly data: AcpBindingData }
  | { readonly kind: 'permission'; readonly time: number; readonly data: AcpPermissionAuditData }
  | { readonly kind: 'permission-scope'; readonly time: number; readonly data: AcpPermissionScopeAuditData }
  | { readonly kind: 'agent-mode'; readonly time: number; readonly data: AcpAgentModeAuditData }
  | { readonly kind: 'agent-config'; readonly time: number; readonly data: AcpAgentConfigAuditData }
  | { readonly kind: 'reconciliation'; readonly time: number; readonly data: AcpReconciliationData }
  | { readonly kind: 'degradation'; readonly time: number; readonly data: AcpDegradationAuditData }
  | { readonly kind: 'elicitation'; readonly time: number; readonly data: AcpElicitationAuditData }
  | { readonly kind: 'filesystem'; readonly time: number; readonly data: AcpFileSystemAuditData }
  | { readonly kind: 'terminal'; readonly time: number; readonly data: AcpTerminalAuditData }

/** {@link AcpSidecar.exportAudit} 的构造项。 */
export interface AcpSidecarExportOptions {
  /** 限定单个 dsh sessionId；缺省 = 全量导出（含 agent-config 专档）。 */
  readonly sessionId?: SessionId | undefined
  /** `jsonl`（默认，每行一条 v2 envelope JSON，结尾有换行）或 `json`（envelope 数组）。 */
  readonly format?: 'jsonl' | 'json' | undefined
}

/** {@link AcpSidecar.enforceRetention} 的构造项。 */
export interface AcpSidecarRetentionOptions {
  /** 限定单个 dsh sessionId；缺省 = 全库清理。 */
  readonly sessionId?: SessionId | undefined
  /** 保留期（毫秒）：`time < now() - olderThanMs` 的 audit 行删除。缺省取构造期 `retentionMs`。 */
  readonly olderThanMs?: number | undefined
}

/** {@link AcpSidecar.enforceRetention} 的结果。 */
export interface AcpSidecarRetentionResult {
  /** 本次删除的 audit 行数。 */
  readonly removed: number
  /** 实际生效的超龄阈值（epoch 毫秒；`time < cutoff` 被删）。 */
  readonly cutoff: number
}

/** {@link AcpSidecar.health} 的健康行。 */
export interface AcpSidecarHealth {
  /** 库文件路径（`<root>/sidecar.sqlite`）。 */
  readonly dbPath: string
  /** 库文件是否已创建（读路径不建库；首个 append 才建）。 */
  readonly exists: boolean
  /** 库主文件字节数（不存在 → 0）。 */
  readonly dbBytes: number
  /** WAL 文件字节数（不存在 → 0）。 */
  readonly walBytes: number
  /** audit 表行数（库不存在 → 0）。 */
  readonly auditRows: number
  /** bindings 表行数（库不存在 → 0）。 */
  readonly bindingRows: number
  /** `PRAGMA quick_check` 结果：`ok` / `failed` / 库未创建时 `absent`。 */
  readonly integrity: 'ok' | 'failed' | 'absent'
  /** 当前内存队列里待落齐的非审批审计条数。 */
  readonly queuedEntries: number
  /** 进程生命周期内因队列满/落库失败被丢弃的非审批审计累计条数。 */
  readonly droppedEntries: number
}

/**
 * sidecar 存储面（的唯一审计/binding 通道；SQLite WAL 承载）。
 *
 * 接口语义门槛（JSONL 时代钉版，本实现全数保持）：非法 sessionId **同步**抛
 * TypeError（契约违例，非运行时失败），I/O 失败才走 Promise 拒绝；
 * readLatestBinding 的 ok/outdated/undefined 三态；listBindings 只计入 ok；
 * remove 幂等。
 *
 * compact 语义重定义（审计保留策略）：**retention + VACUUM**——按保留策略删除
 * 该会话超龄 audit 行后整库 VACUUM；JSONL 时代的「坏行隔离」概念删除（SQLite
 * 要么库损坏要么不损坏；库无法打开 → open 即 fail loud）。
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
  /** Read append-only recovery transitions for diagnostics and audit UI. */
  listRecoveryTransitions(sessionId: SessionId): Promise<readonly AcpRecoveryTransition[]>
  /**
 * 全量 binding 索引（双绑守卫的唯一消费点 = host/factory/agent-loop.ts 的
   * resume 路由）：查 bindings 表全部行，仅语义校验通过（`{status:'ok'}`）者计入
   * （畸形行跳过并 warn；库不存在 → 空数组）。
   */
  listBindings(): Promise<readonly AcpBoundSessionBinding[]>
  /** 该 sessionId 全量合法 entry（按 seq 升序；行级校验失败者跳过并 warn）；库不存在 → 空数组。 */
  list(sessionId: SessionId): Promise<readonly AcpSidecarEntry[]>
  /** 删除该 sessionId 的全部 sidecar 行（audit + bindings + model_switches + option_snapshots；fork/删除连带清理用）；幂等，不存在不报错。 */
  remove(sessionId: SessionId): Promise<void>
  /**
 * 写入（upsert）该会话的待定模型切换事务。**同步 durable、fail-closed**
   * 落库 commit 后才 resolve；写失败 reject——'started' 行的写入先于任何 ACP RPC，
   * 写不进 sidecar 就绝不发起切换（崩溃恢复无据的切换不允许开始）。字段校验
   * 失败同步抛 TypeError（契约违例）。
   */
  writePendingModelSwitch(record: AcpPendingModelSwitch): Promise<void>
  /**
   * 读该会话的待定模型切换事务：无行 → `undefined`；行畸形 → `{status:'corrupt'}`
   * （warn 一次；调用方按无法自证一致处理，绝不静默忽略）。
   */
  readPendingModelSwitch(sessionId: SessionId): Promise<AcpPendingModelSwitchLookup | undefined>
  /** 清除该会话的待定模型切换行（commit/回滚成功/rebindBlank 放弃旧代际）；幂等。 */
  clearPendingModelSwitch(sessionId: SessionId): Promise<void>
  /**
 * 写入（upsert）该会话的 last-known option 快照（输入须先经
   * {@link acpOptionsSnapshotOf} 标准化）。同步 durable；写失败 reject
   * （调用方按「last-known 展示面」纪律降级为 warn，不翻转主链路）。
   */
  writeOptionSnapshot(sessionId: SessionId, snapshot: AcpOptionsSnapshotRecord): Promise<void>
  /** 读该会话的 last-known option 快照；无行/畸形 → `undefined`（畸形行 warn 一次）。 */
  readOptionSnapshot(sessionId: SessionId): Promise<AcpOptionsSnapshotRecord | undefined>
  /**
   * retention + VACUUM：删除该 sessionId `time < now() -
   * retentionMs` 的 audit 行，然后整库 VACUUM 压实。bindings 索引行不受
   * retention 影响（恢复证据，随 {@link AcpSidecar.remove} 生命周期）。库不存在
   * → no-op（不建库）。
   */
  compact(sessionId: SessionId, retentionMs?: number): Promise<void>
  /**
   * 落齐非审批审计队列：排队记录批量事务落库后做一轮 WAL checkpoint
   * （PASSIVE）并复 chmod wal/shm。生产接线：AcpAgent turn 收束与 dispose 前调用；
   * 读路径内部同样先落齐。队列空 → no-op。
   */
  flush(): Promise<void>
  /** 关闭存储：落齐队列 + WAL checkpoint（TRUNCATE）+ 关闭连接。幂等；之后的方法调用会按需重开库。 */
  dispose(): Promise<void>
  /**
   * 导出 ACP audit（插件级 API；ACP 审计不随 DSH 官方 export——DSH 自定义审计 seam 缺失 既定
   * 限制，本方法是运维导出面）：按 sessionId 或全量，`jsonl`（每行一条 v2
   * envelope）或 `json`（envelope 数组）文本。导出是只读快照（先落齐队列）。
   */
  exportAudit(options?: AcpSidecarExportOptions): Promise<string>
  /**
   * 清超龄 audit 记录（插件级 retention API；配合 {@link AcpSidecar.compact}
   * 的 VACUUM 压实）：删除 `time < now() - olderThanMs` 的行（可按 sessionId 限定）。
   * 只动 audit 表，不动 bindings 索引。
   */
  enforceRetention(options?: AcpSidecarRetentionOptions): Promise<AcpSidecarRetentionResult>
  /** 健康行：库/WAL 大小、行计数、`quick_check` 完整性、队列水位与丢弃计数。 */
  health(): Promise<AcpSidecarHealth>
}

/** {@link createAcpSidecar} 的构造项。 */
export interface AcpSidecarOptions {
  /** 存储根目录（调用方负责选址；生产为 `dshHomePath('dsh-acp')`）。 */
  readonly root: string
  /** 时钟（`time` 缺省补齐与 retention 阈值用；默认 `Date.now`，测试注入确定性）。 */
  readonly now?: (() => number) | undefined
  /** 诊断出口（行级校验失败计数、队列丢弃、库打开失败等；默认 noop）。 */
  readonly warn?: ((message: string) => void) | undefined
  /** 默认保留期（{@link AcpSidecar.compact}/{@link AcpSidecar.enforceRetention} 缺省阈值；默认 {@link ACP_SIDECAR_DEFAULT_RETENTION_MS}）。 */
  readonly retentionMs?: number | undefined
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
 * reconciliation 仅 acpSessionId（在场时）； 分轴审计两类（permission-scope/
 * agent-mode）与 degradation 的 payload 无 acp 身份可推导，恒 `{}`。
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

interface RecoveryTransitionRow {
  readonly transition_id: string
  readonly dsh_session_id: string
  readonly time: number
  readonly from_kind: string | null
  readonly to_kind: string
  readonly cause: string | null
  readonly user_action: string | null
  readonly detail: string | null
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
CREATE TABLE IF NOT EXISTS model_switches (
  dsh_session_id TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
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
CREATE TABLE IF NOT EXISTS recovery_transitions (
  transition_id TEXT PRIMARY KEY,
  dsh_session_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  from_kind TEXT,
  to_kind TEXT NOT NULL,
  cause TEXT,
  user_action TEXT,
  detail TEXT
) STRICT;
`

class SidecarStore implements AcpSidecar {
  readonly root: string
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private readonly retentionMs: number
  private readonly queueLimit: number
  /** 懒开库（读路径不建库；首个写/显式 flush 需要落库时才建）。 */
  private db: DatabaseSync | undefined
  private stmtInsert: StatementSync | undefined
  private stmtInsertIgnore: StatementSync | undefined
  private stmtMaxSeq: StatementSync | undefined
  private stmtHasRecordId: StatementSync | undefined
  private stmtHasDedupe: StatementSync | undefined
  private stmtList: StatementSync | undefined
  private stmtGetBinding: StatementSync | undefined
  private stmtListBindings: StatementSync | undefined
  private stmtUpsertBinding: StatementSync | undefined
  private stmtDeleteSession: StatementSync | undefined
  private stmtDeleteBinding: StatementSync | undefined
  private stmtGetModelSwitch: StatementSync | undefined
  private stmtUpsertModelSwitch: StatementSync | undefined
  private stmtDeleteModelSwitch: StatementSync | undefined
  private stmtGetOptionSnapshot: StatementSync | undefined
  private stmtUpsertOptionSnapshot: StatementSync | undefined
  private stmtDeleteOptionSnapshot: StatementSync | undefined
  private stmtGetRecoveryState: StatementSync | undefined
  private stmtUpsertRecoveryState: StatementSync | undefined
  private stmtDeleteRecoveryState: StatementSync | undefined
  private stmtInsertRecoveryTransition: StatementSync | undefined
  private stmtListRecoveryTransitions: StatementSync | undefined
  private stmtDeleteRecoveryTransitions: StatementSync | undefined
  private stmtDeleteOverAge: StatementSync | undefined
  private stmtDeleteOverAgeSession: StatementSync | undefined
  private stmtDeleteOverAgeRecoveryTransition: StatementSync | undefined
  private stmtDeleteOverAgeRecoveryTransitionSession: StatementSync | undefined
  private stmtExportAll: StatementSync | undefined
  private stmtCountAudit: StatementSync | undefined
  private stmtCountBindings: StatementSync | undefined
  /** per-session 下一个 seq（懒种子 = 库里 MAX(seq)+1；含队列已占号）。 */
  private readonly seqCounters = new Map<string, number>()
  private queue: QueuedAudit[] = []
  private queueDrainScheduled = false
  private queueFullWarned = false
  private droppedEntries = 0
  /** 旧 JSONL 残留的忽略提示每实例只 warn 一次。 */
  private legacyJsonlWarned = false

  constructor(options: AcpSidecarOptions) {
    this.root = options.root
    this.now = options.now ?? ((): number => Date.now())
    this.warn = options.warn ?? ((): void => undefined)
    this.retentionMs = options.retentionMs ?? ACP_SIDECAR_DEFAULT_RETENTION_MS
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
    let db: DatabaseSync
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
    } catch (error: unknown) {
      this.warn(`dsh-acp sidecar: failed to open ${this.dbPath} (${errorMessage(error)}); the sidecar store fails loud`)
      throw error
    }
    this.db = db
    this.stmtInsert = db.prepare('INSERT INTO audit (record_id, dsh_session_id, seq, time, kind, acp_provider_id, acp_session_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtInsertIgnore = db.prepare('INSERT OR IGNORE INTO audit (record_id, dsh_session_id, seq, time, kind, acp_provider_id, acp_session_id, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtMaxSeq = db.prepare('SELECT MAX(seq) AS max_seq FROM audit WHERE dsh_session_id = ?')
    this.stmtHasRecordId = db.prepare('SELECT 1 AS x FROM audit WHERE dsh_session_id = ? AND record_id = ?')
    this.stmtHasDedupe = db.prepare('SELECT 1 AS x FROM audit WHERE dsh_session_id = ? AND dedupe_key = ?')
    this.stmtList = db.prepare('SELECT * FROM audit WHERE dsh_session_id = ? ORDER BY seq ASC')
    this.stmtGetBinding = db.prepare('SELECT * FROM bindings WHERE dsh_session_id = ?')
    this.stmtListBindings = db.prepare('SELECT * FROM bindings ORDER BY dsh_session_id ASC')
    this.stmtUpsertBinding = db.prepare('INSERT INTO bindings (dsh_session_id, time, acp_provider_id, acp_session_id, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, acp_provider_id = excluded.acp_provider_id, acp_session_id = excluded.acp_session_id, payload = excluded.payload')
    this.stmtDeleteSession = db.prepare('DELETE FROM audit WHERE dsh_session_id = ?')
    this.stmtDeleteBinding = db.prepare('DELETE FROM bindings WHERE dsh_session_id = ?')
    this.stmtGetModelSwitch = db.prepare('SELECT * FROM model_switches WHERE dsh_session_id = ?')
    this.stmtUpsertModelSwitch = db.prepare('INSERT INTO model_switches (dsh_session_id, time, payload) VALUES (?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, payload = excluded.payload')
    this.stmtDeleteModelSwitch = db.prepare('DELETE FROM model_switches WHERE dsh_session_id = ?')
    this.stmtGetOptionSnapshot = db.prepare('SELECT * FROM option_snapshots WHERE dsh_session_id = ?')
    this.stmtUpsertOptionSnapshot = db.prepare('INSERT INTO option_snapshots (dsh_session_id, time, payload) VALUES (?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, payload = excluded.payload')
    this.stmtDeleteOptionSnapshot = db.prepare('DELETE FROM option_snapshots WHERE dsh_session_id = ?')
    this.stmtGetRecoveryState = db.prepare('SELECT * FROM recovery_states WHERE dsh_session_id = ?')
    this.stmtUpsertRecoveryState = db.prepare('INSERT INTO recovery_states (dsh_session_id, time, last_attempt_at, last_user_action, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dsh_session_id) DO UPDATE SET time = excluded.time, last_attempt_at = excluded.last_attempt_at, last_user_action = excluded.last_user_action, payload = excluded.payload')
    this.stmtDeleteRecoveryState = db.prepare('DELETE FROM recovery_states WHERE dsh_session_id = ?')
    this.stmtInsertRecoveryTransition = db.prepare('INSERT INTO recovery_transitions (transition_id, dsh_session_id, time, from_kind, to_kind, cause, user_action, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    this.stmtListRecoveryTransitions = db.prepare('SELECT * FROM recovery_transitions WHERE dsh_session_id = ? ORDER BY time ASC, transition_id ASC')
    this.stmtDeleteRecoveryTransitions = db.prepare('DELETE FROM recovery_transitions WHERE dsh_session_id = ?')
    this.stmtDeleteOverAge = db.prepare('DELETE FROM audit WHERE time < ?')
    this.stmtDeleteOverAgeSession = db.prepare('DELETE FROM audit WHERE dsh_session_id = ? AND time < ?')
    this.stmtDeleteOverAgeRecoveryTransition = db.prepare('DELETE FROM recovery_transitions WHERE time < ?')
    this.stmtDeleteOverAgeRecoveryTransitionSession = db.prepare('DELETE FROM recovery_transitions WHERE dsh_session_id = ? AND time < ?')
    this.stmtExportAll = db.prepare('SELECT * FROM audit ORDER BY dsh_session_id ASC, seq ASC')
    this.stmtCountAudit = db.prepare('SELECT COUNT(*) AS n FROM audit')
    this.stmtCountBindings = db.prepare('SELECT COUNT(*) AS n FROM bindings')
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
      const previousRow = this.stmtGetRecoveryState?.get(validated.dshSessionId) as { payload?: string } | undefined
      let previous: AcpRecoveryState | undefined
      if (previousRow?.payload !== undefined) {
        try { previous = toRecoveryState(JSON.parse(previousRow.payload)) } catch { previous = undefined }
      }
      const transitionTime = validated.lastAttemptAt ?? validated.updatedAt
      const transitionId = `recovery:${validated.dshSessionId}:${transitionTime}:${randomUUID()}`
      try {
        this.stmtUpsertRecoveryState?.run(
          validated.dshSessionId,
          validated.updatedAt,
          validated.lastAttemptAt ?? null,
          validated.lastUserAction ?? null,
          stableStringify(validated),
        )
        this.stmtInsertRecoveryTransition?.run(
          transitionId,
          validated.dshSessionId,
          transitionTime,
          previous?.kind ?? null,
          validated.kind,
          validated.cause ?? null,
          validated.lastUserAction ?? null,
          validated.detail ?? null,
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

  listRecoveryTransitions(sessionId: SessionId): Promise<readonly AcpRecoveryTransition[]> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve([])
      const rows = (this.stmtListRecoveryTransitions?.all(sessionId) ?? []) as unknown as RecoveryTransitionRow[]
      return Promise.resolve(rows.map((row) => ({
        transitionId: row.transition_id,
        dshSessionId: row.dsh_session_id,
        time: row.time,
        ...(row.from_kind === null ? {} : { fromKind: row.from_kind as AcpRecoveryStateKind }),
        toKind: row.to_kind as AcpRecoveryStateKind,
        ...(row.cause === null ? {} : { cause: row.cause }),
        ...(row.user_action === null ? {} : { userAction: row.user_action }),
        ...(row.detail === null ? {} : { detail: row.detail }),
      })))
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

  remove(sessionId: SessionId): Promise<void> {
    assertSafeSessionId(sessionId)
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve()
      this.stmtDeleteSession?.run(sessionId)
      this.stmtDeleteBinding?.run(sessionId)
      this.stmtDeleteModelSwitch?.run(sessionId)
      this.stmtDeleteOptionSnapshot?.run(sessionId)
      this.stmtDeleteRecoveryState?.run(sessionId)
      this.stmtDeleteRecoveryTransitions?.run(sessionId)
      this.seqCounters.delete(sessionId)
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  writePendingModelSwitch(record: AcpPendingModelSwitch): Promise<void> {
    const validated = toPendingModelSwitch(record)
    if (validated === undefined) {
      throw new TypeError(`dsh-acp sidecar: malformed pending model switch record for session ${JSON.stringify(record.dshSessionId)}`)
    }
    assertSafeSessionId(record.dshSessionId)
    try {
      this.ensureDb() // fail-closed：同步 durable 落库 commit 后才 resolve
      this.stmtUpsertModelSwitch?.run(record.dshSessionId, this.now(), stableStringify(validated))
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  readPendingModelSwitch(sessionId: SessionId): Promise<AcpPendingModelSwitchLookup | undefined> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve(undefined)
      const row = this.stmtGetModelSwitch?.get(sessionId) as { payload: string } | undefined
      if (row === undefined) return Promise.resolve(undefined)
      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        payload = undefined
      }
      const record = toPendingModelSwitch(payload)
      if (record === undefined || record.dshSessionId !== (sessionId as string)) {
        this.warn(`dsh-acp sidecar: pending model switch row for session ${JSON.stringify(sessionId as string)} is malformed; the switch state is undecidable (reconciliation-required)`)
        return Promise.resolve({ status: 'corrupt' })
      }
      return Promise.resolve({ status: 'ok', record })
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  clearPendingModelSwitch(sessionId: SessionId): Promise<void> {
    assertSafeSessionId(sessionId)
    try {
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve()
      this.stmtDeleteModelSwitch?.run(sessionId)
      return Promise.resolve()
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

  compact(sessionId: SessionId, retentionMs?: number): Promise<void> {
    assertSafeSessionId(sessionId)
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) return Promise.resolve()
      const cutoff = this.now() - (retentionMs ?? this.retentionMs)
      const result = this.stmtDeleteOverAgeSession?.run(sessionId, cutoff)
      const removed = Number(result?.changes ?? 0)
      this.stmtDeleteOverAgeRecoveryTransitionSession?.run(sessionId, cutoff)
      if (removed > 0) {
        this.warn(`dsh-acp sidecar: retention removed ${String(removed)} audit row(s) older than ${new Date(cutoff).toISOString()} for session ${JSON.stringify(sessionId as string)}`)
      }
      db.exec('VACUUM')
      // WAL 模式下 VACUUM 的压缩结果经 WAL 生效，需 checkpoint 后主库文件才收缩
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.chmodWalFiles()
      try {
        chmodSync(this.dbPath, 0o600) // VACUUM 重写主文件，权限位兜底复落
      } catch (error: unknown) {
        this.warn(`dsh-acp sidecar: failed to chmod 0600 on ${this.dbPath} after VACUUM (${errorMessage(error)})`)
      }
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  exportAudit(options?: AcpSidecarExportOptions): Promise<string> {
    if (options?.sessionId !== undefined) assertSafeSessionId(options.sessionId)
    try {
      this.drainQueue()
      const db = this.openIfExists()
      const rows = db === undefined
        ? []
        : (options?.sessionId === undefined
          ? (this.stmtExportAll?.all() ?? [])
          : (this.stmtList?.all(options.sessionId) ?? [])) as unknown as AuditRow[]
      const envelopes: AcpSidecarEnvelopeV2[] = []
      let skipped = 0
      for (const row of rows) {
        const envelope = rowToEnvelope(row)
        if (envelope === undefined) skipped += 1
        else envelopes.push(envelope)
      }
      if (skipped > 0) this.warn(`dsh-acp sidecar: skipped ${String(skipped)} malformed audit row(s) during export`)
      const text = options?.format === 'json'
        ? JSON.stringify(envelopes, null, 2)
        : envelopes.map((envelope) => JSON.stringify(envelope)).join('\n') + (envelopes.length === 0 ? '' : '\n')
      return Promise.resolve(text)
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  enforceRetention(options?: AcpSidecarRetentionOptions): Promise<AcpSidecarRetentionResult> {
    if (options?.sessionId !== undefined) assertSafeSessionId(options.sessionId)
    try {
      this.drainQueue()
      const db = this.openIfExists()
      const cutoff = this.now() - (options?.olderThanMs ?? this.retentionMs)
      if (db === undefined) return Promise.resolve({ removed: 0, cutoff })
      const result = options?.sessionId === undefined
        ? this.stmtDeleteOverAge?.run(cutoff)
        : this.stmtDeleteOverAgeSession?.run(options.sessionId, cutoff)
      const transitionResult = options?.sessionId === undefined
        ? this.stmtDeleteOverAgeRecoveryTransition?.run(cutoff)
        : this.stmtDeleteOverAgeRecoveryTransitionSession?.run(options.sessionId, cutoff)
      const removed = Number(result?.changes ?? 0)
      if (removed > 0) this.warn(`dsh-acp sidecar: retention removed ${String(removed)} audit row(s) older than ${new Date(cutoff).toISOString()}`)
      // The public count remains the audit count; transition cleanup is an
      // internal retention detail and must not change existing callers.
      void transitionResult
      return Promise.resolve({ removed, cutoff })
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
    }
  }

  health(): Promise<AcpSidecarHealth> {
    try {
      this.drainQueue()
      const db = this.openIfExists()
      if (db === undefined) {
        return Promise.resolve({
          dbPath: this.dbPath,
          exists: false,
          dbBytes: 0,
          walBytes: 0,
          auditRows: 0,
          bindingRows: 0,
          integrity: 'absent',
          queuedEntries: 0,
          droppedEntries: this.droppedEntries,
        })
      }
      const quick = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
      const auditRows = Number((this.stmtCountAudit?.get() as { n: number | bigint } | undefined)?.n ?? 0)
      const bindingRows = Number((this.stmtCountBindings?.get() as { n: number | bigint } | undefined)?.n ?? 0)
      const walPath = `${this.dbPath}-wal`
      return Promise.resolve({
        dbPath: this.dbPath,
        exists: true,
        dbBytes: statSync(this.dbPath).size,
        walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
        auditRows,
        bindingRows,
        integrity: quick?.quick_check === 'ok' ? 'ok' : 'failed',
        queuedEntries: this.queue.length,
        droppedEntries: this.droppedEntries,
      })
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
    generation, historyBaseSeq, establishedAt, dshCommittedSeq,
  } = raw
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof agentSessionId !== 'string' || agentSessionId.length === 0) return undefined
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined
  if (typeof canonicalCwd !== 'string' || canonicalCwd.length === 0) return undefined
  if (!isPlainObject(launchFingerprint)) return undefined
  if (typeof launchFingerprint.command !== 'string' || launchFingerprint.command.length === 0) return undefined
  if (!Array.isArray(launchFingerprint.args) || !launchFingerprint.args.every((arg) => typeof arg === 'string')) return undefined
  if (!Array.isArray(launchFingerprint.envKeys) || !launchFingerprint.envKeys.every((key) => typeof key === 'string')) return undefined
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
 * createAcpMachine（src/host/factory/agent-loop.ts）拿到 undefined 即抛错，
 * ACP 会话拒绝启动（fail loud，不再「退化为纯窥测」）。widen-accessor 模式照抄
 * src/host/factory/agent-loop.ts 的 `getCtxSlot`（slot 的 Context 增强声明住在
 * app-boot，本包不依赖它编译）。
 */
export function installAcpSidecar(ctx: Context): AcpSidecar | undefined {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
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
