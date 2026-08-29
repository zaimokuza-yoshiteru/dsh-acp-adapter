/**
 * 一条 DSH 会话对应一个固定的 ACP execution backend。本类负责把 DSH turn 映射为
 * ACP `session/prompt`，并协调子进程生命周期、配置同步、恢复对账与审计。
 *
 * 首次发送前必须完成 Agent 初始化和 binding 持久化；恢复优先使用 Agent 广告的
 * `session/resume`，不支持时才通过 `session/load` staging 回放对账。两条路径都先
 * 验证 DSH 日志边界、工作区与启动指纹；无法证明连续时进入
 * reconciliation-required，不会用新 ACP 会话静默接续旧历史。
 *
 * ACP 会话固定使用“原生 Agent 访问”；DSH 权限投影只用于保持这一会话
 * 事实，不会模拟 Agent 自己的安全模式。Agent 返回的 mode、model 和 thinking
 * option 作为下游配置展示与写入。审批保持 ACP option 的原始语义，
 * 单次允许不会升级为永久允许。
 *
 * 取消和销毁均有超时与进程树终止梯子。日志、指标和 sidecar 审计不得包含 prompt、
 * 凭据或完整工具参数。ACP context occupancy 使用独立状态，不伪装成 DSH TokenUsage。
 *
 * @module @zaimokuza/dsh-acp-adapter/domain/session/agent
 */

/// <reference types="node" />

import { realpathSync } from 'node:fs'
import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import { assertNever, createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, foldRequestHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpClientConnection, supportsFork } from '../../protocol/v1/connection.ts'
import type { AcpFileSystemHandlers } from '../../runtime/client-capabilities/filesystem.ts'
import type { AcpTerminalHandlers } from '../../runtime/client-capabilities/terminal.ts'
import { AcpClientError, acpErrorRef } from '../../protocol/v1/errors.ts'
import type { ElicitationRequestHandler, PermissionRequestHandler } from '../../protocol/v1/types.ts'
import type { AcpConnectionSpec } from '../../runtime/process/types.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import { waitWithin } from '../../runtime/process/timeout.ts'
import { createAcpCommandBridge } from '../../protocol/v1/commands.ts'
import type { AcpCommandBridge, AcpCommandRegistry } from '../../protocol/v1/commands.ts'
import { hostCreateScope } from '../../host-compat/host-scope.ts'
import { AcpBackendImmutableError, AcpModelSwitchLockedError, createAcpOptionsSync, selectValuesOf, ACP_MODE_OPTION_ID, ACP_MODEL_OPTION_ID } from './options-sync.ts'
import type { AcpOptionsSync } from './options-sync.ts'
import { AcpLifecycle } from './lifecycle.ts'
import type { AcpLifecycleKind } from './lifecycle.ts'
import { createAcpLogger } from '../observability/logging.ts'
import type { AcpLogFields, AcpLogger } from '../observability/logging.ts'
import { ACP_METRIC } from '../observability/metrics.ts'
import type { AcpMetricsLike } from '../observability/metrics.ts'
import { buildAcpSpawnPlan, AcpSpawnPlanError } from '../policy/sandbox.ts'
import type { AcpSandboxMode, AcpSpawnPlan } from '../policy/sandbox.ts'
import { ACP_DEGRADATION_AUDIT_KIND, ACP_SESSION_FORK_AUDIT_KIND } from '../policy/events.ts'
import type { AcpAgentModeAuditVia, AcpDegradationAuditData, AcpSessionForkReason } from '../policy/events.ts'
import { ACP_STEP, ACP_UNKNOWN_MODEL, ReplayTranslator, TurnTranslator, sessionEventSink } from '../../protocol/v1/translate.ts'
import type { AcpContextUsageSnapshot, AcpToolCallPresentationSnapshot } from '../../protocol/v1/translate.ts'
import { descriptorOf } from './agent-config.ts'
import type { AcpResolvedAgent } from './agent-config.ts'
import { acpLaunchEnvironment, acpLaunchFingerprint } from './launch-fingerprint.ts'
import {
  AcpBindingPersistError,
  AcpReconciliationError,
  ACP_RECONCILIATION_GUIDANCE,
  acpModelDivergenceNote,
  appendEmptyResponseNote,
  appendForkBlankNote,
  appendModelDivergenceNote,
  appendOutcomeUnknownNote,
  appendRebindBlankNote,
  appendResumeResidueNote,
  detectInterruptedTail,
  type AcpHistoryProjectionPolicy,
  expectedVisibleHistory,
  hasForkBlankNote,
  isLatestSemanticForkSeed,
  reconcileVisibleHistory,
  replayVisibleHistory,
  resolveExpectedRange,
} from './resume.ts'
import { acpCanonicalHash16, acpOptionsSnapshotOf } from '../../persistence/sidecar.ts'
import { AcpPromptContentError, toAcpPrompt, validImageLimits } from './prompt-content.ts'
import type {
  AcpBindingData,
  AcpBindingRecord,
  AcpOptionsSnapshotRecord,
  AcpPendingModelSwitch,
  AcpPendingModelSwitchLookup,
  AcpReconciliationCause,
  AcpRecoveryState,
  AcpSidecarEntryInput,
  AcpReplayAssessmentData,
} from '../../persistence/sidecar.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * v1 提示（既定行为）：ACP 会话上发起了维护任务。
     * 任务照常执行，但维护的 dsh 侧效果（如 compaction 改写日志）不回传 ACP 子进程
     * 自有上下文。理想通道是 ignorable 会话事件；`Session.append` 无 ignorable 写入面
     * （见 ./resume.ts 模块注释），故 v1 记 agent 侧提示事件。
     * @param payload.agent - 被维护的 ACP agent。
     * @mode emit
     */
    'dsh-acp/maintenance'(payload: { agent: Agent }): void
  }
}

/**
 * 子进程环境与 Native Agent Access spawn 计划由 ../policy/sandbox.ts 统一供给：
 * `buildAcpAgentEnv` 组 env，`buildAcpSpawnPlan` 验证准入模式并产出原生 argv/env。
 */

/**
 * widen-accessor：读没有类型增强声明的 ctx slot（dsh-sandbox / dsh-sandbox-policy /
 * app-boot 的 `dshHomePath` 均不在本包依赖面，增强声明不可见）。
 * 模式照抄 src/host/factory/agent-loop.ts 的 `getCtxSlot` / src/persistence/sidecar.ts
 * 的 `installAcpSidecar`。
 */
function getCtxSlot<T>(ctx: Context, name: string): T | undefined {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  return holder.get(name) as T | undefined
}

/**
 * `ctx.sandboxPolicy` 的消费面窄化（既定规则：dsh `SandboxPolicyService` 是权限模式的
 * 唯一 owner，`resolve({session})` = 显式档位 ?? 会话 `sandbox/mode` 事件折叠 ??
 * 部署缺省；workspaceRoot = canonical(session cwd ?? fallback)）。
 */
interface AcpSandboxPolicyResolver {
  resolve(request: { session: Session }): { mode: AcpSandboxMode; workspaceRoot: string }
}

/** AcpAgent 的作用域边界：agent 作用域注册的所有权 + 卸载（宿主 dsh-scope `Scope` 的结构别名）。 */
export interface AcpAgentScope {
  /** agent 作用域注册上下文（携带 `agent` 关联）。 */
  readonly ctx: Context
  /** 底层 fiber 的原生 disposer（有序嵌套进复合 effect 时用）。 */
  readonly rawDispose: () => Promise<void> | void
  /** 卸载全部 agent 作用域注册；竞态调用共享同一份完成。 */
  dispose(): Promise<void>
}

/** {@link AcpAgent} 的构造选项（各 seam 的消费方见各字段注释）。 */
export interface AcpAgentOptions {
  /** 注册表命中的 provider：`config.command/args/env` 是子进程 spawn 规格，`id` 决定路由 `acp-<id>`。 */
  profile: AcpResolvedAgent
  /** Candidate parent binding for a DSH fork. Only passed after the factory
   * proves the seed is the parent's latest committed semantic boundary. */
  forkCandidate?: AcpForkCandidate
  /** Why a parent fork candidate could not be formed; used for the audit fact. */
  forkFallbackReason?: AcpSessionForkReason
  /**
 * 加载期解析的 subprocess seam（host/factory/agent-loop.ts 经
   * `resolveSubprocessSeam(ctx)` 解析一次后随 driver 传入）：懒启动的 spawn/拆除
   * 全经宿主服务。`{ok:false}`（宿主无 subprocess 服务）时首个 turn 以
   * ACP_SPAWN_FAILURE fail closed——零 spawn、零目录副作用，不自制 child_process 回退。
   */
  subprocess: SubprocessSeamResolution
  /** DSH durable attachment service. Required only when a prompt contains images. */
  attachments?: Pick<AttachmentStore, 'readImage' | 'imageLimits'>
  /**
 * 权限 seam（审批桥）：agent → client 的 `session/request_permission` 处理器。
   * 缺省走 AcpClientConnection 的 fail-closed 默认（回 `cancelled`）。
   */
  permissionHandler?: PermissionRequestHandler
  /** ACP v1 form/url elicitation handler; assigned after construction like the permission bridge. */
  elicitationHandler?: ElicitationRequestHandler
  /** Session-scoped cancellation for plugin-owned pending permission UI. */
  cancelPendingPermissions?: (sessionId: string) => void
  /** Session/plugin teardown settles pending elicitation requests. */
  cancelPendingElicitations?: (sessionId: string) => void
  /**
 * 恢复 seam（转正； 现在为整条 binding 记录）：sidecar 里读出的最新
   * 合法 binding（sidecar 持久化规则 后 binding 落 sidecar；读取与语义门槛见
   * src/persistence/sidecar.ts readLatestBinding）。`undefined` = 无可用
   * binding → 懒启动走 `session/new`（或构造期预置 'binding-missing' 闩锁，
   * 见 `presetBlocked`）。预检/对账消费的字段：canonicalCwd/launchFingerprint/
   * agent/protocolVersion/capabilityHash/configHash/generation/historyBaseSeq/
   * dshCommittedSeq（{@link AcpBindingData} 注释）。
   */
  resumeBinding?: AcpBindingRecord
  /** Durable recovery snapshot restored after a host restart. Non-healthy
   * states are fail-closed until the user explicitly recovers or rebinds. */
  recoveryState?: AcpRecoveryState
  /**
 * 恢复守卫预置的 blocked 原因（binding-in-use 双绑冲突 / binding-outdated
   * 语义门槛失败，路由层 agent-loop.ts 判定后传入）。生效即构造期置 continuity
   * 闩锁（blocked）：后续 turn 在 user/message 落盘后、懒启动前直接以
   * `ACP_RECONCILIATION_REQUIRED` 失败（零 spawn），该被拒 turn 经 blockError
   * await 落 sidecar `reconciliation` 记录。fork/全新创建路径不得设置（fork
   * 不是阻断，见 agent-loop.ts fork 防御）。
   */
  presetBlocked?: AcpReconciliationCause
  /**
 * cancel 升级阶梯的停稳等待预算（毫秒）：session/cancel 发出后限时等待
   * 本 turn 随 prompt 响应停稳，超时升级到进程 terminate。缺省
   * {@link ACP_CANCEL_SETTLE_GRACE_MS}；测试可注入短预算。
   */
  cancelGraceMs?: number
  /**
 * 恢复 seam（转正； **fail-closed**）：会话建立（new 或对账通过
   * 的 load）后、首个 prompt 前写 sidecar binding 的回调；生产接线 =
   * src/host/factory/agent-loop.ts 闭包 `sidecar.append(sessionId, {kind:'binding',
   * data})`。缺席或写失败 → AcpBindingPersistError，会话拒绝启动（不留「在跑但
   * 恢复无据」的 ACP 会话）。turn 收束后的锚点刷新（dshCommittedSeq 推进）也走
   * 本回调，那一径写失败仅 warn（下次 resume 以 'dsh-log-diverged' fail-safe）。
   */
  recordBinding?: (binding: AcpBindingData) => Promise<void>
  /** Durable current recovery state; unlike audit this is read directly after restart. */
  recordRecoveryState?: (state: AcpRecoveryState) => Promise<void>
  /**
 * 分轴审计 seam（权限与模式双轴展示）：`permission-scope`（每次 spawn 计划组装成功后的
   * Native Agent Access 准入事实）与 `agent-mode`（建立/经本插件 seam 下发的切换）两类独立
   * entry 的落盘回调；生产接线 = src/host/factory/agent-loop.ts 闭包
   * `sidecar.append(sessionId, entry)`。缺席 = 不持久化（裸 Context 单测）；
   * 写失败仅 warn 不炸 turn（审计丢失 ≠ turn 失败，同 recordBinding 纪律）。
   */
  recordAudit?: (entry: AcpSidecarEntryInput) => Promise<void>
  /**
   * 审计队列 flush seam：非审批审计（degradation/reconciliation 等）在
   * sidecar 里进有界内存队列，本回调在 turn 收束与 dispose 前落齐它们。
   * 生产接线 = src/host/factory/agent-loop.ts 闭包 `sidecar.flush()`；缺席 =
   * 无队列可落（裸 Context 单测）。失败仅 warn 不炸 turn（同 recordAudit 纪律）。
   */
  flushAudit?: () => Promise<void>
  /**
 * 待定模型切换事务 seam（sidecar `model_switches` 表；生产接线 =
   * host/factory/agent-loop.ts 闭包，sessionId 已绑定）：options-sync 的 turn
   * 时守卫（读/收敛/锁定）与 rebindBlank 的放弃清行都经此落盘。缺席 =
   * 守卫停用（裸 Context 单测；生产恒在场——sidecar 是强制前提）。
   */
  modelSwitchStore?: {
    readonly read: () => Promise<AcpPendingModelSwitchLookup | undefined>
    readonly write: (record: AcpPendingModelSwitch) => Promise<void>
    readonly clear: () => Promise<void>
  }
  /**
 * last-known option 快照 seam（sidecar `option_snapshots` 表）：活体权威
   * 快照到达（建立/set_config_option/set_mode/turn 收束变更）即刷新；恢复原
   * binding 时读取它，在首个 prompt 前把 Agent 重置的非模型配置收敛回用户上次
   * 选择。读写失败仅 warn，不炸 turn；缺席 = 不持久化/不恢复（裸 Context 单测）。
   */
  recordOptionsSnapshot?: (snapshot: AcpOptionsSnapshotRecord) => Promise<void>
  readOptionsSnapshot?: () => Promise<AcpOptionsSnapshotRecord | undefined>
  /** Native ACP filesystem handlers; a factory gives each ACP connection its own lifecycle. */
  fileSystemHandlers?: AcpFileSystemHandlers | (() => AcpFileSystemHandlers)
  /** Native ACP terminals; a factory gives each ACP connection its own lifecycle. */
  terminalHandlers?: AcpTerminalHandlers | ((context: AcpConnectionRuntimeContext) => AcpTerminalHandlers)
  recordFileAudit?: (event: import('../../runtime/client-capabilities/filesystem.ts').AcpFileOperationAudit) => Promise<void>
  /**
   * 恢复 seam（回放抑制的可选过滤器）：返回 `false` 的
   * `session/update` 不进 translator。内置抑制由 `replayActive` 旗标承担
   * （`session/load` await 全程）；本过滤器在其之后组合，保留给测试/调试。
   */
  updateFilter?: (notification: acp.SessionNotification) => boolean
  /**
 * 指标 sink（host/factory/agent-loop.ts 注入全插件共享的内存 registry）。
   * 埋点：initialize/prompt 延迟与结果、cancel、crash、恢复降级、孤儿回收失败
   * （词表见 src/domain/observability/metrics.ts）。缺席 = 不记录。
   */
  metrics?: AcpMetricsLike
  /**
 * 运行时登录态失效 seam：turn 内撞到 `auth_required`（凭证被吊销/
   * 过期等运行时漂移）时回调一次，丢弃该路由的 probe 缓存——下次 health/
   * 目录构建/创建门重探测到真实登录态。生产接线 = host/factory/agent-loop.ts
   * 闭包 `installedProfileRegistry.adapter.invalidateProbe(acp-<id>)`；缺席 = 不失效
   * （裸 Context 单测）。
   */
  invalidateProbeCache?: () => void
}

export interface AcpForkCandidate {
  readonly parentSessionId: SessionId
  readonly parentBinding: AcpBindingRecord
  readonly seedLength: number
}

/**
 * Immutable launch snapshot shared by an ACP connection and its client-owned
 * terminal host. Keeping this as a factory input prevents terminal children
 * from rebuilding environment variables independently of the Agent process.
 */
export interface AcpConnectionRuntimeContext {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * cancel 升级阶梯的停稳等待预算默认值：session/cancel 发出后，agent 按
 * 协议应以 stopReason:'cancelled' 尽快收尾原 prompt；超过该预算仍未停稳则升级到
 * 进程 terminate。正常 agent 在毫秒级响应 cancel，该预算只兜底失控 agent。
 */
export const ACP_CANCEL_SETTLE_GRACE_MS = 5_000

/** staging 回放缓冲的条目上界（session/load await 全程的可见更新暂存，对账用）。 */
export const ACP_REPLAY_STAGING_MAX_ENTRIES = 2_000
/** staging 回放缓冲的累计文本上界（字节数近似，按 JS 串 length 计）。 */
export const ACP_REPLAY_STAGING_MAX_CHARS = 8_000_000

/** A durable recovery state must be resolved before another prompt is allowed. */
class AcpRecoveryRequiredError extends Error {
  readonly code = 'ACP_RECOVERY_REQUIRED'
  constructor(readonly recovery: AcpRecoveryState) {
    super(`${recovery.detail ?? `ACP recovery is required (${recovery.kind}) before another prompt can be sent`}。${ACP_RECONCILIATION_GUIDANCE}`)
    this.name = 'AcpRecoveryRequiredError'
  }
}

/**
 * ACP 会话连续性状态（对账闩锁；domain 侧真源——contract 层的
 * `AcpSessionContinuity` 是它的 wire 副本，src/remote/service.ts 直通映射）：
 * 'ok' = 可对账/已对齐；'blocked' = 进入 reconciliation-required（cause 词表见
 * src/persistence/sidecar.ts {@link AcpReconciliationCause}，detail 是有界人类
 * 可读摘要）。进程内闩锁：置位后不再重试；重启宿主（新实例）重走对账。
 */
export type AcpSessionContinuityState =
  | { readonly status: 'ok'; readonly cause: null; readonly detail: null }
  | { readonly status: 'blocked'; readonly cause: AcpReconciliationCause; readonly detail: string | null }

/**
 * turn/end 的 error 载荷：AcpClientError 保留 kind 分类（code 取自错误的
 * `code` 字段——kind → ACP_* 的唯一映射表已随 上移到
 * src/protocol/v1/errors.ts 的 ACP_ERROR_CODES）；spawn 计划组装失败保留其
 * ACP_SPAWN_CONFIG（此前扁平为 UNKNOWN）； 的两个会话连续性错误保留各自
 * code（ACP_RECONCILIATION_REQUIRED / ACP_BINDING_PERSIST_FAILED）；其余扁平为
 * UNKNOWN（ReactLoopAgent 同款）。message 末尾追加 correlation id
 * （`[acperr-…]`，钉死的文案子串不变），供会话日志与进程日志对账。
 */
function toTurnFailure(error: unknown, loginHint: string | undefined): LlmFailure {
  if (error instanceof AcpClientError) {
    const message = error.kind === 'auth_required' && loginHint !== undefined
      ? `${error.message}; login hint: ${loginHint}`
      : error.message
    return { message: `${message} [${error.correlationId}]`, code: error.code }
  }
  if (error instanceof AcpSpawnPlanError) {
    return { message: `${error.message} [${error.correlationId}]`, code: error.code }
  }
  if (error instanceof AcpReconciliationError || error instanceof AcpBindingPersistError) {
    return { message: error.message, code: error.code }
  }
  if (error instanceof AcpPromptContentError) {
    return { message: error.message, code: 'ACP_UNSUPPORTED_CONTENT' }
  }
  if (error instanceof AcpRecoveryRequiredError) {
    return { message: error.message, code: error.code }
  }
  return { message: errorChain(error), code: 'UNKNOWN' }
}

/**
 * ACP stopReason → dsh TurnEndReason（原生 reason 词表：completed / aborted /
 * blocked / error / max-tokens / interrupted）。`cancelled` 只覆盖 agent 侧自发取消
 * （本地 cancel 的路径在 promptOnce 里以 signal 的 cause 优先）；`legacy` 是词表中
 * 「无本地 cause 记录」的既有桶。`max_turn_requests`/`refusal` 词表无对应，归入
 * error 并带稳定 code。
 */
function stopReasonToTurnEnd(reason: acp.StopReason): TurnEndReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', reason: { kind: 'legacy' } }
    case 'max_turn_requests':
      return {
        kind: 'error',
        error: { code: 'ACP_MAX_TURN_REQUESTS', message: 'ACP agent stopped: max turn requests reached' },
      }
    case 'refusal':
      return {
        kind: 'error',
        error: { code: 'ACP_REFUSAL', message: 'ACP agent refused the prompt' },
      }
    default:
      return assertNever(reason, 'ACP stopReason')
  }
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; wakeRequested: boolean }

/**
 * 一条 ACP 子进程会话上的 Agent 实现。状态机与 inbox 语义逐行对齐 ReactLoopAgent；
 * turn 驱动把 `session/prompt` 的一轮更新流经 {@link TurnTranslator} 落 dsh 日志。
 * 每 dsh 会话一个实例（AcpAgentLoop 创建）；拆卸由生命周期拥有方走
 * `cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()`。
 */
/**
 * `session/prompt` 的本地收束与远端确认事实必须分开：用户点击停止时，DSH 的
 * turn 一律是 aborted；只有 Agent 没有按 ACP 返回原 prompt 响应时，后续会话
 * 才需要进入 outcome-unknown 恢复闩锁。
 */
interface AcpPromptOutcome {
  readonly turnEnd: TurnEndReason
  readonly remoteOutcomeConfirmed: boolean
}

export class AcpAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  /**
 * 会话生命周期的显式状态机（cold → starting → live → closing →
   * disposed；转换表与纪律见 ./lifecycle.ts 模块头注释）。turn 的 busy/idle
   * 相位仍由 `phase`（ReactLoopAgent 镜像）持有，两者正交。
   */
  private readonly lifecycle = new AcpLifecycle()

  /** agent 作用域边界；生命周期拥有方在驱动静默后 dispose 它（连带拆 ACP 连接）。 */
  readonly scope: AcpAgentScope
  readonly ctx: Context

  /** 融合 dispatcher：构造一次，热路径零分配（ReactLoopAgent 同款）。 */
  private readonly dispatch: AgentEventDispatch

  private readonly driver: AcpAgentOptions
  private forkOutcome: 'inherited' | 'blank-fallback' | undefined
  private forkReason: AcpSessionForkReason | undefined
  /** Runtime-scoped history compatibility; never infer a Devin workaround for other ACP agents. */
  private historyProjectionPolicy: AcpHistoryProjectionPolicy = {}
 /** 路由 id：`acp-<id>`（注册表约定，既定行为）。 公开：dshAcp Remote `backendOf` 的活体 backend 判定读它。 */
  readonly providerRoute: string
  /**
 * 结构化日志：cordis ctx.logger 承载不变，实例级固定字段
   * dshSessionId/acpProvider 由包装绑定；逐次调用经 {@link AcpAgent.logFields}
   * 补 acpSessionId/runId/operation/duration/result。
   */
  private readonly log: AcpLogger

  private conn: AcpClientConnection | undefined
  private acpSessionId: string | undefined
  /** Latest binding used for a reconnect; unlike the constructor input this advances after each turn. */
  private resumeBindingOverride: AcpBindingData | undefined
  private startPromise: Promise<void> | undefined
  /** Monotonic fence for draft/start async work. Rebind invalidates stale completions. */
  private startGeneration = 0
  private translator: TurnTranslator | undefined
  /** 会话建立前的状态槽种子（devin 实测 config_option_update 先于 session/new 响应）。 */
  private pendingConfigOptions: acp.SessionConfigOption[] | undefined
  private pendingModeId: string | undefined
  /** `available_commands_update` 的同款种子（translator 建立前的推送/replay 期）。 */
  private pendingAvailableCommands: acp.AvailableCommand[] | undefined
  /** 本实例是否已落 initial/resume request/header（ReactLoopAgent 同款闩锁）。 */
  private requestHeaderLogged = false
  /** `session/load` await 全程为 true：回放期 routeUpdate 只播种不落盘（恢复连续性规则）。 */
  private replayActive = false
 /** cancel 升级阶梯的停稳等待预算（`driver.cancelGraceMs` 可覆盖）。 */
  private readonly cancelGraceMs: number
  /**
 * 重连残留观察窗：load 成功恢复后置位，首次触发后解除。窗内实际喂给
   * translator 且无活动 turn 括号（turn 边界内的更新归属该 turn）的内容类更新
   * 触发一次性恢复警告（resume.ts ACP_RESUME_RESIDUE_NOTE）；幂等状态槽更新
   * 不触发。
   */
  private residueWatchArmed = false
  /**
 * elicitation 降级说明的一次性闩锁（边界）：每次 elicitation/create 请求都落
   * sidecar degradation 审计 + warn，但用户可见说明每会话实例只追加一条
   * （agent 可能在单 turn 内反复请求，说明不刷屏）。rebindBlank 不复位——说明
   * 面向的是本会话历史读者，一条足够。
   */
  /**
 * config 变更代际（generation 守卫）：setConfigOption/setMode 每次进场
   * 递增；响应到达时代际已易主（并发/迟到——JSON-RPC 允许对端乱序响应）→
   * 丢弃该响应的状态应用与审计，不覆盖更新状态。
   */
  private configChangeGeneration = 0
 /** 桥（接线）：每 turn 前的原生路径同步（构造器无条件实例化）。 */
  private readonly optionsSync: AcpOptionsSync
  /**
   * options-sync 执行窗口：syncOptions 进行时为 true，`setConfigOption`/`setMode`
   * 的 idle 守卫对它放开（窗口内无 prompt 在飞：driver 串行、ensureStarted 已完成、
 * promptOnce 未开始）。窗口外的 mid-prompt 调用仍被拒。建立时模型收敛
   * （{@link convergeModelAtEstablishment}）共用同一窗口语义——它同样在 driver 内、
   * 首个 prompt 前执行。
   */
  private optionsSyncWindow = false
  /**
 * 建立时模型收敛闩锁（边界）：每次会话建立恰好一次收敛尝试（无逐 turn
   * 重试循环）；startSession 每次建立只跑一次，本闩锁是显式不变量记录与纵深
   * 防御。rebindBlank 复位（新代际 = 新一次建立）。
   */
  private establishModelConverged = false
 /** 桥（接线）：commands 服务缺席时为 undefined（构造器一次性 warn）。 */
  private readonly commandBridge: AcpCommandBridge | undefined
  /** sandboxPolicy 缺席回退 warn 的一次性闩锁（每实例）。 */
  private sandboxPolicyWarned = false
  /** danger-full-access spawn 强提示 warn 的一次性闩锁（每实例）。 */
  private fullAccessWarned = false
  /** agent-mode 审计的去重闩锁（最近一次已落条的 modeId；建立时以响应/种子兜底值初始化）。 */
  private lastAuditedModeId: string | undefined
  /**
 * 连续性闩锁：'blocked' 时后续 turn 在 user/message 落盘后、懒启动前
   * 以 ACP_RECONCILIATION_REQUIRED 失败（零 spawn）。进程内不自动复位——唯一
   * 复位路径是 {@link AcpAgent.rebindBlank}（显式放弃）或重启宿主重走对账。
   */
  private continuity: AcpSessionContinuityState = { status: 'ok', cause: null, detail: null }
  /** Durable recovery state; continuity is retained only as a legacy projection. */
  private currentRecoveryState: AcpRecoveryState
  /** Whether currentRecoveryState has been written to the sidecar in this process. */
  private recoveryDurable = false
  /** replay 策略改为 advisory 后，旧版仅回放阻断记录需要窄迁移。 */
  private legacyReplayRecoveryNeedsMigration = false
  private legacyReplayRecoveryDetail: string | undefined
  /** rebindBlank 置位：下一次建立强制 session/new（跳过 binding 预检/load），成功后复位。 */
  private forceBlank = false
  /** 上一 ACP 代际号（构造时自 driver.resumeBinding 播种；每次建立新代际后跟进）。 */
  private previousBindingGeneration: number
  /** 构造期、追加 outcome-unknown 说明消息**之前**捕获的 session.seq（对账区间扩展的上界）。 */
  private readonly baselineSeq: number
  /** 当前 turn 起点处的 session.seq（append turn/start 之前捕获；binding 锚点语义见 startSession）。 */
  private turnBaseSeq = 0
  /** 最近一次成功落盘的 binding 载荷（turn 收束后锚点刷新的底稿）。 */
  private currentBinding: AcpBindingData | undefined
  /**
   * ACP bypasses DSH's native model/tool pipeline, so it also bypasses the
   * alpha session-checkpoint policy. Keep an ordered local flush tail for
   * events emitted from ACP notifications; turn boundaries await the same
   * tail before contacting the Agent or advancing the binding anchor.
   */
  private sessionFlushTail: Promise<void> = Promise.resolve()
  private sessionFlushQueued = false
  /** Binding assembled during a draft session, but deliberately not durable until first prompt. */
  private pendingBinding: AcpBindingData | undefined
  private startMode: 'draft' | 'established' | undefined
 /** 快照去重闩锁：最近一次成功落盘的 last-known 快照内容哈希（未变不重写）。 */
  private lastPersistedSnapshotKey: string | undefined
 /** staging 回放翻译器（回放共轨：replayActive 期间 routeUpdate 喂它；undefined = 非 staging 期）。 */
  private replayTranslator: ReplayTranslator | undefined
  /** staging 缓冲的累计文本量（上界 enforcement 用；按 raw update 文本计）。 */
  private replayStagedChars = 0
  /** staging 溢出闩锁：置位后记录 advisory replay-assessment，不截断事实也不锁定会话。 */
  private replayOverflowed = false

  constructor(
    private readonly loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    driver: AcpAgentOptions,
  ) {
    this.driver = driver
    this.cancelGraceMs = driver.cancelGraceMs ?? ACP_CANCEL_SETTLE_GRACE_MS
    this.providerRoute = `acp-${driver.profile.id}`
    if (driver.resumeBinding !== undefined && driver.resumeBinding.provider !== this.providerRoute) {
      throw new AcpClientError(
        'protocol-error',
        `dsh-acp: refusing to construct ${JSON.stringify(this.providerRoute)} with a binding owned by ${JSON.stringify(driver.resumeBinding.provider)}`,
        { category: 'config' },
      )
    }
    this.log = createAcpLogger(loopCtx.logger, { dshSessionId: String(id), acpProvider: this.providerRoute })
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast((event) => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
 // 对账基线：必须在任何本 run 自己的说明消息落盘**之前**捕获（
    // resolveExpectedRange 的区间扩展上界；说明消息省略 sourceEventSeqs 本就不算
    // 可见事件，此处是双保险）
    this.baselineSeq = session.seq
    this.previousBindingGeneration = driver.resumeBinding?.generation ?? 0
    this.resumeBindingOverride = driver.resumeBinding
    this.currentRecoveryState = driver.recoveryState ?? {
      dshSessionId: String(id),
      kind: 'healthy',
      provider: this.providerRoute,
      updatedAt: Date.now(),
    }
    this.recoveryDurable = driver.recoveryState !== undefined
 // 构造期预置 blocked（无需 spawn 即可判定的三因）：路由层传入
    // binding-in-use / binding-outdated；否则「日志有本路由 ACP 历史但无 binding」
    // （sidecar 丢失/不可读）→ binding-missing。fork（parentSession 在场）与显式
    // resume 到别的 provider 的日志不阻断（保留旧行为）。闩锁生效后后续 turn 在
    // user/message 落盘后、懒启动前以 ACP_RECONCILIATION_REQUIRED 失败（零 spawn）。
    // reconciliation 记录不在此落盘（构造期不能 await，fire-and-forget 无持久化
    // 保证）——首个被拒的 turn 经 blockError await 落盘（见 turn 闩锁分支）；
    // 从未 prompt 的 blocked 会话由 health/liveSessions 的 continuity 如实披露。
    const historicalProvider = foldRequestHeader(session.events)?.config.provider
    const presetBlocked = driver.presetBlocked
      ?? (driver.resumeBinding === undefined && session.header.parentSession === undefined
        ? historicalProvider === this.providerRoute
          ? 'binding-missing' as const
          : historicalProvider?.startsWith('acp-') === true
            ? 'backend-conflict' as const
            : undefined
        : undefined)
    const persistedRecovery = driver.recoveryState
    const legacyReplayCause = persistedRecovery?.kind === 'reconciliation-required'
      && (persistedRecovery.cause === 'replay-overflow' || persistedRecovery.cause === 'replay-diverged' || persistedRecovery.cause === 'dsh-log-truncated')
      ? persistedRecovery.cause
      : undefined
    if (persistedRecovery !== undefined && legacyReplayCause !== undefined && presetBlocked === undefined) {
      // Before the replay policy became advisory these causes locked a session.
      // Keep the binding and old evidence, but do not force users through rebindBlank.
      this.currentRecoveryState = {
        dshSessionId: String(id),
        kind: 'healthy',
        provider: this.providerRoute,
        ...(persistedRecovery.acpSessionId === undefined ? {} : { acpSessionId: persistedRecovery.acpSessionId }),
        ...(persistedRecovery.generation === undefined ? {} : { generation: persistedRecovery.generation }),
        updatedAt: Date.now(),
      }
      this.continuity = { status: 'ok', cause: null, detail: null }
      this.recoveryDurable = false
      this.legacyReplayRecoveryNeedsMigration = true
      this.legacyReplayRecoveryDetail = persistedRecovery.detail ?? `legacy replay recovery cause: ${legacyReplayCause}`
    } else if (persistedRecovery !== undefined && persistedRecovery.kind !== 'healthy' && presetBlocked === undefined) {
      this.currentRecoveryState = persistedRecovery
      const persistedCause = persistedRecovery.cause
      const knownCauses: readonly string[] = ['cwd-changed', 'profile-changed', 'agent-changed', 'protocol-changed', 'capability-missing', 'id-not-found', 'load-failed', 'replay-overflow', 'replay-diverged', 'dsh-log-diverged', 'dsh-log-truncated', 'binding-in-use', 'binding-missing', 'binding-outdated', 'backend-conflict']
      const cause: AcpReconciliationCause = persistedCause !== undefined && knownCauses.includes(persistedCause)
        ? persistedCause as AcpReconciliationCause
        : persistedRecovery.kind === 'session-lost'
        ? 'id-not-found'
        : persistedRecovery.kind === 'local-history-damaged'
          ? 'dsh-log-truncated'
          : 'load-failed'
      this.continuity = { status: 'blocked', cause, detail: persistedRecovery.detail ?? null }
    }
    if (presetBlocked !== undefined) {
      this.currentRecoveryState = {
        ...this.currentRecoveryState,
        dshSessionId: String(id),
        kind: 'reconciliation-required',
        cause: presetBlocked,
        updatedAt: Date.now(),
        ...(this.currentRecoveryState.detail === undefined ? {} : { detail: this.currentRecoveryState.detail }),
      }
      this.continuity = { status: 'blocked', cause: presetBlocked, detail: null }
    }
    // 恢复连续性规则：崩溃中断尾巴（日志末条为 interrupted turn/end）→ 追加 outcome-unknown
    // 说明（不自动重试）。「末条即闩锁」：说明消息落盘后末尾改变，不会重复追加。
 // 追加在 publish 前：经 attachPrepared 的 suffix 机制随 enter 落盘（自动化测试 覆盖）。
    const interruptedTurn = detectInterruptedTail(session)
    if (interruptedTurn !== undefined) {
      // An interrupted tail is not merely an explanatory history note.  The
      // remote outcome cannot be reconstructed from DSH's log, so a resumed
      // wrapper must remain fail-closed in this process as well as after the
      // recovery row is eventually written by the first blocked prompt.
      if (this.currentRecoveryState.kind === 'healthy') {
        const detail = 'ACP turn was interrupted before restart and its remote outcome is unknown'
        this.currentRecoveryState = {
          dshSessionId: String(id),
          kind: 'outcome-unknown',
          detail,
          interruptedTurnId: String(interruptedTurn),
          provider: this.providerRoute,
          updatedAt: Date.now(),
        }
        this.continuity = { status: 'blocked', cause: 'load-failed', detail }
        this.recoveryDurable = false
      }
      try {
        appendOutcomeUnknownNote(session, this.providerRoute, interruptedTurn)
      } catch (error: unknown) {
        this.log.warn(`dsh-acp: failed to append the outcome-unknown note (${errorChain(error)})`, { operation: 'resume-note', result: 'error' })
      }
    }
    // Legacy callers that do not provide a fork candidate still get the
    // honest blank-context note. The capability-driven path defers this
    // decision until initialize, when the Agent's advertised capabilities are
    // available.
    if (session.header.parentSession !== undefined && driver.forkCandidate === undefined && !hasForkBlankNote(session)) {
      try {
        appendForkBlankNote(session, this.providerRoute, lastTurn)
      } catch (error: unknown) {
        this.log.warn(`dsh-acp: failed to append the fork-blank note (${errorChain(error)})`, { operation: 'resume-note', result: 'error' })
      }
    }
    // agent 作用域：宿主 dsh-scope 的 createScope（宿主模块实例一致性 修复，见模块头与
    // host-compat/host-scope.ts）。宿主 scope 解析在插件加载期已结算
    // （src/host/factory/agent-loop.ts 构造起 initHostScope、ACP 路由屏障处 await），此处命中缓存；init 失败过
    // 则复抛缓存错误，会话创建响亮失败。dispose 语义不变：dsh-scope 的 dispose
    // 内部即原 quiesceFiber 的同款等待（core/scope src/index.ts:115-118,145）。
    this.scope = hostCreateScope()(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    // dispose 梯子挂进作用域：scope.dispose 时拆除 ACP 连接（幂等）
    this.ctx.effect(() => () => this.closeConnection(), '@zaimokuza/dsh-acp-adapter.acpConnection()')
 // 接线：options-sync 无条件实例化（假 systemPrompt/无监听器时是纯 no-op）。
    // ctx 必须传真 AcpAgent 本体的 agent 作用域 ctx——agentEvents 以 agent 为 scope
    // key，facade 会让 scope 过滤失配。
 // 待定模型切换的 turn 时守卫（崩溃恢复的 fail-closed enforcement）。
    // corrupt 行按「无法自证」响亮击沉（绝不静默忽略）；restore/reapply 经
    // setConfigOption seam（options-sync 窗口内 idle 守卫已放开）。
    const modelSwitchStore = driver.modelSwitchStore
    this.optionsSync = createAcpOptionsSync({
      ctx: this.ctx,
      agent: this,
      providerRoute: this.providerRoute,
      modelSwitchGuard: modelSwitchStore === undefined ? undefined : {
        read: async () => {
          const lookup = await modelSwitchStore.read()
          if (lookup === undefined) return undefined
          if (lookup.status === 'corrupt') {
            throw new AcpModelSwitchLockedError(
              'undecidable',
              'dsh-acp: the persisted pending model switch record is malformed; the session is locked because the ' +
              'Agent and DSH selections cannot be proven consistent — discard the ACP context and reopen it, or start a new session',
            )
          }
          return lookup.record
        },
        restorePrevious: (pending) => this.setConfigOption(pending.optionId, pending.previousModel),
        reapplyTarget: (pending) => this.setConfigOption(pending.optionId, pending.appliedModel ?? pending.targetModel),
        markRollbackRequired: (pending) => modelSwitchStore.write({ ...pending, state: 'rollback-required' }),
        clear: () => modelSwitchStore.clear(),
      },
 // 绑定 operation 字段的结构化 logger（sink 仍是 ctx.logger）
      logger: {
        info: (message) => { this.log.info(message, this.logFields({ operation: 'options-sync' })) },
        warn: (message) => { this.log.warn(message, this.logFields({ operation: 'options-sync' })) },
      },
    })
 // 接线：slash 命令桥。经 agent 作用域 ctx 取 `commands`（cordis
    // getTraceable 带 scope 追踪：注册随 agent scope 卸载）；服务缺席一次性 warn 后跳过。
    const commands = getCtxSlot<AcpCommandRegistry>(this.ctx, 'commands')
    if (commands === undefined) {
      this.log.warn('dsh-acp: commands service (ctx.commands) is absent; ACP slash commands will not be registered for this session', { operation: 'commands', result: 'unavailable' })
      this.commandBridge = undefined
    } else {
      this.commandBridge = createAcpCommandBridge({
        commands,
        sendPrompt: (text) => {
          this.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: '@zaimokuza/dsh-acp-adapter' },
          }))
        },
        logger: { warn: (message) => { this.log.warn(message, this.logFields({ operation: 'commands' })) } },
      })
    }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /**
   * 在首个 prompt 前建立真实 ACP 会话，让界面可以提前展示 session-scoped
   * config options。这不是临时 probe 会话，但在首条用户消息前只是 draft：
   * binding 仍由真实 turn 在 prompt 发送前持久化，空白 DSH 会话仍可自由更换 backend。
   */
  async prepare(): Promise<void> {
    if (this.lifecycle.kind !== 'live' && this.lifecycle.kind !== 'starting' && this.phase.kind !== 'idle') {
      throw new Error(`agent "${this.id}": prepare is only allowed while idle`)
    }
    // Preparing the picker must not commit a semantic Agent binding.  The
    // first user prompt is the commit point; this keeps an empty DSH session
    // freely switchable between ACP profiles and native models.
    await this.ensureStarted(new AbortController().signal, 'draft')
  }

 /** 会话生命周期快照（诊断/测试面；词表与转换表见 ./lifecycle.ts）。 */
  get lifecycleState(): AcpLifecycleKind {
    return this.lifecycle.kind
  }

  /** 提交 phase 并发布外部可见的 status 跃迁（ReactLoopAgent 同款）。 */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  /**
 * 逐次日志字段：在实例固定字段（dshSessionId/acpProvider，由 log 包装
   * 绑定）之上补当时可知的事实——acpSessionId（懒启动后）、runId（子进程 pid，
   * spawn 前/拆除后缺失即省略）、加上调用点给的 operation/durationMs/result。
   */
  private logFields(extra: AcpLogFields = {}): AcpLogFields {
    const pid = this.conn?.pid
    return {
      ...(this.acpSessionId === undefined ? {} : { acpSessionId: this.acpSessionId }),
      ...(pid === undefined ? {} : { runId: `pid:${String(pid)}` }),
      ...extra,
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // 唤醒输入不能加入已中止的活动，归入下一 turn；在插入前捕获，避免 splice 观察者
    // 重入 cancel 导致重分类（ReactLoopAgent 同款闩锁）。
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    // 既定行为：维护任务照常执行（接口契约保留），但其 dsh 侧效果
    // （如 compaction 改写 surface）不回传 ACP 子进程自有上下文——记提示事件标明该落差。
    this.loopCtx.emit('dsh-acp/maintenance', { agent: this })
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * 启动一个驱动，或把唤醒闩在 maintenance / 已中止活动之后（ReactLoopAgent 同款）。
   * 空闲时的唤醒总是打开自己的 turn 边界，即使其消息在驱动 claim 前被清掉。
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // maintenance 与已中止驱动无法投递唤醒：闩锁待收敛后重放。存活驱动自行 claim
      // 队列工作；dispose 从不闩锁，拆卸不等待任何 model turn。
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** 在存活边界报告一次失败（agent/error），再抛出由驱动边界收敛。 */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    // ACP 无 step：turn 内的失败挂在翻译事件的固定 step 上，turn 外为 0
    const step = this.phase.kind === 'running' ? ACP_STEP : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) { /* turn 边界在 turn() 内推进 */ }
    } catch {
      // 已报告的失败（throwError 发过 agent/error）与取消在此驱动边界收敛
    } finally {
      /* 本驱动边界前 kick 一直持有 running phase */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * 打开一个 turn 并驱动一轮 ACP prompt。返回 true = inbox 仍有工作，换新鲜
   * AbortController 继续下一 turn（ReactLoopAgent 的 driver 循环同款）。
   */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
 // turn 起点 seq（append turn/start 之前捕获）——binding 的
    // dshCommittedSeq/historyBaseSeq 锚点取本值，不把在飞 turn 算进担保前缀
    this.turnBaseSeq = this.session.seq
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let promptDispatched = false
    let remoteOutcomeConfirmed = false
    try {
      signal.throwIfAborted()
      // ACP 一轮一个 prompt：claim 语义对齐参考实现首轮——next-step 全量 + 一个排队 turn
      const claimed = this.inbox.claim('next-turn', turn)
      // 持久化顺序（先持久化后发送的顺序）：user/message 先落 DSH 日志，再发给 ACP agent
      for (const message of claimed) {
        this.session.append('user/message', message, { surfaceOp: 'append' })
      }
      if (claimed.length === 0) {
        // 唤醒闩锁的空 turn：守住 turn 边界但不发起 prompt
        turnEnds = { kind: 'completed' }
        return false
      }
      // Reject impossible image turns before creating an ACP session. The
      // negotiated image capability is checked after initialize, but missing
      // DSH storage/limits is local knowledge and must not cause session/new.
      const claimedHasImage = claimed.some((message) => message.content.some((block) => block.type === 'image'))
      if (claimedHasImage && this.driver.attachments === undefined) {
        throw new AcpPromptContentError('dsh-acp: DSH attachment storage is unavailable; the image was not sent')
      }
      if (claimedHasImage && this.driver.attachments !== undefined && !validImageLimits(this.driver.attachments.imageLimits)) {
        throw new AcpPromptContentError('dsh-acp: DSH image limits are unavailable or invalid; the image was not sent')
      }
 // 连续性闩锁：blocked 状态下 user/message 已如实落盘，但绝不 spawn——
      // turn 以 ACP_RECONCILIATION_REQUIRED 收束（闩锁进程内不重试；出路见
      // resume.ts ACP_RECONCILIATION_GUIDANCE）。blockError 幂等于闩锁本身，
      // reconciliation 记录在此 await 落盘（每个被拒 turn 一条审计）。
      // Durable recovery is the authoritative prompt gate.  In particular,
      // pressing send again after outcome-unknown must not rewrite the state
      // as a generic reconciliation failure.
      if (this.currentRecoveryState.kind !== 'healthy' || this.continuity.status === 'blocked') {
        if (!this.recoveryDurable) {
          await this.persistRecoveryState({
            kind: this.currentRecoveryState.kind,
            ...(this.currentRecoveryState.cause === undefined ? {} : { cause: this.currentRecoveryState.cause as AcpReconciliationCause }),
            ...(this.currentRecoveryState.detail === undefined ? {} : { detail: this.currentRecoveryState.detail }),
            ...(this.currentRecoveryState.interruptedTurnId === undefined ? {} : { interruptedTurnId: this.currentRecoveryState.interruptedTurnId }),
          }, undefined, true)
          if (this.currentRecoveryState.cause !== undefined) {
            await this.noteReconciliation(this.currentRecoveryState.cause as AcpReconciliationCause, this.currentRecoveryState.detail)
          }
        }
        throw new AcpRecoveryRequiredError(this.currentRecoveryState)
      }
      await this.ensureStarted(signal, 'established')
      signal.throwIfAborted()
      // Full Access is an ACP backend invariant, not merely a spawn-time
      // setting. If the user downgrades the DSH preset after the process is
      // already live, refuse the next prompt until the client restores it.
      this.requireNativeAccess()
 // 每 turn 前的 options-sync（原生选择器路径兼容）。落在 driver 内
      // turn 顶——wakeDriver 的 running claim 必须保持同步（agent.spec 钉死
      // followup 后同步 status==='running'），driver 内多 turn 间不经过 idle，
      // optionsSyncWindow 在此落实 idle pre-driver 约束。
      await this.syncOptions(turn, signal)
      signal.throwIfAborted()
      this.logRequestHeader()
      // Keep the lifecycle error deterministic after host disposal. The
      // session-store checkpoint is deliberately before prompt side effects,
      // but it must not mask the more actionable "ACP session is not started"
      // result when the connection was already reclaimed.
      if (this.conn === undefined || this.acpSessionId === undefined) {
        throw new Error(`agent "${this.id}": ACP session is not started`)
      }
      // Alpha's checkpoint policy cannot observe ACP's direct prompt path.
      // Make the user message, turn start, and request header durable before
      // the external Agent can perform any side effect.
      await this.awaitSessionFlush('ACP prompt dispatch')
      const translator = this.requireTranslator()
      translator.beginTurn(turn)
      try {
        const prompt = await toAcpPrompt(claimed, {
          imageEnabled: this.conn?.agentCapabilities?.promptCapabilities?.image === true,
          ...(this.driver.attachments === undefined ? {} : { attachments: this.driver.attachments }),
          signal,
        })
        promptDispatched = true
        const outcome = await this.promptOnce(prompt, signal)
        turnEnds = outcome.turnEnd
        remoteOutcomeConfirmed = outcome.remoteOutcomeConfirmed
      } finally {
        // crash/cancel 路径同样收口：保留已流出的部分输出（translator 的既有能力）
        translator.endTurn()
 // ACP_EMPTY_RESPONSE：turn 正常完成但全程零可见输出（无正文、无
        // tool 事件）时落一条说明消息——不产空 assistant message，但「agent
        // 什么都没回」这个事实要对用户可见。说明消息无 sourceEventSeqs、走
        // ACP_NOTE_STEP 泳道，不进对账；落盘失败仅 warn，不翻转已定 turn 结局。
        if (turnEnds?.kind === 'completed' && !translator.turnProducedOutput) {
          try {
            appendEmptyResponseNote(this.session, this.providerRoute, turn, translator.route.model)
          } catch (error: unknown) {
            this.log.warn(`dsh-acp: failed to append the empty-response note (${errorChain(error)})`, this.logFields({ operation: 'empty-response-note', result: 'error' }))
          }
        }
      }
      // ACP v1 要求 Agent 在收到 session/cancel 后，以 stopReason=cancelled
      // 收束原 session/prompt。该响应就是远端已停稳的确认；只有连接关闭、超时
      // 升级等没有收到 prompt 响应的路径，才属于 outcome-unknown。
      if (signal.aborted && promptDispatched && !remoteOutcomeConfirmed) {
        this.continuity = { status: 'blocked', cause: 'load-failed', detail: 'ACP prompt was interrupted; its remote outcome was not confirmed' }
        await this.persistRecoveryState({ kind: 'outcome-unknown', detail: 'ACP prompt was interrupted; its remote outcome was not confirmed', interruptedTurnId: String(turn) }, undefined, true)
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        if (promptDispatched) {
          this.continuity = { status: 'blocked', cause: 'load-failed', detail: 'ACP prompt was interrupted; its remote outcome was not confirmed' }
          await this.persistRecoveryState({ kind: 'outcome-unknown', detail: 'ACP prompt was interrupted; its remote outcome was not confirmed', interruptedTurnId: String(turn) }, undefined, true)
        } else {
          this.continuity = { status: 'blocked', cause: 'load-failed', detail: 'ACP turn setup was interrupted before prompt dispatch' }
          await this.persistRecoveryState({ kind: 'reconnect-required', detail: 'ACP turn setup was interrupted before prompt dispatch' }, undefined, true)
        }
        throw error
      }
      // 连接崩溃不是普通 turn 失败：prompt 一旦可能送达 Agent，断开的传输就无法
      // 证明远端结局。先持久化恢复闩锁再暴露 turn 错误，后续发送统一进入恢复面，
      // 不在死连接上继续，也不自动重放可能已经执行过的 prompt。
      const recoverableBinding = this.currentBinding ?? this.pendingBinding ?? this.resumeBindingOverride ?? this.driver.resumeBinding
      const connectionUnusable = error instanceof AcpClientError && (error.kind === 'crash' || error.kind === 'timeout')
      if (connectionUnusable && (promptDispatched || recoverableBinding !== undefined)) {
        const detail = promptDispatched
          ? 'ACP prompt failed because the Agent connection closed; its remote outcome was not confirmed'
          : 'ACP connection closed before prompt dispatch'
        await this.persistRecoveryState({
          kind: promptDispatched ? 'outcome-unknown' : 'reconnect-required',
          detail,
          ...(promptDispatched ? { interruptedTurnId: String(turn) } : {}),
        }, undefined, true)
      }
 // 运行时 auth_required = 登录态在 probe 之后漂移（吊销/过期）——丢弃
      // probe 缓存，下次 health/目录构建/会话创建门重探测到真实状态
      if (error instanceof AcpClientError && error.kind === 'auth_required') this.driver.invalidateProbeCache?.()
      turnEnds = { kind: 'error', error: toTurnFailure(error, this.driver.profile.config.loginHint) }
      this.throwError(error)
    } finally {
      try {
        // 每条退出路径都已指派 turn 结局
        this.session.append('turn/end', { turn, reason: turnEnds! })
        try {
          await this.awaitSessionFlush('turn completion')
        } catch (error: unknown) {
          // Preserve the primary turn outcome. In particular, a host session
          // can be pruned while a post-dispose turn is being closed; replacing
          // the useful ACP "not started" error with a session-store lookup
          // failure makes the lifecycle diagnosis misleading. A successful
          // turn still fails closed when its completion checkpoint is absent.
          if (turnEnds?.kind === 'error' || turnEnds?.kind === 'aborted') {
            this.log.warn(`dsh-acp: completion checkpoint skipped after ${turnEnds.kind} turn (${errorChain(error)})`, this.logFields({ operation: 'session-flush', result: 'error' }))
          } else {
            throw error
          }
        }
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    // turn 收束（turn/end 落盘）后刷新 binding 锚点到最新日志尖（同
    // generation/historyBaseSeq/establishedAt，configHash 按当时状态重算）；写失败
    // 仅 warn——下次 resume 会以 'dsh-log-diverged' fail-safe 阻断，不静默放过
    await this.refreshBindingAnchor()
    // turn 收束后刷新 last-known option 快照（turn 内 config_options_update /
    // current_mode_update 推送已就位）；内容哈希去重，写失败仅 warn
    await this.persistOptionsSnapshot()
    // turn 收束落齐非审批审计队列（本 turn 内 fire-and-forget 落的
    // degradation 等在离开 turn 前 durable；失败仅 warn，不翻转 turn 结局）
    await this.flushAuditQueue()
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // 新鲜 controller 使旧闩锁失效：存活驱动自己 claim 队列
    phase.wakeRequested = false
    return true
  }

  /**
   * 一轮 ACP `session/prompt`。abort → 发 `session/cancel`（协议要求 agent 以
   * stopReason:'cancelled' 收尾原 prompt），本地 cause 优先于 agent 回报的 stopReason。
   * 崩溃时已流出 chunk 不丢：监听器先收，挂起的 prompt 以 crash 分类 reject。
   *
 * cancel 升级阶梯：`session/cancel` 发出后限时
   * （{@link AcpAgentOptions.cancelGraceMs}）等待本 turn 随 prompt 响应停稳——
   * 超时未停稳（失控 agent 无视 cancel）升级到进程 terminate（`conn.close()`
   * 梯子：EOF 礼貌窗口 → `terminate()` 的 SIGTERM→grace→SIGKILL 树级升级），挂起的
   * prompt 以连接关闭 reject，turn 以本地 cause 收束 aborted。这也兜住 dispose
   * 路径（disposed cause 走同一 onAbort）：失控 agent 不再能把 whenIdle 永远吊住。
   * 升级后连接已死但不自动重建——与 crash-mid-turn 钉死的 v1 边界同款（恢复是
   * resume seam 的职责，不经由本路径悄悄重开上下文）。
   *
 * 边界：本路径**不**把 turn signal/timeoutMs 传给连接层——prompt 无默认
   * 预算、取消语义全由本梯子治理；连接层的放弃/poison 只发生在调用方显式给
   * prompt 传 {@link AcpRpcOptions} 且竞速胜出时（本类从不这么做）。
   */
  private async promptOnce(prompt: acp.ContentBlock[], signal: AbortSignal): Promise<AcpPromptOutcome> {
    const conn = this.conn
    const agentSessionId = this.acpSessionId
    /* 不可达兜底：ensureStarted 先于本调用完成 */
    if (conn === undefined || agentSessionId === undefined) {
      throw new Error(`agent "${this.id}": ACP session is not started`)
    }
    // 注意：重连残留观察窗（residueWatchArmed）不在此关闭——turn 括号内的更新
    // 由 noteResumeResidueIfArmed 的 translator.inTurn 判定放行（turn 边界即归属），
    // 观察窗只兜「无活动 turn 括号」的游离更新
    const prompting = conn.prompt(agentSessionId, prompt)
    // 埋点：一轮 prompt 的延迟/结果（cancel 由 onAbort 计数，崩溃由 catch 臂计数）
    const promptStarted = Date.now()
    const onAbort = (): void => {
      this.driver.metrics?.increment(ACP_METRIC.cancel, { cause: (signal.reason as AgentCancelCause | undefined)?.kind ?? 'unknown' })
      void conn.cancel(agentSessionId).catch(() => {
        // 连接已死/已关闭时 cancel 失败无碍：挂起的 prompt 将以 crash 分类 reject
      })
      // 升级阶梯：限时等待停稳；prompt 在窗口内 settle（值或 rejection 已获响应
      // 观察，不泄漏 unhandled）则无需升级；窗口耗尽且连接仍在 → terminate
      void waitWithin(prompting, this.cancelGraceMs).then(
        (settled) => {
          if (settled !== undefined) return
          if (this.conn !== conn || conn.isClosed) return
          this.log.warn(
            `dsh-acp: session "${this.id}": the agent did not settle the turn within ` +
            `${String(this.cancelGraceMs)}ms of session/cancel; escalating to process termination`,
            this.logFields({ operation: 'cancel', result: 'escalated' }),
          )
          // 拆除失败（拿不到整树退出证明）= 孤儿回收失败：计数 + warn，不吞错误
          void conn.close().catch((error: unknown) => {
            this.driver.metrics?.increment(ACP_METRIC.orphanReapFailure)
            this.log.warn(
              `dsh-acp: process teardown after cancel escalation failed; the agent process tree may be orphaned (${errorChain(error)})`,
              this.logFields({ operation: 'teardown', result: 'error' }),
            )
          })
        },
        () => { /* prompt 已在窗口内 reject（crash 等）——turn 正常收束，无需升级 */ },
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // 纵深防御：已中止的信号不会回放 abort 事件——手动补触发，否则 cancel 帧与
    // 升级阶梯都被吞（当前调用链中 turn 的 throwIfAborted 与本方法之间是同步
    // 代码，实际不可达；防未来重排）
    if (signal.aborted) onAbort()
    try {
      const response = await prompting
      if (signal.aborted) {
        this.driver.metrics?.observe(ACP_METRIC.prompt, Date.now() - promptStarted, { result: 'cancelled' })
        return {
          turnEnd: { kind: 'aborted', reason: signal.reason as AgentCancelCause },
          remoteOutcomeConfirmed: true,
        }
      }
      this.driver.metrics?.observe(ACP_METRIC.prompt, Date.now() - promptStarted, { result: response.stopReason })
      return { turnEnd: stopReasonToTurnEnd(response.stopReason), remoteOutcomeConfirmed: true }
    } catch (error: unknown) {
      this.driver.metrics?.observe(ACP_METRIC.prompt, Date.now() - promptStarted, { result: error instanceof AcpClientError ? error.kind : 'unknown' })
      if (error instanceof AcpClientError && error.kind === 'crash') this.driver.metrics?.increment(ACP_METRIC.crash, { provider: this.providerRoute })
      if (signal.aborted) {
        return {
          turnEnd: { kind: 'aborted', reason: signal.reason as AgentCancelCause },
          remoteOutcomeConfirmed: false,
        }
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
 * options-sync 的每 turn 前同步（接线）。窗口内放开 seam 的 idle 守卫；
   * 同步失败仅 warn 不击沉 turn——ACP 侧当前值仍是权威，原生路径的兼容同步
   * 不得阻断用户工作（abort 信号照常传播）。两个响亮例外：
 * {@link AcpBackendImmutableError}——原生选择器把会话指向了别的
   * backend，继续跑会把「UI 已切换、后端忽略」的静默分叉带进本 turn；
 * {@link AcpModelSwitchLockedError}——待定模型切换无法自证收敛，
   * 不一致状态禁止 prompt。两者都必须响亮击沉。
   */
  private async syncOptions(turn: number, signal: AbortSignal): Promise<void> {
    this.optionsSyncWindow = true
    try {
      await this.optionsSync.syncBeforeTurn({ turn, signal })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      if (error instanceof AcpBackendImmutableError) throw error
      if (error instanceof AcpModelSwitchLockedError) throw error
      this.log.warn(
        `dsh-acp: pre-turn options sync failed; continuing with the ACP session's current values (${errorChain(error)}${acpErrorRef(error)})`,
        this.logFields({ operation: 'options-sync', result: error instanceof AcpClientError ? error.kind : 'error' }),
      )
    } finally {
      this.optionsSyncWindow = false
    }
  }

  /**
 * 建立时模型收敛（新会话模型收敛 收尾； 验收「新会话从目标模型启动」）：
   * 会话建立（new 或对账通过的 load）后、binding 已 durable、首个 prompt 前，
   * 把 DSH 会话的选定模型（`this.options.model`——路由/请求模型）一次性应用
   * 到 Agent。**单向 agent←DSH** DSH 侧已是用户已提交的选择，不写
   * model_switches 事务、不回写 DSH。调用点 = startSession 建立路径尾部
   * （binding 落盘与 rebindBlank 说明之后）；turn 驱动顺序保证它先于
   * options-sync 守卫、request/header 落盘与首个 prompt。
   *
   * 判定与纪律：
   * - 每次建立恰好一次（闩锁 {@link establishModelConverged}），无逐 turn 重试
   *   循环；Agent 事后推送的 config_option_update 照常刷新状态槽与快照。
   * - 待定切换行在场（含 corrupt——无法自证时守卫会响亮锁定）或守卫读失败
   *   （无法证明无行）→ 本路径让位：pending-switch 守卫（options-sync
   *   syncBeforeTurn，本 turn 稍后运行）拥有该收敛/锁定，绝不与之抢跑。
   * - Agent 未暴露 model 类 config option（category 'model' / id 'model'，同
   *   modelOfConfigOptions 规则）或该项不是 select → 无 Agent 侧实际模型证据，
   *   维持既有 request/header 兜底语义（header 记 DSH 选定值），不落说明——
   *   「分叉」无从证真，落说明只会是每会话噪音。
   * - 双侧相等 → no-op（零 RPC）。
   * - 不等且目标值在允许集 → 经既有 setConfigOption seam（连接层有界写预算 +
   *   响应权威快照替换 + last-known 快照刷新）应用；abort 在飞中止照常传播
   *   （放弃 RPC + poison 连接，startSession catch 拆除）。
   * - 不等且不可收敛（值不在允许集 / 写入未获确认）→ 追加有界用户可见分叉
   *   说明（acpModelDivergenceNote），turn 照常以 Agent 实际模型进行，
   *   request/header 诚实记录实际模型；**不锁 composer**——这是能力/行为
   *   降级，不是待定切换事务的不一致（后者仍归 pending-switch 守卫）。
   */
  private async convergeModelAtEstablishment(signal: AbortSignal): Promise<void> {
    if (this.establishModelConverged) return
    this.establishModelConverged = true
    const dshModel = this.options.model
    if (dshModel === undefined || dshModel === '') return
    const store = this.driver.modelSwitchStore
    if (store !== undefined) {
      let lookup: AcpPendingModelSwitchLookup | undefined
      try {
        lookup = await store.read()
      } catch (error: unknown) {
        this.log.warn(
          `dsh-acp: could not read the pending model switch row; yielding establish-time model convergence to the turn-time guard (${errorChain(error)})`,
          this.logFields({ operation: 'model-converge', result: 'deferred' }),
        )
        return
      }
      if (lookup !== undefined) return // 待定行在场：守卫拥有收敛（本 turn 稍后运行）
    }
    const option = this.configOptions?.find((candidate) => candidate.category === 'model' || candidate.id === ACP_MODEL_OPTION_ID)
    if (option?.type !== 'select') return
    const agentModel = option.currentValue
    if (agentModel === dshModel) return
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const noteDivergence = (reason: string): void => {
      try {
        appendModelDivergenceNote(this.session, this.providerRoute, turn, acpModelDivergenceNote(dshModel, agentModel, reason), this.translator?.route.model)
      } catch (error: unknown) {
        this.log.warn(`dsh-acp: failed to append the model-divergence note (${errorChain(error)})`, this.logFields({ operation: 'model-converge', result: 'error' }))
      }
    }
    if (!selectValuesOf(option).includes(dshModel)) {
      this.log.warn(
        `dsh-acp: the session's selected model is not among the agent's model option values; the agent stays on its own model (divergence note appended)`,
        this.logFields({ operation: 'model-converge', result: 'declined' }),
      )
      noteDivergence('the model is not among the Agent\'s allowed values; the Agent or cached catalog may have changed')
      return
    }
    // optionsSyncWindow 放开 seam 的 idle 守卫：establish 在 driver 内 turn 顶
    // 执行（phase 已 running），窗口内无 prompt 在飞，与 options-sync 同款竞态安全
    this.optionsSyncWindow = true
    try {
      await this.setConfigOption(option.id, dshModel, { signal })
      this.log.info(
        'dsh-acp: applied the DSH session model onto the agent at session establish (one-shot convergence)',
        this.logFields({ operation: 'model-converge', result: 'applied' }),
      )
    } catch (error: unknown) {
      if (signal.aborted) throw error
      this.log.warn(
        `dsh-acp: establish-time model convergence was not confirmed by the agent; the turn proceeds on the agent's own model (${errorChain(error)}${acpErrorRef(error)})`,
        this.logFields({ operation: 'model-converge', result: error instanceof AcpClientError ? error.kind : 'error' }),
      )
      noteDivergence('the Agent did not confirm the configuration write because the RPC failed or timed out')
    } finally {
      this.optionsSyncWindow = false
    }
  }

  /**
   * 恢复原 binding 时重放用户上次确认的 Agent 配置。ACP 的 resume/load 响应可能
   * 回到 Agent 默认值（Codex/Claude 的 reasoning、mode 等均实测出现）；若只恢复
   * model，UI 会显示一套值而下一 turn 实际使用另一套值。
   *
   * 安全边界：只消费同一 launch/Agent/protocol 指纹的有界 sidecar 快照；只写
   * Agent 此次建立仍广告、类型相同且值仍在 allowed-values 内的选项。model 由
   * {@link convergeModelAtEstablishment} 以 DSH 选择为真源单独处理。未知、消失、
   * 改型或不再允许的值全部跳过，绝不把旧 `_meta` 或任意配置注入新 Agent。
   */
  private async restoreOptionsAtEstablishment(
    snapshot: AcpOptionsSnapshotRecord | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (snapshot === undefined) return
    const fingerprint = this.optionsSnapshotFingerprint()
    if (snapshot.fingerprint !== fingerprint) {
      this.log.warn(
        'dsh-acp: skipped last-known Agent option restoration because its runtime fingerprint no longer matches',
        this.logFields({ operation: 'options-restore', result: 'fingerprint-mismatch' }),
      )
      return
    }
    this.optionsSyncWindow = true
    try {
      for (const saved of snapshot.options) {
        if (saved.category === 'model' || saved.id === ACP_MODEL_OPTION_ID) continue
        const current = this.configOptions?.find((candidate) => candidate.id === saved.id)
        if (current === undefined || current.currentValue === saved.value) continue
        const compatible = current.type === 'boolean'
          ? typeof saved.value === 'boolean'
          : current.type === 'select'
            ? typeof saved.value === 'string' && selectValuesOf(current).includes(saved.value)
            : false
        if (!compatible) {
          this.log.warn(
            `dsh-acp: skipped restoring Agent option "${saved.id}" because its saved value is no longer compatible`,
            this.logFields({ operation: 'options-restore', result: 'incompatible' }),
          )
          continue
        }
        try {
          await this.setConfigOption(saved.id, saved.value, { signal })
        } catch (error: unknown) {
          if (signal.aborted) throw error
          // crash/timeout 后连接已关闭或 poisoned，不能带着未知配置状态继续 prompt；
          // 交给 turn 外层转换为 reconnect-required。
          if (error instanceof AcpClientError && (error.kind === 'crash' || error.kind === 'timeout')) throw error
          this.log.warn(
            `dsh-acp: could not restore Agent option "${saved.id}"; continuing with the Agent-reported value (${errorChain(error)}${acpErrorRef(error)})`,
            this.logFields({ operation: 'options-restore', result: error instanceof AcpClientError ? error.kind : 'error' }),
          )
        }
      }
    } finally {
      this.optionsSyncWindow = false
    }
  }

  /** 建立期写配置后同步 binding 的提示性 configHash，不移动任何历史锚点。 */
  private async refreshBindingConfigAfterEstablishment(): Promise<void> {
    const binding = this.currentBinding
    if (binding === undefined) return
    const configHash = acpCanonicalHash16(configHashInput(this.configOptions, this.currentModeId))
    if (configHash === binding.configHash) return
    if (this.driver.recordBinding === undefined) {
      this.log.warn(
        'dsh-acp: could not refresh the binding config hash because recordBinding is unavailable',
        this.logFields({ operation: 'binding-refresh', result: 'unavailable' }),
      )
      return
    }
    const updated = { ...binding, configHash }
    try {
      await this.driver.recordBinding(updated)
    } catch (error: unknown) {
      // configHash 是漂移诊断，不是恢复身份或历史锚点；保留上一条 durable binding，
      // 后续恢复会明确报告 config drift，不能因提示性刷新失败击沉当前 turn。
      this.log.warn(
        `dsh-acp: failed to refresh the binding config hash (${errorChain(error)})`,
        this.logFields({ operation: 'binding-refresh', result: 'error' }),
      )
      return
    }
    this.currentBinding = updated
    this.resumeBindingOverride = updated
  }

  /**
   * 读取 DSH 权限投影和会话工作区。`ctx.sandboxPolicy` 是公开的会话模式
   * 真源；缺席时回退 read-only 并警告，从而让后续原生访问准入校验
   * fail closed。`workspaceRoot` 只用于会话关联和默认 cwd，不构成文件访问边界。
   */
  private resolveSandboxPolicy(): { mode: AcpSandboxMode; workspaceRoot: string } {
    const resolver = getCtxSlot<AcpSandboxPolicyResolver>(this.ctx, 'sandboxPolicy')
    if (resolver !== undefined) return resolver.resolve({ session: this.session })
    if (!this.sandboxPolicyWarned) {
      this.sandboxPolicyWarned = true
      this.log.warn(
        'dsh-acp: sandboxPolicy service (ctx.sandboxPolicy) is absent; ACP sessions require an explicit Native Agent Access mode',
        { operation: 'spawn-plan', result: 'degraded' },
      )
    }
    return { mode: 'read-only', workspaceRoot: this.session.header.cwd ?? process.cwd() }
  }

  /** Resolve and enforce the product-wide ACP Full Access invariant. */
  private requireNativeAccess(): { mode: AcpSandboxMode; workspaceRoot: string } {
    const policy = this.resolveSandboxPolicy()
    if (policy.mode !== 'danger-full-access') {
      throw new AcpSpawnPlanError(
        'ACP_SPAWN_CONFIG',
        `ACP session "${this.id}" requires Native Agent Access; reopen the session or switch this DSH session to danger-full-access before sending a message`,
      )
    }
    return policy
  }

  /**
 * danger-full-access spawn 的强提示（生产接线；/模式展示 修订）：一次性
   * warn（每实例闩锁）。配套的二次确认 gate 与 `dsh-acp/full-access-spawn` 事件
 * 已删除——ACP 会话由客户端自动收敛 Full Access，并在每次 prompt 前复核。
   */
  private warnUnconfinedSpawn(): void {
    if (!this.fullAccessWarned) {
      this.fullAccessWarned = true
      this.log.warn(
        `dsh-acp: session "${this.id}" spawns ACP agent "${this.driver.profile.id}" under danger-full-access: ` +
        'the subprocess is NOT confined and can modify any file the host user can reach',
        { operation: 'spawn', result: 'danger-full-access' },
      )
    }
  }

  /**
 * 分轴审计·权限范围轴：spawn 计划组装成功后落一条 `permission-scope`
   * （本次 spawn 的 Native Agent Access 准入事实；initialize/spawn 失败不回购——条目
   * 记录的是计划事实）。await 且不抛：写失败仅 warn（同 recordBinding 纪律），
   * await 保证测试可确定性断言落条。
   */
  private async notePermissionScope(plan: AcpSpawnPlan): Promise<void> {
    if (this.driver.recordAudit === undefined) return
    try {
      await this.driver.recordAudit({
        kind: 'permission-scope',
        data: {
          mode: plan.mode,
 // 平台标识随条目落盘（win32 的 enforcement 恒 partial，平台归属据此可读）
          platform: plan.platformId,
          confined: null,
        },
      })
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist the permission-scope audit (${errorChain(error)})`, this.logFields({ operation: 'audit', result: 'error' }))
    }
  }

  /**
 * 分轴审计·agent mode 轴：mode 的建立/下发事实落一条 `agent-mode`。
   * 乐观闩锁去重（undefined 或与上次落条相同则跳过——model 切换的响应快照
   * 携带未变的 mode 选项时不多落）；await 且不抛（写失败仅 warn）。agent
   * 自发推送的 `current_mode_update` 不经本方法（v1 不落条，见 ../policy/events.ts）。
   */
  private async noteAgentMode(modeId: string | undefined, via: AcpAgentModeAuditVia): Promise<void> {
    if (modeId === undefined || modeId === this.lastAuditedModeId) return
    this.lastAuditedModeId = modeId
    if (this.driver.recordAudit === undefined) return
    try {
      await this.driver.recordAudit({ kind: 'agent-mode', data: { modeId, via } })
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist the agent-mode audit (${errorChain(error)})`, this.logFields({ operation: 'audit', result: 'error' }))
    }
  }

  /**
 * 降级审计：TurnTranslator 的同步 fire-and-forget 回调经 recordAudit seam
   * 落 sidecar `degradation` kind（每次内容降级一条，不按 item 拆条）。翻译路径
   * 不能 await（同步回调），故 void + catch：写失败仅 warn 不炸 turn（审计丢失
   * ≠ turn 失败，同 recordBinding 刷新径纪律）；recordAudit 缺席（裸 Context
   * 单测）= 不持久化，内存 warning 仍在。
   */
  private noteDegradation(entry: AcpDegradationAuditData): void {
    if (this.driver.recordAudit === undefined) return
    void this.driver.recordAudit({ kind: ACP_DEGRADATION_AUDIT_KIND, data: entry }).catch((error: unknown) => {
      this.log.warn(`dsh-acp: failed to persist the degradation audit (${errorChain(error)})`, this.logFields({ operation: 'audit', result: 'error' }))
    })
  }

  /** Record the fork decision in the existing bounded sidecar audit stream. */
  private noteForkOutcome(outcome: 'inherited' | 'blank-fallback', reason: AcpSessionForkReason): void {
    if (this.driver.recordAudit === undefined) return
    void this.driver.recordAudit({ kind: ACP_SESSION_FORK_AUDIT_KIND, data: {
      outcome: outcome === 'inherited' ? 'inherited' : 'blank',
      reason,
      ...(this.session.header.parentSession === undefined ? {} : {
        parentSessionId: this.session.header.parentSession,
      }),
      ...(this.driver.forkCandidate === undefined ? {} : {
        parentAgentSessionId: this.driver.forkCandidate.parentBinding.agentSessionId,
      }),
      ...(this.acpSessionId === undefined ? {} : { agentSessionId: this.acpSessionId }),
    } }).catch((error: unknown) => {
      this.log.warn(`dsh-acp: failed to persist the session-fork audit (${errorChain(error)})`, this.logFields({ operation: 'audit', result: 'error' }))
    })
  }

  /**
   * 落齐 sidecar 的非审批审计队列（degradation/reconciliation 等走有界
   * 队列的 kind）。调用点：turn 收束（binding 锚点刷新后）与 dispose
   * （closeConnection 拆除前）。失败仅 warn——审计丢失 ≠ turn/拆除失败。
   */
  private async flushAuditQueue(): Promise<void> {
    if (this.driver.flushAudit === undefined) return
    try {
      await this.driver.flushAudit()
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to flush the sidecar audit queue (${errorChain(error)})`, this.logFields({ operation: 'audit', result: 'error' }))
    }
  }

  /**
 * 快照的运行时指纹：binding 的 launch fingerprint + initialize 握手的
   * agentInfo/protocolVersion 的 canonical 哈希（secret-free——指纹分量本身
   * 就是 secret-free 纪律产物）。冷启动 stale 读路径以当前 profile 配置重组
   * 指纹比对：不一致 → 旧快照只作诊断，不作能力结论。
   */
  private optionsSnapshotFingerprint(): string {
    return acpCanonicalHash16({
      launchFingerprint: this.currentBinding?.launchFingerprint ?? null,
      agent: {
        name: this.conn?.agentInfo?.name ?? null,
        version: this.conn?.agentInfo?.version ?? null,
      },
      protocolVersion: this.conn?.protocolVersion ?? null,
    })
  }

  /**
 * 活体权威快照到达即刷新 sidecar 的 last-known option 快照（建立、
   * set_config_option/set_mode 响应替换、turn 收束时推送变更）。标准化与有界
   * 截断在 sidecar 的 {@link acpOptionsSnapshotOf}（`_meta`/未知键不落盘）。
   * 内容哈希去重（未变不重写）；写失败仅 warn——last-known 是冷启动只读展示
   * 面，不是提交面。
   */
  private async persistOptionsSnapshot(): Promise<void> {
    const record = this.driver.recordOptionsSnapshot
    if (record === undefined) return
    const configOptions = this.configOptions
    const currentModeId = this.currentModeId
    if (configOptions === undefined && currentModeId === undefined) return // 无事实不落
    const snapshot = acpOptionsSnapshotOf(configOptions, currentModeId, this.optionsSnapshotFingerprint(), Date.now())
    const key = acpCanonicalHash16(snapshot)
    if (key === this.lastPersistedSnapshotKey) return
    try {
      await record(snapshot)
      this.lastPersistedSnapshotKey = key
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist the last-known options snapshot (${errorChain(error)})`, this.logFields({ operation: 'options-snapshot', result: 'error' }))
    }
  }

  /**
   * 首个 turn 的懒启动（幂等共享）；失败不缓存——下个 turn 以全新连接重试。
 * `signal` 是发起 turn 的取消信号（透传给 initialize/list/load/new
   * 各 setup RPC——在飞中止即放弃该 RPC 并 poison 连接；只有首次发起懒启动的
   * 调用生效，共享在飞 startPromise 的后续 turn 沿用首次的信号）。
 * 生命周期转换：cold → starting 在新建 startPromise 时提交；成功 → live、
   * 失败 → cold 在结算臂提交。若拆除在启动在飞时进场（starting → closing，
   * 见 closeConnection），结算臂让位（所有权已移交拆除路径，不回迁也不再前进）。
   */
  private ensureStarted(signal: AbortSignal, mode: 'draft' | 'established' = 'established'): Promise<void> {
    if (this.startPromise === undefined) {
      // cold → starting；disposed/closing 后到达此处 = 非法转换，fail loud
      // （相位机在 ensureStarted 前的 throwIfAborted 已挡住 dispose 后的 turn，
      // 此处是纵深防御）
      this.lifecycle.transition('starting')
      this.startMode = mode
      const generation = ++this.startGeneration
      const migration = this.migrateLegacyReplayRecovery()
      this.startPromise = migration.then(() => this.startSession(signal, mode === 'established')).then(
        async (startedConnection) => {
          // A draft can be abandoned while its ACP process is still starting.
          // Alpha has no live-agent replacement seam, so a late completion must
          // be fenced and its process reclaimed instead of becoming a ghost
          // backend in the abandoned DSH session.
          if (generation !== this.startGeneration || this.lifecycle.settling) {
            await startedConnection.close()
            if (this.conn === startedConnection) this.conn = undefined
            throw new Error(`agent "${this.id}": stale ACP start generation was discarded`)
          }
          if (this.lifecycle.kind === 'starting') this.lifecycle.transition('live')
        },
        (error: unknown) => {
          this.startPromise = undefined
          this.startMode = undefined
          if (this.lifecycle.kind === 'starting') this.lifecycle.transition('cold')
          throw error
        },
      )
    }
    const started = this.startPromise
    if (mode === 'established' && this.startMode === 'draft') {
      return started.then(() => this.commitPendingBinding())
    }
    return started
  }

  /** 首次 ACP RPC 前持久化旧版 replay 策略的窄迁移。 */
  private async migrateLegacyReplayRecovery(): Promise<void> {
    if (!this.legacyReplayRecoveryNeedsMigration) return
    const detail = this.legacyReplayRecoveryDetail
    await this.persistRecoveryState({ kind: 'healthy' }, undefined, true)
    await this.noteReplayAssessment({
      status: 'unavailable',
      detail: detail === undefined
        ? 'Legacy replay mismatch recovery was migrated to advisory audit status'
        : `Legacy replay mismatch recovery was migrated to advisory audit status: ${detail}`,
      ...(this.resumeBindingOverride?.agentSessionId === undefined ? {} : { acpSessionId: this.resumeBindingOverride.agentSessionId }),
      ...(this.resumeBindingOverride?.generation === undefined ? {} : { generation: this.resumeBindingOverride.generation }),
    })
    this.legacyReplayRecoveryNeedsMigration = false
    this.legacyReplayRecoveryDetail = undefined
  }

  /**
 * spawn → initialize →（binding 在场且非 forceBlank 时按设计说明顺序预检 +
   * 优先 session/resume；不支持时 staging load + 对账）→ 建 translator →
   * **fail-closed 写 sidecar binding**。
   * 预检顺序：canonicalCwd → launchFingerprint → agent 身份 → protocolVersion →
   * session/resume 或 loadSession 能力 →（广告 list 则分页预查，确定 miss 阻断，
   * list 抛错不权威）→ Agent 广告 resume 时直接恢复原语义会话；否则 staging
   * `session/load`（回放入有界缓冲不落盘）→ 对账（崩溃尾巴扩展区间后逐条比对）。
   * 任一失败 → {@link blockError}（continuity 闩锁 + reconciliation 记录 +
   * AcpReconciliationError），本方法 catch 拆连接、ensureStarted 失败臂回 cold；
 * capabilityHash/configHash 漂移仅 warn。正式 prompt 路径在 commit 前必须写 binding；
 * draft 预览路径只保留内存候选。binding 写缺席/失败 →
   * AcpBindingPersistError（同 catch 路径拒启）。对账通过的 load arm 重连残留
 * 观察窗（`residueWatchArmed`）。
   */
  private async startSession(signal: AbortSignal, commitBinding: boolean): Promise<AcpClientConnection> {
    const { profile } = this.driver
    const argv = [profile.config.command, ...profile.config.args]
 // fail closed：subprocess seam 缺席（宿主 composition 缺 subprocess-local
    // provider）时首个 turn 响亮失败——零 spawn、零目录副作用（先于 buildAcpSpawnPlan
    // 的 fs 副作用检查），native 路由不经过本路径。
    const subprocess = this.driver.subprocess
 // 宿主能力缺失属部署/配置问题：taxonomy 覆盖为 config
    if (!subprocess.ok) throw new AcpClientError('spawn-failure', subprocess.message, { category: 'config' })
    // ACP 正式会话的产品语义是“原生 Agent 访问”：Agent 使用自己的
    // 配置、登录、tools、skills 和 MCP。客户端会在建立 ACP backend 前自动
    // 写入 DSH `/permission danger-full-access`；本层作为纵深防线，
    // 投影/命令缺失或会话被后续降档时在 spawn 之前拒绝；正式 ACP 会话不存在
    // 受保护 data-home 兼容路径。
    const policy = this.requireNativeAccess()
    // Resolve the launch template once; Native sessions preserve the Agent's
    // own configuration and use the same environment snapshot for MCP secrets
    // and continuity fingerprinting.
    const descriptor = descriptorOf(profile.id, profile.config)
    const nativeSourceEnv = await acpLaunchEnvironment({ config: profile.config, descriptor, dataHomeStrategy: 'native' })
    const env = nativeSourceEnv
    // Binding/generation must be known before fingerprinting so resume and a
    // newly-created Agent session use the same continuity inputs.
    const binding = this.forceBlank ? undefined : this.resumeBindingOverride
    const generation = binding === undefined ? this.previousBindingGeneration + 1 : binding.generation
    // Native 会话不创建、重定向或 staging 任何 adapter-owned Agent data home。
    // Settings 探测仍拥有独立的可丢弃临时资源，不与正式 session 复用。
 // 边界：完整 launch fingerprint 一次计算（预检②与 binding 落盘共用；
    // 分量清单与显式排除项见 ./launch-fingerprint.ts 模块头注释）。
    const fingerprint = acpLaunchFingerprint({
      profileId: profile.id,
      config: profile.config,
      descriptor,
      env,
    })
    const plan = buildAcpSpawnPlan({
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      argv,
      env,
    })
    if (plan.confined === null) this.warnUnconfinedSpawn()
    await this.notePermissionScope(plan)
    const sessionCwd = this.session.header.cwd ?? process.cwd()
    const spec: AcpConnectionSpec = {
      argv,
      cwd: sessionCwd,
      env,
      spawnPlan: plan,
      subprocess: subprocess.seam,
    }
    const fileSystemHandlers = typeof this.driver.fileSystemHandlers === 'function'
      ? this.driver.fileSystemHandlers()
      : this.driver.fileSystemHandlers
    const terminalHandlers = typeof this.driver.terminalHandlers === 'function'
      ? this.driver.terminalHandlers({ cwd: sessionCwd, env })
      : this.driver.terminalHandlers
    const conn = new AcpClientConnection(spec, {
      ...(this.driver.permissionHandler === undefined ? {} : { onPermissionRequest: this.driver.permissionHandler }),
      onSessionUpdate: (notification) => { this.routeUpdate(notification) },
      // Elicitation handler is assigned by the host after the session-scoped
      // broker and Remote/UI seam are available.
      ...(this.driver.elicitationHandler === undefined ? {} : { onElicitationRequest: this.driver.elicitationHandler }),
      ...(fileSystemHandlers === undefined ? {} : { fileSystemHandlers }),
      ...(terminalHandlers === undefined ? {} : { terminalHandlers }),
 // 进程半的内核级异常告警（waitForExit 超预算）接实例结构化 logger
      onProcessWarn: (message) => { this.log.warn(message, this.logFields({ operation: 'teardown', result: 'stalled' })) },
    })
    this.conn = conn
    try {
 // 埋点：握手延迟与结果（失败臂在 catch 里补记，然后原样上抛）
      const initializeStarted = Date.now()
      try {
        await conn.initialize({ signal })
        // The narrow replay workaround is selected from the live ACP
        // handshake, never from a user-chosen profile id or template label.
        // This keeps renamed/custom profiles correct while preventing a
        // profile from impersonating a different Agent implementation.
        this.historyProjectionPolicy = conn.agentInfo?.name.toLowerCase().includes('devin') === true
          ? { runtime: 'devin' }
          : {}
        this.driver.metrics?.observe(ACP_METRIC.initialize, Date.now() - initializeStarted, { result: 'ok' })
      } catch (error: unknown) {
        this.driver.metrics?.observe(ACP_METRIC.initialize, Date.now() - initializeStarted, { result: error instanceof AcpClientError ? error.kind : 'unknown' })
        throw error
      }
      let priorOptionsSnapshot: AcpOptionsSnapshotRecord | undefined
      if (binding !== undefined && this.driver.readOptionsSnapshot !== undefined) {
        try {
          priorOptionsSnapshot = await this.driver.readOptionsSnapshot()
        } catch (error: unknown) {
          this.log.warn(
            `dsh-acp: could not read the last-known Agent option snapshot; resume will use Agent-reported defaults (${errorChain(error)})`,
            this.logFields({ operation: 'options-restore', result: 'read-error' }),
          )
        }
      }
      let established: {
        agentSessionId: string
        configOptions: acp.SessionConfigOption[] | undefined
        currentModeId: string | undefined
      } | undefined
      let forkBlankReason: string | undefined
 // canonical cwd 一次计算，预检比对与 binding 落盘共用
      const cwd = this.session.header.cwd ?? process.cwd()
      let canonicalCwd: string
      try {
        canonicalCwd = realpathSync(cwd)
      } catch (error: unknown) {
        if (binding !== undefined) {
          throw await this.blockError('cwd-changed', `cannot realpath cwd "${cwd}" (${errorChain(error)})`)
        }
        throw error
      }
      const forkCandidate = this.driver.forkCandidate
      if (forkCandidate !== undefined) {
        const parent = forkCandidate.parentBinding
        // `startSession('draft')` may run before DSH opens the child's first
        // turn.  `turnBaseSeq` is therefore still zero at that point and is
        // not the fork cut.  The factory already validated and captured the
        // immutable seed length, so use that boundary for the defense-in-depth
        // semantic check as well.  Anything appended after the seed (such as
        // the child's turn/start or user input) must not affect eligibility.
        const seed = this.session.events.slice(0, forkCandidate.seedLength)
        const parentMatches = this.session.header.parentSession === forkCandidate.parentSessionId
          && parent.provider === this.providerRoute
          // The DSH fork seed may include trailing host-only events (for
          // example a session/title update) after the parent's committed
          // semantic boundary. ACP session/fork has no atSeq, so the factory
          // and this defense-in-depth check must reject only older cuts or
          // newly visible model events, not harmless host metadata.
          && forkCandidate.seedLength >= parent.dshCommittedSeq
          // Validate only the immutable fork seed, never the draft/first-turn
          // boundary.  A short session event array is not a valid seed.
          && seed.length === forkCandidate.seedLength
          && isLatestSemanticForkSeed(seed, parent.dshCommittedSeq)
          && canonicalCwd === parent.canonicalCwd
          && acpCanonicalHash16(fingerprint) === acpCanonicalHash16(parent.launchFingerprint)
          && (conn.agentInfo?.name ?? '') === (parent.agent.name ?? '')
          && (conn.agentInfo?.version ?? '') === (parent.agent.version ?? '')
          && conn.protocolVersion === parent.protocolVersion
        if (!parentMatches) {
          forkBlankReason = 'parent binding or seed is not the latest compatible semantic boundary'
          this.forkReason = 'parent-binding-mismatch'
        } else if (!supportsFork(conn.agentCapabilities)) {
          forkBlankReason = 'Agent does not advertise session/fork'
          this.forkReason = 'agent-does-not-advertise-fork'
        } else {
          // Do not fall back to session/new when the peer advertised fork but
          // rejected the request: that would silently lose the intended
          // Agent context. The connection RPC still supplies the normal
          // timeout/abort/poison discipline.
          const forked = await conn.forkSession(parent.agentSessionId, { cwd }, { signal })
          established = {
            agentSessionId: forked.sessionId,
            configOptions: forked.configOptions ?? undefined,
            currentModeId: forked.modes?.currentModeId,
          }
          this.forkOutcome = 'inherited'
          this.forkReason = 'inherited'
        }
      }
      if (binding !== undefined) {
 // 预检（设计说明字面顺序，任一不符即 block，绝不自动降级 session/new）：
        // ① cwd canonical 形态比对
        if (canonicalCwd !== binding.canonicalCwd) {
          throw await this.blockError('cwd-changed', `binding="${binding.canonicalCwd}" current="${canonicalCwd}"`)
        }
        // ② 启动指纹（完整分量，canonical 哈希比对；env 值永不参与——
        // 密钥纪律。旧版本写出的指纹缺新键，哈希天然不等 → 既有 'profile-changed'
        // 阻断，无第二套机制）
        const bindingFingerprintHash = acpCanonicalHash16(binding.launchFingerprint)
        const currentFingerprintHash = acpCanonicalHash16(fingerprint)
        if (currentFingerprintHash !== bindingFingerprintHash) {
          this.log.warn(
            `dsh-acp: launch fingerprint changed (${bindingFingerprintHash} → ${currentFingerprintHash})`,
            this.logFields({ operation: 'resume', result: 'profile-changed' }),
          )
          throw await this.blockError('profile-changed', 'The Agent launch environment no longer matches this session binding')
        }
        // ③ agent 身份（name/version；在场性归一为 ''）
        const agentInfo = conn.agentInfo
        const agentName = agentInfo?.name ?? ''
        const agentVersion = agentInfo?.version ?? ''
        if (agentName !== (binding.agent.name ?? '') || agentVersion !== (binding.agent.version ?? '')) {
          throw await this.blockError('agent-changed', `binding="${binding.agent.name ?? ''}@${binding.agent.version ?? ''}" current="${agentName}@${agentVersion}"`)
        }
        // ④ 协议版本
        if (conn.protocolVersion !== binding.protocolVersion) {
          throw await this.blockError('protocol-changed', `binding=${String(binding.protocolVersion)} current=${String(conn.protocolVersion)}`)
        }
        // ⑤ 恢复能力：ACP 原生 session/resume 不重放展示历史，最符合 DSH
        // 作为 UI/audit 真源、Agent 作为语义上下文真源的双真源边界；仅在 Agent
        // 未广告 resume 时才使用 session/load 的完整回放对账。
        const capabilities = conn.agentCapabilities
        const supportsResume = capabilities?.sessionCapabilities?.resume != null
        if (!supportsResume && capabilities?.loadSession !== true) {
          throw await this.blockError('capability-missing')
        }
        // capabilityHash 不一致仅 warn 不阻断（至少一种恢复能力在场即前置满足，
        // 其余能力变化是对端自由）
        const capabilityHash = acpCanonicalHash16(capabilities)
        if (capabilityHash !== binding.capabilityHash) {
          this.log.warn(
            `dsh-acp: agent capabilities changed since the binding was written (hash ${binding.capabilityHash} → ${capabilityHash}); continuing (advisory only)`,
            this.logFields({ operation: 'resume', result: 'capability-drift' }),
          )
        }
        // ⑥ list 预查：广告 list 能力则分页查全，确定 miss → id-not-found；list
        // 调用本身失败不权威（继续调用协商出的恢复方法，恢复响应才是权威判定）
        if (capabilities.sessionCapabilities?.list != null) {
          let knownMissing = false
          try {
            let cursor: string | undefined
            do {
              const listed = await conn.listSessions(cursor === undefined ? {} : { cursor }, { signal })
              if (listed.sessions.some((entry) => entry.sessionId === binding.agentSessionId)) {
                cursor = undefined
                break
              }
              cursor = listed.nextCursor ?? undefined
              if (cursor === undefined) knownMissing = true
            } while (cursor !== undefined)
          } catch {
            // list 调用失败不据此阻断：继续调用协商出的恢复方法
          }
          if (knownMissing) {
            throw await this.blockError('id-not-found', `agent session "${binding.agentSessionId}" is absent from the agent's session/list`)
          }
        }
        // 无论采用哪种 Agent 恢复方法，先证明 DSH 本地日志仍覆盖 binding 担保区间。
        // session/resume 不提供回放，不能也不应伪造跨真源的逐字比较；它以同一
        // session id + 启动身份预检 + Agent 成功恢复响应作为语义连续性契约。
        const range = resolveExpectedRange(this.session.events, binding.historyBaseSeq, binding.dshCommittedSeq, this.baselineSeq)
        if (!range.ok) {
          throw await this.blockError(range.cause, range.detail)
        }
        if (supportsResume) {
          try {
            const resumed = await conn.resumeSession(binding.agentSessionId, {}, { signal })
            established = {
              agentSessionId: binding.agentSessionId,
              configOptions: resumed.configOptions ?? undefined,
              currentModeId: resumed.modes?.currentModeId,
            }
          } catch (error: unknown) {
            throw await this.blockError('load-failed', `session/resume: ${errorChain(error)}${acpErrorRef(error)}`)
          }
          await this.noteReplayAssessment({ status: 'not-compared', detail: 'session/resume restored the Agent context without a history replay; content comparison does not apply' })
        } else {
          // ⑦ load 回退：回放期（await 全程）更新入有界 staging 不落盘
          // （routeUpdate → stageReplayUpdate → ReplayTranslator——回放共轨：与 live
          // 同一个 TurnTranslator，staging sink 只记录不落盘），响应后与 DSH
          // 担保前缀对账，通过才转正。
          this.replayActive = true
          this.replayTranslator = new ReplayTranslator({
            provider: this.providerRoute,
            model: this.currentModel(),
          })
          this.replayStagedChars = 0
          this.replayOverflowed = false
          try {
            const loaded = await conn.loadSession(binding.agentSessionId, {}, { signal })
            established = {
              agentSessionId: binding.agentSessionId,
              configOptions: loaded.configOptions ?? undefined,
              currentModeId: loaded.modes?.currentModeId,
            }
          } catch (error: unknown) {
            throw await this.blockError('load-failed', `session/load: ${errorChain(error)}${acpErrorRef(error)}`)
          } finally {
            this.replayActive = false
          }
          // ⑧ load 回放评估：staged 内容始终丢弃（DSH 日志已有同内容，不重复落盘）。
          // 内容比较是诊断事实，不是 ACP session 身份/副作用安全边界；合法的
          // Agent-specific replay projection 差异不应把用户锁在仍可用的原生会话外。
          const replayTranslator = this.replayTranslator
          this.replayTranslator = undefined
          const expected = expectedVisibleHistory(this.session.events, range.from, range.to, this.historyProjectionPolicy)
          const replay = replayVisibleHistory(replayTranslator?.finish() ?? [], this.historyProjectionPolicy)
          const assessment: AcpReplayAssessmentData = this.replayOverflowed
            ? { status: 'overflow', detail: `session/load replay exceeded the staging limit (>${String(ACP_REPLAY_STAGING_MAX_ENTRIES)} entries or >${String(ACP_REPLAY_STAGING_MAX_CHARS)} chars)` }
            : (() => {
                const verdict = reconcileVisibleHistory(replay, expected)
                return verdict.ok
                  ? { status: 'matched' as const }
                  : { status: 'different' as const, detail: verdict.detail }
              })()
          await this.noteReplayAssessment(assessment)
          // 重连残留观察窗只属于 session/load：resume 按协议不得发送历史回放。
          this.residueWatchArmed = true
        }
      }
      if (established === undefined) {
        // 全新建立 / forceBlank（rebindBlank 重开）：session/new
        const created = await conn.newSession({}, { signal })
        established = {
          agentSessionId: created.sessionId,
          configOptions: created.configOptions ?? undefined,
          currentModeId: created.modes?.currentModeId,
        }
        if (this.session.header.parentSession !== undefined) {
          this.forkOutcome = 'blank-fallback'
          if (forkBlankReason === undefined) {
            forkBlankReason = 'fork context was not eligible for ACP session/fork'
            this.forkReason = this.driver.forkFallbackReason ?? (this.driver.forkCandidate === undefined ? 'candidate-not-available' : 'seed-not-latest-semantic-boundary')
          }
        }
      }
      let { configOptions, currentModeId } = established
      this.acpSessionId = established.agentSessionId
 // 响应缺字段时以响应前的推送种子兜底（devin 实测流量顺序， probe 同款）
      configOptions ??= this.pendingConfigOptions
      currentModeId ??= this.pendingModeId
      this.translator = new TurnTranslator({
        sink: sessionEventSink(this.session),
        provider: this.providerRoute,
        model: modelOfConfigOptions(configOptions) ?? this.options.model ?? '',
        degradation: (entry) => { this.noteDegradation(entry) },
        ...(terminalHandlers?.presentationSnapshot === undefined ? {} : { terminalSnapshot: terminalHandlers.presentationSnapshot }),
        ...(configOptions === undefined ? {} : { configOptions }),
        ...(currentModeId === undefined ? {} : { currentModeId }),
        ...(this.pendingAvailableCommands === undefined ? {} : { availableCommands: [...this.pendingAvailableCommands] }),
      })
 // 桥初始应用（接线）：覆盖 replay 期种子与 translator 建立前的推送
      if (this.pendingAvailableCommands !== undefined) {
        this.commandBridge?.applyAvailableCommands(this.pendingAvailableCommands)
      }
      // configHash 不一致仅 warn 不阻断（配置热漂移是对端自由；安全相关的预检在前面）
      if (binding !== undefined) {
        const configHash = acpCanonicalHash16(configHashInput(configOptions, currentModeId))
        if (configHash !== binding.configHash) {
          this.log.warn(
            `dsh-acp: session config drifted since the binding was written (hash ${binding.configHash} → ${configHash}); continuing (advisory only)`,
            this.logFields({ operation: 'resume', result: 'config-drift' }),
          )
        }
      }
 // fail-closed binding：建立（new 或对账通过的 load）后、首个 prompt 前
      // 落完整 binding。缺席/写失败 → AcpBindingPersistError——startSession catch
      // 拆连接、会话拒绝启动（不留「在跑但恢复无据」的 ACP 会话）。锚点语义：
      // dshCommittedSeq = 建立 turn 起点（turnBaseSeq，不把在飞 turn 的
      // user/message 算进担保前缀）；新代际（session/new）的 historyBaseSeq 同取
      // turnBaseSeq，load 续代沿用旧 binding 的值
      const bindingData: AcpBindingData = {
        provider: this.providerRoute,
        agentSessionId: established.agentSessionId,
        profileId: profile.id,
        canonicalCwd,
        launchFingerprint: fingerprint,
        agent: {
          ...(conn.agentInfo?.name === undefined ? {} : { name: conn.agentInfo.name }),
          ...(conn.agentInfo?.version === undefined ? {} : { version: conn.agentInfo.version }),
        },
        // initialize 成功后 negotiated 恒在场；?? 0 是纯防御（binding 语义校验要求有限 number）
        protocolVersion: conn.protocolVersion ?? 0,
        capabilityHash: acpCanonicalHash16(conn.agentCapabilities ?? null),
        configHash: acpCanonicalHash16(configHashInput(configOptions, currentModeId)),
        generation,
        historyBaseSeq: binding === undefined
          ? this.forkOutcome === 'inherited' && forkCandidate !== undefined
            ? forkCandidate.parentBinding.historyBaseSeq
            : this.turnBaseSeq
          : binding.historyBaseSeq,
        establishedAt: binding === undefined ? Date.now() : binding.establishedAt,
        dshCommittedSeq: this.turnBaseSeq,
      }
      this.pendingBinding = bindingData
      if (commitBinding || binding !== undefined) {
        await this.commitPendingBinding()
      }
      if (this.session.header.parentSession !== undefined && this.forkOutcome === 'blank-fallback' && !hasForkBlankNote(this.session)) {
        try {
          appendForkBlankNote(this.session, this.providerRoute, this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn)
        } catch (error: unknown) {
          this.log.warn(`dsh-acp: failed to append the fork-blank note (${errorChain(error)})`, this.logFields({ operation: 'resume-note', result: 'error' }))
        }
      }
      if (this.forkOutcome !== undefined) {
        this.noteForkOutcome(this.forkOutcome, this.forkReason ?? 'candidate-not-available')
      }
 // rebindBlank 重开：binding 落盘后、首个 prompt 前追加显式放弃说明；
      // 说明消息落盘失败不炸 turn（诚实性诉求 ≠ 阻断工作）
      if (commitBinding && this.forceBlank) {
        this.forceBlank = false
        try {
          const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
          appendRebindBlankNote(this.session, this.providerRoute, turn, this.translator?.route.model)
        } catch (error: unknown) {
          this.log.warn(`dsh-acp: failed to append the rebind-blank note (${errorChain(error)})`, this.logFields({ operation: 'resume-note', result: 'error' }))
        }
      }
 // 会话建立事实（initialize 完成 + ACP 会话 id 就位 + binding 落盘）落
      // 一条 info——崩溃对账的起点行；prompt 内容、env 值永不进本行。
      this.log.info(
        `dsh-acp: ACP session established (generation ${String(bindingData.generation)}, ${binding === undefined ? 'new' : 'resumed'})`,
        this.logFields({ operation: 'initialize', result: 'ok' }),
      )
      // Agent 的 resume/load 可能把非模型选项重置为默认值。首个 prompt 前从旧
      // durable 快照恢复仍兼容的子集；全新/rebindBlank 代际刻意不继承旧配置。
      await this.restoreOptionsAtEstablishment(priorOptionsSnapshot, signal)
 // 边界：建立时模型收敛（binding 已 durable、首个 prompt 前；恰好一次，
      // 内部全捕获不炸建立——abort 中止除外）。无 DSH 侧选择 / 双侧相等 /
      // 待定切换行在场（让位守卫）时为零 RPC no-op。
      await this.convergeModelAtEstablishment(signal)
      // 建立期配置写发生在初次 binding commit 之后：只刷新 configHash，完整保留
      // 原历史锚点。
      await this.refreshBindingConfigAfterEstablishment()
      // 分轴审计·agent mode 轴：记录恢复/收敛后的实际值。
      await this.noteAgentMode(this.currentModeId, 'session-setup')
      // 最终活体事实覆盖 sidecar 快照；读取旧快照必须先于此处。
      await this.persistOptionsSnapshot()
      return conn
    } catch (error: unknown) {
 // 埋点：启动路径上的 crash 分类统一在此计数（initialize/session 各阶段
      // 各计一次；prompt 阶段的 crash 由 promptOnce 计数，不经过这里）
      if (error instanceof AcpClientError && error.kind === 'crash') this.driver.metrics?.increment(ACP_METRIC.crash, { provider: this.providerRoute })
      // 启动失败拥有尚未公开的进程：先拆除再抛（无孤儿；initialize 自身回滚后幂等）
      try {
        await conn.close()
      } catch (closeError: unknown) {
 // 拆除梯子失败 = 孤儿回收失败：计数 + 结构化 warn；维持旧行为上抛
        this.driver.metrics?.increment(ACP_METRIC.orphanReapFailure)
        this.log.warn(
          `dsh-acp: startup rollback teardown failed; the agent process tree may be orphaned (${errorChain(closeError)})`,
          this.logFields({ operation: 'teardown', result: 'error' }),
        )
        throw closeError
      }
      if (this.conn === conn) this.conn = undefined
      throw error
    }
  }

  /** Persist the draft's binding exactly once, immediately before prompt dispatch. */
  private async commitPendingBinding(): Promise<void> {
    if (this.currentBinding !== undefined && this.pendingBinding === undefined) return
    const candidate = this.pendingBinding
    const resumeBinding = this.resumeBindingOverride ?? this.driver.resumeBinding
    const bindingData = candidate === undefined
      ? undefined
      : (this.forceBlank || (resumeBinding === undefined && this.forkOutcome !== 'inherited'))
        ? {
            ...candidate,
            // prepare() happens outside a turn, so its initial seq is only a
            // draft placeholder. Rebase a newly-created generation at the
            // actual first-turn boundary before writing durable state.
            historyBaseSeq: this.turnBaseSeq,
            dshCommittedSeq: this.turnBaseSeq,
          }
        : resumeBinding === undefined && this.forkOutcome === 'inherited' && this.startMode === 'draft'
          ? {
              ...candidate,
              // Draft preparation establishes the forked ACP session before
              // DSH opens its first real turn.  Its initial boundary is zero
              // only because no turn exists yet; on the first prompt advance
              // the committed prefix to that turn's immutable start while
              // retaining the parent's historyBaseSeq.
              dshCommittedSeq: this.turnBaseSeq,
            }
          : resumeBinding !== undefined && this.turnBaseSeq === 0 && candidate.dshCommittedSeq < resumeBinding.dshCommittedSeq
          ? {
              ...candidate,
              // ReconnectOriginal is setup-only and therefore has no current
              // turn boundary. Preserve the durable committed prefix rather
              // than attempting to move it backwards to the draft default 0.
              dshCommittedSeq: resumeBinding.dshCommittedSeq,
            }
          : candidate
    if (bindingData === undefined) throw new AcpBindingPersistError('ACP session was prepared without a binding candidate')
    if (this.driver.recordBinding === undefined) {
      throw new AcpBindingPersistError('recordBinding seam is absent (sidecar storage unavailable)')
    }
    try {
      await this.driver.recordBinding(bindingData)
    } catch (error: unknown) {
      throw new AcpBindingPersistError(errorChain(error))
    }
    // The binding becomes the reconnect source only after it has been durably
    // written.  A failed write must leave the old in-memory state untouched so
    // the caller cannot accidentally clear a recovery gate.
    await this.persistRecoveryState({ kind: 'healthy' }, bindingData, true)
    this.currentBinding = bindingData
    this.resumeBindingOverride = bindingData
    this.previousBindingGeneration = bindingData.generation
    this.pendingBinding = undefined
    if (this.forceBlank) {
      this.forceBlank = false
      try {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
        appendRebindBlankNote(this.session, this.providerRoute, turn, this.translator?.route.model)
      } catch (error: unknown) {
        this.log.warn(`dsh-acp: failed to append the rebind-blank note (${errorChain(error)})`, this.logFields({ operation: 'resume-note', result: 'error' }))
      }
    }
  }

  private async persistRecoveryState(
    state: Pick<AcpRecoveryState, 'kind' | 'cause' | 'detail' | 'interruptedTurnId' | 'lastUserAction'>,
    bindingOverride?: AcpBindingData | null,
    failClosed = false,
  ): Promise<void> {
    if (this.driver.recordRecoveryState === undefined) {
      if (failClosed) throw new Error('recordRecoveryState seam is absent (sidecar storage unavailable)')
      return
    }
    const binding = bindingOverride === null
      ? undefined
      : bindingOverride ?? this.currentBinding ?? this.pendingBinding ?? this.driver.resumeBinding
    // Keep the latest user action visible across the following transition. In
    // particular, a failed reconnect must not erase the fact that the user
    // selected "retry original" merely because blockError wrote a refined
    // failure kind afterwards.
    const lastUserAction = state.lastUserAction ?? this.currentRecoveryState.lastUserAction
    const persisted: AcpRecoveryState = {
      dshSessionId: String(this.id),
      ...state,
      ...(lastUserAction === undefined ? {} : { lastUserAction }),
      provider: this.providerRoute,
      ...(binding?.agentSessionId === undefined ? {} : { acpSessionId: binding.agentSessionId }),
      ...(binding?.generation === undefined ? {} : { generation: binding.generation }),
      ...(state.kind === 'healthy' ? {} : { lastAttemptAt: Date.now() }),
      updatedAt: Date.now(),
    }
    try {
      await this.driver.recordRecoveryState(persisted)
      // Durable first, process-local second.  This ordering is essential for
      // clearing a blocker: a healthy state which failed to reach the sidecar
      // must never unlock the next prompt in this process.
      this.currentRecoveryState = persisted
      this.recoveryDurable = true
      if (persisted.kind === 'healthy') {
        this.continuity = { status: 'ok', cause: null, detail: null }
      } else {
        const knownCauses: readonly string[] = ['cwd-changed', 'profile-changed', 'agent-changed', 'protocol-changed', 'capability-missing', 'id-not-found', 'load-failed', 'replay-overflow', 'replay-diverged', 'dsh-log-diverged', 'dsh-log-truncated', 'binding-in-use', 'binding-missing', 'binding-outdated', 'backend-conflict']
        const cause = persisted.cause !== undefined && knownCauses.includes(persisted.cause)
          ? persisted.cause as AcpReconciliationCause
          : persisted.kind === 'session-lost' ? 'id-not-found' as const
            : persisted.kind === 'local-history-damaged' ? 'dsh-log-truncated' as const
              : 'load-failed' as const
        this.continuity = { status: 'blocked', cause, detail: persisted.detail ?? null }
      }
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist recovery state (${errorChain(error)})`, this.logFields({ operation: 'recovery-state', result: 'error' }))
      if (failClosed) throw error
    }
  }

  /**
   * 连接级 `session/update` 入口：回放期（`replayActive`）播种状态槽 + 可见更新
 * 入 staging 缓冲（{@link stageReplayUpdate}， 对账取材），不落盘——v1
   * spec session-setup.mdx:178 要求 agent 发完全部回放 update 才回 load 响应
   * （mock 同款顺序），故旗标覆盖全部回放流量；translator 此时尚未创建， staged
   * 内容对账通过即丢弃（DSH 日志已有同内容，不重复落盘）。spec 违规者（先响应
   * 后回放）的残留更新在旗标清除后抵达：translator 建立前的瞬间只能进状态槽
   * （内容类丢弃——无落盘面）；建立后照常进 translator 无损落盘，且若仍在重连
   * 残留观察窗内（load 成功到首个 prompt 进场之间），内容类更新触发一次性恢复
 * 警告（——无 record id / turn 边界可证明去重，显示警告而非静默合并）。
   * 非回放期：先经 {@link AcpAgentOptions.updateFilter}（spike 遗留外挂过滤器），
   * translator 存在前进状态槽种子，存在后全量 feed。
   */
  private routeUpdate(notification: acp.SessionNotification): void {
    const update = notification.update
    if (this.replayActive) {
      this.seedStateSlot(update)
      this.stageReplayUpdate(update)
      return
    }
    const filter = this.driver.updateFilter
    if (filter !== undefined && !filter(notification)) return
    const translator = this.translator
    if (translator === undefined) {
      this.seedStateSlot(update)
      return
    }
    this.noteResumeResidueIfArmed(update, translator)
    translator.feed(notification)
    // 命令清单是全量替换语义，feed 后直接应用最新值。
    if (update.sessionUpdate === 'available_commands_update') {
      this.commandBridge?.applyAvailableCommands(update.availableCommands)
    }
    // Persist durable tool/output observations promptly.  Do not flush every
    // text/thought delta: ACP streams can contain thousands of those updates
    // per turn, and making each one a disk checkpoint turns rendering into a
    // token-level fsync loop.  The turn boundary below remains the
    // authoritative checkpoint for ordinary assistant output.
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.scheduleSessionFlush(`acp ${update.sessionUpdate}`)
    }
  }

  /**
   * Dispatch the DSH session durability checkpoint through the host-owned
   * sessions service.  Alpha's native checkpoint policy does not see ACP
   * notifications because they bypass the native LLM/tool pipeline.
   */
  private async flushDshSession(reason: string): Promise<void> {
    const context = this.loopCtx as unknown as {
      sessions?: { flush?: (session: Session) => Promise<boolean | void> | boolean | void }
    }
    const sessions = context.sessions ?? getCtxSlot<{ flush?: (session: Session) => Promise<boolean | void> | boolean | void }>(this.loopCtx, 'sessions')
    if (typeof sessions?.flush !== 'function') {
      throw new Error(`dsh-acp: DSH session flush seam is unavailable before ${reason}`)
    }
    // `SessionStore.flush()` returns `false` when no persistence listener is
    // installed.  That is a host configuration fact, not a rejected flush:
    // the public seam still ran its scoped checkpoint, and the ACP adapter
    // must not turn a test/headless host with an intentionally in-memory
    // session store into a prompt failure.  A configured persistence backend
    // still makes the same awaited call and propagates its own errors.
    await sessions.flush(this.session)
  }

  /** Queue one ordered observation checkpoint, coalescing a burst of updates. */
  private scheduleSessionFlush(reason: string): void {
    if (this.sessionFlushQueued) return
    this.sessionFlushQueued = true
    queueMicrotask(() => {
      this.sessionFlushQueued = false
      this.sessionFlushTail = this.sessionFlushTail
        .then(() => this.flushDshSession(reason))
        .catch((error: unknown) => {
          this.log.warn(`dsh-acp: observed ACP event checkpoint failed (${errorChain(error)})`, this.logFields({ operation: 'session-flush', result: 'error' }))
        })
    })
  }

  /** Await all previously scheduled checkpoints and then force one now. */
  private async awaitSessionFlush(reason: string): Promise<void> {
    await this.sessionFlushTail
    await this.flushDshSession(reason)
  }

  /**
   * 重连残留警告：无法证明连续性时显示恢复警告，不静默合并。
   * 观察窗内（load 成功起，首次触发后解除）实际落盘、且**无活动 turn 括号**
   * （translator.inTurn 为假——turn 边界内的更新归属该 turn，不触发）的内容类
   * 更新，无法证明是新推送还是迟到回放——内容照常保留（下方 feed 无损），追加
   * 一次性说明。状态槽三类（config_option_update / current_mode_update /
   * available_commands_update）是幂等全量快照替换，重复应用无害，不触发。
   * 闩锁：首次触发即解除；后续游离更新仍照常落盘，不再刷提示。
   */
  private noteResumeResidueIfArmed(update: acp.SessionNotification['update'], translator: TurnTranslator): void {
    if (!this.residueWatchArmed) return
    if (translator.inTurn) return
    if (update.sessionUpdate === 'config_option_update'
      || update.sessionUpdate === 'current_mode_update'
      || update.sessionUpdate === 'available_commands_update') return
    this.residueWatchArmed = false
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    try {
      appendResumeResidueNote(this.session, this.providerRoute, turn, translator.route.model)
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to append the resume-residue note (${errorChain(error)})`, this.logFields({ operation: 'resume-note', result: 'error' }))
    }
  }

  /** 会话建立前的状态槽种子（config/mode/commands 推送是内存槽，不落盘）。 */
  private seedStateSlot(update: acp.SessionNotification['update']): void {
    if (update.sessionUpdate === 'config_option_update') this.pendingConfigOptions = update.configOptions
    else if (update.sessionUpdate === 'current_mode_update') this.pendingModeId = update.currentModeId
    else if (update.sessionUpdate === 'available_commands_update') this.pendingAvailableCommands = update.availableCommands
  }

  /**
 * staging 装载（replayActive 期 routeUpdate 调用；经
   * {@link ReplayTranslator} 与 live 同轨翻译，staging sink 只记录不落盘）：
   * 回放更新入有界 staging（{@link ACP_REPLAY_STAGING_MAX_ENTRIES} 条 staged
   * 事件 / raw 文本累计 {@link ACP_REPLAY_STAGING_MAX_CHARS}），溢出置闩锁——
   * 内容评估不截断硬比；溢出也只落 advisory replay-assessment。评估结束后 staged
   * 内容整体丢弃，避免把回放事件重复写入 DSH。
   */
  private stageReplayUpdate(update: acp.SessionUpdate): void {
    const translator = this.replayTranslator
    if (translator === undefined || this.replayOverflowed) return
    const chars = (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk')
      && update.content.type === 'text'
      ? update.content.text.length
      : 0
    if (translator.stagedCount >= ACP_REPLAY_STAGING_MAX_ENTRIES || this.replayStagedChars + chars > ACP_REPLAY_STAGING_MAX_CHARS) {
      this.replayOverflowed = true
      return
    }
    translator.feed(update)
    this.replayStagedChars += chars
  }

  /**
 * 进入 reconciliation-required 的唯一收口：置 continuity 闩锁 → 计
   * `ACP_METRIC.resumeDegraded`（cause 标签，词表已扩到全
   * {@link AcpReconciliationCause}）→ 落 sidecar `reconciliation` 记录（写失败仅
   * warn）→ 返回待抛的错误。调用方一律 `throw await this.blockError(...)`；
   * startSession 的 catch 负责拆连接，ensureStarted 失败臂把 lifecycle 回 cold。
   */
  private async blockError(cause: AcpReconciliationCause, detail?: string): Promise<AcpReconciliationError> {
    try {
      await this.persistRecoveryState({
        kind: cause === 'id-not-found' ? 'session-lost' : 'reconciliation-required',
        cause,
        ...(detail === undefined ? {} : { detail }),
      }, undefined, true)
    } catch (error: unknown) {
      // Persistence failure is itself a local-history failure. Keep this
      // process closed even though the durable transition could not be saved.
      this.currentRecoveryState = {
        dshSessionId: String(this.id),
        kind: 'local-history-damaged',
        cause: 'dsh-log-truncated',
        detail: `recovery state could not be persisted: ${errorChain(error)}`,
        provider: this.providerRoute,
        updatedAt: Date.now(),
      }
      this.continuity = { status: 'blocked', cause: 'dsh-log-truncated', detail: this.currentRecoveryState.detail ?? null }
      throw error
    }
    this.driver.metrics?.increment(ACP_METRIC.resumeDegraded, { cause })
    await this.noteReconciliation(cause, detail)
    return new AcpReconciliationError(cause, detail)
  }

  private async noteReconciliation(cause: AcpReconciliationCause, detail?: string): Promise<void> {
    if (this.driver.recordAudit === undefined) return
    const binding = this.currentBinding ?? this.resumeBindingOverride ?? this.driver.resumeBinding
    try {
      await this.driver.recordAudit({
        kind: 'reconciliation',
        data: {
          cause,
          ...(detail === undefined ? {} : { detail }),
          ...(binding === undefined ? {} : { acpSessionId: binding.agentSessionId, generation: binding.generation }),
        },
      })
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist the reconciliation record (${errorChain(error)})`, this.logFields({ operation: 'reconciliation', result: 'error' }))
    }
  }

  /** Persist load replay comparison as an advisory audit row; never changes continuity. */
  private async noteReplayAssessment(assessment: AcpReplayAssessmentData): Promise<void> {
    if (this.driver.recordAudit === undefined) return
    const binding = this.currentBinding ?? this.resumeBindingOverride ?? this.driver.resumeBinding
    try {
      await this.driver.recordAudit({
        kind: 'replay-assessment',
        data: {
          ...assessment,
          ...(binding === undefined ? {} : { acpSessionId: binding.agentSessionId, generation: binding.generation }),
        },
      })
    } catch (error: unknown) {
      this.log.warn(`dsh-acp: failed to persist replay assessment (${errorChain(error)})`, this.logFields({ operation: 'reconciliation', result: 'audit-error' }))
    }
  }

  /**
 * 锚点刷新（每个 turn 收束、turn/end 落盘之后）：以当前 session.seq 重写
   * binding（担保前缀推进到日志尖），其余字段沿用建立时底稿，configHash 按当时
   * 状态槽重算。写失败仅 warn——下次 resume 会以 'dsh-log-diverged' fail-safe
   * 阻断（诚实失败，不静默放过）。连接已死（crash/拆除）时锚点不动。
   */
  private async refreshBindingAnchor(): Promise<void> {
    const binding = this.currentBinding
    if (binding === undefined || this.driver.recordBinding === undefined) return
    if (this.conn === undefined || this.acpSessionId === undefined) return
    const refreshed: AcpBindingData = {
      ...binding,
      configHash: acpCanonicalHash16(configHashInput(this.configOptions, this.currentModeId)),
      dshCommittedSeq: this.session.seq,
    }
    try {
      await this.driver.recordBinding(refreshed)
      this.currentBinding = refreshed
      this.resumeBindingOverride = refreshed
    } catch (error: unknown) {
      this.log.warn(
        `dsh-acp: failed to refresh the binding anchor (${errorChain(error)}); the next resume will fail safe with 'dsh-log-diverged'`,
        this.logFields({ operation: 'binding', result: 'error' }),
      )
    }
  }

  /** 当前 ACP 模型：configOptions 状态槽的 model 类选项 → 构造时 selection 兜底。 */
  private currentModel(): string {
    const configOptions = this.translator?.configOptions ?? this.pendingConfigOptions
    return modelOfConfigOptions(configOptions) ?? this.options.model ?? ''
  }

  /** 当前 ACP thought_level：只接受 Agent 实际广告的非空 select 值。 */
  private currentReasoningEffort(): string | undefined {
    const configOptions = this.translator?.configOptions ?? this.pendingConfigOptions
    return reasoningEffortOfConfigOptions(configOptions)
  }

  /**
   * `request/header` 落盘（既定行为）：首个 turn 落 `{provider:'acp-<id>',
   * model:<ACP 当前模型>}`（initial；日志已有 header 的 resume 场景落 resume），
   * 模型变化时落 change。模型从 translator route/状态槽读（热切换经 setRoute 同步）。
 * 当前模型未知（空串）时的兜底链（修复）：日志末个 header 的模型 →
   * ACP_UNKNOWN_MODEL 哨兵——request/header 同样受 seed 校验（core/session
   * assertCurrentLlmShape 要求 provider/model 非空），空 model 落盘会让整条
 * 日志永久不可 resume/fork（自动化测试 实证同款机理）。
   */
  private logRequestHeader(): void {
    const translator = this.requireTranslator()
    const baseline = this.session.requestHeader()
    const knownModel = this.currentModel()
    const model = knownModel !== '' ? knownModel
      : baseline !== undefined && baseline.config.model !== '' ? baseline.config.model
      : ACP_UNKNOWN_MODEL
    const reasoningEffort = this.currentReasoningEffort()
    const route = {
      provider: this.providerRoute,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    }
    const current = translator.route
    if (current.provider !== route.provider || current.model !== route.model) translator.setRoute(route)
    const header = canonicalHeader({ config: route })
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }
  }

  private requireTranslator(): TurnTranslator {
    if (this.translator === undefined) throw new Error(`agent "${this.id}": ACP session is not started`)
    return this.translator
  }

  /**
   * 拆 ACP 连接（AcpClientConnection.close 梯子，幂等）；挂进作用域 effect。
 * 生命周期：cold/live/starting → closing → disposed；已收敛
   * （closing/disposed）的重入直接返回——幂等重入不算非法转换
   * （./lifecycle.ts 模块头纪律）。
   */
  private async closeConnection(): Promise<void> {
    if (this.lifecycle.settling) return
    // dispose 前落齐非审批审计队列（拆除后 recordAudit 仍可用——sidecar
    // 无连接依赖，但队列随进程/插件生命周期，落齐窗口在此）
    await this.flushAuditQueue()
    const conn = this.conn
    this.lifecycle.transition('closing')
    this.conn = undefined
    try {
      await conn?.close()
    } catch (error: unknown) {
 // 拆除梯子失败 = 拿不到整树退出证明（孤儿回收失败）：计数 + 结构化
      // warn 后原样上抛（dispose 链的旧行为不变）
      this.driver.metrics?.increment(ACP_METRIC.orphanReapFailure)
      this.log.warn(
        `dsh-acp: connection teardown failed; the agent process tree may be orphaned (${errorChain(error)})`,
        this.logFields({ operation: 'teardown', result: 'error' }),
      )
      throw error
    } finally {
      this.driver.cancelPendingPermissions?.(String(this.id))
      this.driver.cancelPendingElicitations?.(String(this.id))
      this.lifecycle.transition('disposed')
    }
  }

 // ---- 配置 seam（options-sync / dshAcp Remote service 消费） ----

 /** 当前 ACP 会话 id（懒启动后存在； 标记事件 / Remote options 消费）。 */
  get agentSessionId(): string | undefined {
    return this.acpSessionId
  }

  /** 创建当前 ACP wrapper 时 DSH 实际交付的模型；空白会话的全局默认变化不能改写它。 */
  get selectedModel(): string | undefined {
    return this.options.model
  }

  /** Backend phase used by the picker guard. A live ACP wrapper is only a draft
   * until its binding has been committed before the first prompt. */
  get backendState(): 'blank' | 'draft' | 'established' {
    if (this.currentBinding !== undefined) return 'established'
    if (this.startPromise !== undefined || this.conn !== undefined || this.pendingBinding !== undefined) return 'draft'
    return 'blank'
  }

 /** 连续性状态（对账闩锁； dshAcp Remote 经 AcpLiveAgentFace 消费）。 */
  get continuityState(): AcpSessionContinuityState {
    return this.continuity
  }

  /** Durable recovery state exposed to the public remote snapshot. */
  get recoveryState(): AcpRecoveryState {
    return this.currentRecoveryState
  }

  /** Record a user decision made on the recovery surface without changing the
   * recovery kind. The action is durable evidence, not an implicit unlock. */
  async recordRecoveryAction(action: 'retry-original' | 'rebind-blank' | 'new-session'): Promise<void> {
    await this.persistRecoveryState({
      kind: this.currentRecoveryState.kind,
      ...(this.currentRecoveryState.cause === undefined ? {} : { cause: this.currentRecoveryState.cause as AcpReconciliationCause }),
      ...(this.currentRecoveryState.detail === undefined ? {} : { detail: this.currentRecoveryState.detail }),
      ...(this.currentRecoveryState.interruptedTurnId === undefined ? {} : { interruptedTurnId: this.currentRecoveryState.interruptedTurnId }),
      lastUserAction: action,
    }, undefined, true)
  }

  /**
   * Reconnect the original ACP session after a recoverable interruption.
   * This deliberately keeps the existing binding/session id and only performs
   * initialize + protocol-native resume（或 load/replay fallback）。它不会创建新的
   * ACP session，也不会发送 prompt。
   */
  async reconnectOriginal(): Promise<void> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}": reconnectOriginal is only allowed while idle`)
    if (this.lifecycle.settling) throw new Error(`agent "${this.id}": reconnectOriginal is not available while the session is closing`)
    if (this.currentRecoveryState.kind === 'healthy') throw new Error(`agent "${this.id}": reconnectOriginal is only available while recovery is required`)
    const binding = this.currentBinding ?? this.resumeBindingOverride
    if (binding === undefined) throw new Error(`agent "${this.id}": no original ACP binding is available to reconnect`)
    // Record the user action before any teardown. If the reconnect fails, the
    // ensuing blocker transition inherits this marker for audit/UI diagnosis.
    await this.persistRecoveryState({
      kind: this.currentRecoveryState.kind,
      ...(this.currentRecoveryState.cause === undefined ? {} : { cause: this.currentRecoveryState.cause as AcpReconciliationCause }),
      ...(this.currentRecoveryState.detail === undefined ? {} : { detail: this.currentRecoveryState.detail }),
      ...(this.currentRecoveryState.interruptedTurnId === undefined ? {} : { interruptedTurnId: this.currentRecoveryState.interruptedTurnId }),
      lastUserAction: 'retry-original',
    }, binding, true)
    const old = this.conn
    this.conn = undefined
    this.startGeneration += 1
    this.startPromise = undefined
    this.startMode = undefined
    this.translator = undefined
    this.acpSessionId = undefined
    this.pendingBinding = undefined
    this.pendingConfigOptions = undefined
    this.pendingModeId = undefined
    this.pendingAvailableCommands = undefined
    this.currentBinding = undefined
    this.forceBlank = false
    this.resumeBindingOverride = binding
    // reconnect 是同一语义会话的一次新建立；首个 prompt 前必须重新执行一次
    // model/config 收敛，不能沿用上一条连接的 one-shot 闩锁。
    this.establishModelConverged = false
    try {
      await old?.close()
    } finally {
      if (this.lifecycle.kind === 'live') this.lifecycle.transition('cold')
    }
    // Re-establish 优先执行 session/resume；Agent 未广告时才走 session/load 与
    // 既有回放门。它不调用 prompt；下一次用户 turn 仍是独立显式动作。
    await this.ensureStarted(new AbortController().signal, 'established')
  }

  /**
 * rebindBlank（设计说明）：显式放弃旧 ACP 上下文并拆除当前连接，会话回到
   * 懒启动前形态（live → cold），下个 turn 以 `session/new` 全新建立（新代际 =
   * previousBindingGeneration+1；binding 落盘后、prompt 前追加
   * {@link ACP_REBIND_BLANK_NOTE} 说明——文案在 ./resume.ts）。仅 idle 可调用
 * （执行中拒绝是 同款策略）；settling（closing/disposed）抛错。连接拆除
   * 失败 = 孤儿回收失败：计数 + warn 后上抛（lifecycle 仍回 cold——连接句柄已
 * 丢弃，闩锁已复位，重开路径不被卡死）。Native 会话不创建或删除 Agent
   * data home；它只拆除当前 ACP 连接并让下一次建立获得新代际。
   */
  async rebindBlank(): Promise<void> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}": rebindBlank is only allowed while idle`)
    if (this.lifecycle.settling) throw new Error(`agent "${this.id}": session is closing/disposed; rebindBlank is not available`)
    const conn = this.conn
    this.conn = undefined
    this.startGeneration += 1
    // 先复位全部会话状态：即使拆除上抛，下一次建立也不得摸到旧代际残渣
    this.forceBlank = true
    this.continuity = { status: 'ok', cause: null, detail: null }
    this.translator = undefined
    this.acpSessionId = undefined
    this.startPromise = undefined
    this.startMode = undefined
    this.pendingBinding = undefined
    this.pendingConfigOptions = undefined
    this.pendingModeId = undefined
    this.pendingAvailableCommands = undefined
    this.currentBinding = undefined
    this.replayTranslator = undefined
    this.replayStagedChars = 0
    this.replayOverflowed = false
    this.residueWatchArmed = false
 // 边界：新代际 = 新一次建立，建立时模型收敛闩锁复位（下次建立重新收敛一次）
    this.establishModelConverged = false
 // 放弃 = 新代际，挂起的模型切换事务随旧代际作废——清行让新会话不再被
    // 旧事务锁定。仅 warn 不上抛：清行失败时遗留行会在下个 turn 的 options-sync
    // 守卫处如实锁定（fail-closed），不静默放过
    if (this.driver.modelSwitchStore !== undefined) {
      try {
        await this.driver.modelSwitchStore.clear()
      } catch (error: unknown) {
        this.log.warn(`dsh-acp: failed to clear the pending model switch during rebindBlank (${errorChain(error)})`, this.logFields({ operation: 'model-switch', result: 'error' }))
      }
    }
    try {
      await conn?.close()
    } catch (error: unknown) {
      this.driver.metrics?.increment(ACP_METRIC.orphanReapFailure)
      this.log.warn(
        `dsh-acp: connection teardown during rebindBlank failed; the agent process tree may be orphaned (${errorChain(error)})`,
        this.logFields({ operation: 'teardown', result: 'error' }),
      )
      throw error
    } finally {
      if (this.lifecycle.kind === 'live') this.lifecycle.transition('cold')
    }
    // Explicit rebind is a user-confirmed recovery action; clear the durable
    // blocker immediately, before the next prompt creates the new generation.
    await this.persistRecoveryState({ kind: 'healthy', lastUserAction: 'rebind-blank' }, null, true)
  }

 /** 当前 open turn 的 abort signal（running 时存在； 审批桥的 `turnSignal` 消费）。 */
  get turnAbortSignal(): AbortSignal | undefined {
    return this.phase.kind === 'running' ? this.phase.abort.signal : undefined
  }

  /** Bounded tool identity for permission correlation; raw arguments stay internal, while a bounded summary crosses the translator seam. */
  getToolCallPresentationSnapshot(toolCallId: string): AcpToolCallPresentationSnapshot | undefined {
    return this.translator?.getToolCallPresentationSnapshot(toolCallId)
  }

  /** 最新 configOptions 快照（translator 状态槽；未启动时为会话建立前的推送种子）。只读。 */
  get configOptions(): readonly acp.SessionConfigOption[] | undefined {
    return this.translator?.configOptions ?? this.pendingConfigOptions
  }

  /**
 * 本会话 initialize 握手的 agent capabilities 实际值（能力披露的数据源；
 * dshAcp Remote service 经 AcpLiveAgentFace 消费）。未懒启动（尚无握手）时如实为
   * undefined——绝不拿 probe 缓存冒充本会话事实。
   */
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.conn?.agentCapabilities
  }

  /** 最新模式 id（`current_mode_update` 推送或会话响应种子）；未知前为 undefined。 */
  get currentModeId(): string | undefined {
    return this.translator?.currentModeId ?? this.pendingModeId
  }

  /** 最新 slash 命令清单（由 `available_commands_update` 推送并由命令桥消费）。只读。 */
  get availableCommands(): readonly acp.AvailableCommand[] | undefined {
    return this.translator?.availableCommands ?? this.pendingAvailableCommands
  }

  /**
   * 最新已知 ACP 上下文占用（独立 context 统计的 live state 数据源；
   * dshAcp Remote service 经 AcpLiveAgentFace 消费）。translator 在场且收到过
   * `usage_update` 时为快照；会话未懒启动/重启后未收到新推送时如实归 null
   * ——绝不拿零值或伪 TokenUsage 冒充。
   */
  get contextUsage(): AcpContextUsageSnapshot | null {
    return this.translator?.contextUsage ?? null
  }

  /**
   * `session/set_config_option` 直通（模型/模式/思考强度热切换）。仅空闲可调用（执行中
   * 竞态写入会在此拒绝；唯一例外是 optionsSyncWindow——driver 内 turn 顶的
   * options-sync 窗口。类型保真：select
   * 传 string 值 id，boolean 传原生 boolean。成功后按规范用响应的完整
   * configOptions 快照替换 translator 槽与内存种子。
   *
   * generation 守卫：config change 使用 generation/correlation。并发或迟到响应
   * （JSON-RPC 允许对端乱序应答）
   * 到达时代际已易主 → 丢弃其快照应用与审计（warn 如实记录），最终状态以最新
   * 一次进场为准。隐含假设（如实声明）：对端按到达顺序实际应用写入，乱序只发生
   * 在应答侧——乱序处理的对端本守卫无法识别。
   *
 * 已知代价：translator 唯一的槽位写入口是 feed()，此处合成一条
   * `config_option_update` 通知喂入，空闲时会留一条 `update-outside-turn` warning
   * （纯记录，无事件落盘、翻译继续）。
   */
  async setConfigOption(configId: string, value: string | boolean, options: { signal?: AbortSignal } = {}): Promise<void> {
    // optionsSyncWindow 放开：syncOptions 在 driver 内 turn 顶执行时 phase 已是
    // running，但窗口内无 prompt 在飞（driver 串行、promptOnce 未开始），竞态安全
    if (this.phase.kind !== 'idle' && !this.optionsSyncWindow) {
      throw new Error(`agent "${this.id}": setConfigOption is only allowed while idle`)
    }
    const conn = this.conn
    const agentSessionId = this.acpSessionId
    if (conn === undefined || agentSessionId === undefined) {
      throw new Error(`agent "${this.id}": ACP session is not started yet (no turn has run)`)
    }
    const generation = ++this.configChangeGeneration
 // 连接层自带 DEFAULT_SESSION_WRITE_TIMEOUT_MS 预算；调用方 signal
    // （options-sync 的 turn 信号）在飞中止 = 放弃本 RPC + poison 连接
    const response = await conn.setConfigOption(agentSessionId, configId, value, options)
    if (generation !== this.configChangeGeneration) {
      this.log.warn(
        `dsh-acp: session "${this.id}": discarding a late set_config_option response for "${configId}" ` +
        '(superseded by a newer config change; generation guard)',
        this.logFields({ operation: 'config-change', result: 'superseded' }),
      )
      return
    }
    this.pendingConfigOptions = response.configOptions
    this.requireTranslator().feed({
      sessionId: agentSessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: response.configOptions },
    })
 // 分轴审计：响应快照里的 mode 选项（category 优先、id 兜底，同 modelOfConfigOptions
    // 手法）——经本 seam 下发的切换落 'set_config_option' 条目；未变值由闩锁去重
    const modeOption = response.configOptions.find(
      (candidate) => candidate.category === 'mode' || candidate.id === ACP_MODE_OPTION_ID,
    )
    await this.noteAgentMode(modeOption?.type === 'select' ? modeOption.currentValue : undefined, 'set_config_option')
 // 权威响应快照刚替换状态槽，同步刷新 last-known 快照
    await this.persistOptionsSnapshot()
  }

  /**
   * `session/set_mode` 直通。仅空闲可调用。`set_mode` 响应为空，规范上 agent 应以
   * `current_mode_update` 推送确认；为不依赖推送，成功后同步一次状态槽（重复设置幂等，
   * 同样会留一条 `update-outside-turn` warning）。generation 守卫同
   * {@link setConfigOption}（共享同一代际计数——两 seam 写入重叠的 mode 状态槽）。
   */
  async setMode(modeId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    // 同 setConfigOption：optionsSyncWindow 内放开 idle 守卫
    if (this.phase.kind !== 'idle' && !this.optionsSyncWindow) {
      throw new Error(`agent "${this.id}": setMode is only allowed while idle`)
    }
    const conn = this.conn
    const agentSessionId = this.acpSessionId
    if (conn === undefined || agentSessionId === undefined) {
      throw new Error(`agent "${this.id}": ACP session is not started yet (no turn has run)`)
    }
    const generation = ++this.configChangeGeneration
    await conn.setMode(agentSessionId, modeId, options)
    if (generation !== this.configChangeGeneration) {
      this.log.warn(
        `dsh-acp: session "${this.id}": discarding a late set_mode response for "${modeId}" ` +
        '(superseded by a newer config change; generation guard)',
        this.logFields({ operation: 'config-change', result: 'superseded' }),
      )
      return
    }
    this.pendingModeId = modeId
    this.requireTranslator().feed({
      sessionId: agentSessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
    })
 // 分轴审计：legacy `set_mode` 路径的切换落 'set_mode' 条目
    await this.noteAgentMode(modeId, 'set_mode')
 // mode 变更同步刷新 last-known 快照
    await this.persistOptionsSnapshot()
  }
}

/** 从 configOptions 快照取当前模型：category 'model' 优先，id 'model' 兜底（category 是 UX 提示，可缺席）。 */
function modelOfConfigOptions(configOptions: readonly acp.SessionConfigOption[] | undefined): string | undefined {
  const option = configOptions?.find((candidate) => candidate.category === 'model' || candidate.id === 'model')
  return option?.type === 'select' ? option.currentValue : undefined
}

/** 从 Agent 广告的 thought_level 选择项取得有效推理强度；缺失时诚实省略。 */
function reasoningEffortOfConfigOptions(configOptions: readonly acp.SessionConfigOption[] | undefined): string | undefined {
  const option = configOptions?.find(
    (candidate) => candidate.category === 'thought_level'
      || candidate.id === 'thought_level'
      || candidate.id === 'reasoning_effort',
  )
  if (option?.type !== 'select' || typeof option.currentValue !== 'string' || option.currentValue.length === 0) return undefined
  return option.currentValue
}

/**
 * configHash 的 canonical 输入：configOptions 折到 id+当前值（select 的
 * currentValue；其余类型如实省略 value）+ currentModeId。建立、预检比对、锚点
 * 刷新三处共用同一算法（sha256-16 见 sidecar.ts acpCanonicalHash16）。
 */
function configHashInput(
  configOptions: readonly acp.SessionConfigOption[] | undefined,
  currentModeId: string | undefined,
): unknown {
  return {
    configOptions: (configOptions ?? []).map((option) => ({
      id: option.id,
      ...(option.type === 'select' ? { value: option.currentValue } : {}),
    })),
    currentModeId: currentModeId ?? null,
  }
}
