/**
 * AcpAgentLoop：创建/恢复路由工厂（分层自 src/index.ts 切出的类实现；
 * 插件入口面经 src/host/composition/index.ts → src/index.ts re-export 挂载）。
 * Once cordis.patch.yml is enabled, its patch disables the original
 * `agent-loop` row and inserts this package under a fresh id, so this Service
 * subclass replaces the loop. The Loader mounts the default export with the
 * row's config. All non-ACP behavior delegates to `super`.
 *
 * Routing: `createAgent` routes on `options.agentOptions.provider`
 * and `resume` is marker-first (sidecar 持久化规则): the sidecar binding (`provider` /
 * `agentSessionId`, keyed by dsh sessionId under `<dshHome>/dsh-acp/`) wins;
 * without a binding record it falls back to the persisted log's last
 * `request/header` provider (read-only `inspect` peek). A provider that hits
 * the ACP registry (`acp-<id>`, settings-synced) builds an {@link AcpAgent}
 * through the publication protocol frames in `host-compat` — the
 * parent's `prepare`/`setupAndPublish`/`resumeWith` are `private` and hard-code
 * `ReactLoopAgent`, so no override point exists; the frames are verbatim twins
 * pinned against dsh-v0.1.1-rc.2 by test/host-compat.spec.ts and guarded at
 * runtime by the host structure gate. Before a binding is reused, the
 * double-bind guard ({@link AcpAgentLoop.guardBindingReuse}) refuses a
 * recorded ACP session that is still bound to another ACTIVE dsh session —
 * since the refusal **blocks** the session (`binding-in-use`
 * reconciliation-required, zero spawn) instead of degrading to `session/new`.
 * The same holds for a binding that fails the semantic gate
 * (`binding-outdated`). Forked sessions
 * never restore a binding (fork defense: `createAcpMachine` drops
 * `resumeBinding` when `session.header.parentSession` is present;
 * 恢复连续性规则 fork = `session/new`).
 * Everything else (including the `create()` config path — config-driven ACP
 * entries keep the stock ReactLoopAgent and fail loudly on the stub route,
 *  v1 boundary) delegates to the parent unchanged.
 *
 * Teardown parity: ACP lifecycles register with the ownership twin in
 * `host-compat` ({@link AcpFactoryOwnership}) — the parent's `ownership` is
 * private, and a shared tracker would couple the two disposal lifecycles anyway.
 *
 * Fail closed  : the host structure gate
 * (`host-compat/structure-gate.ts`) requires the host
 * `@deepseek-ai/dsh-agent-loop` to be >= 0.1.1-rc.2 and every ACP-consumed
 * seam to be present. A drifted, outdated, or unresolvable host disables ACP
 * routes only — session creation rejects with an `ACP_HOST_INCOMPATIBLE`
 * error carrying the concrete failures and upgrade guidance — while native
 * routes delegate to `super` untouched.
 *
 * Subprocess seam: 子进程 spawn/终止全经宿主公共 seam `ctx.subprocess`
 * （宿主 SubprocessRuntime；结构窄化见 src/runtime/process/subprocess.ts）。
 * 构造期经 {@link resolveSubprocessSeam} 解析一次，沿既有依赖方向注入 registry
 * （probe）/ AcpAgent 懒启动（会话 spawn）/ dshAcp Remote service（version 探针）。
 * 宿主缺 subprocess-local provider（dsh-base 默认装配）时解析为
 * `{ok:false}`：ACP 各 spawn 点以 spawn-failure fail closed，native 路由不受影响，
 * 绝不回退自制 child_process。
 *
 * @module @zaimokuza/dsh-acp-adapter/host/factory/agent-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import process from 'node:process'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { Config } from '@deepseek-ai/dsh-agent-loop'
import type {
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { AcpAgent } from '../../domain/session/agent.ts'
import type { AcpAgentOptions, AcpConnectionRuntimeContext } from '../../domain/session/agent.ts'
import { createAcpFileSystemHandlers } from '../../runtime/client-capabilities/filesystem.ts'
import { createAcpTerminalHandlers } from '../../runtime/client-capabilities/terminal.ts'
import { acpAgentIdFromRoute, acpProbeConfigKey, acpProbeFresh, acpRouteId, descriptorOf } from '../../domain/session/agent-config.ts'
import type { AcpResolvedAgent } from '../../domain/session/agent-config.ts'
import { deriveAcpAgentState } from '../../domain/session/agent-state.ts'
import type { AcpAgentConfigState } from '../../domain/session/agent-state.ts'
import { acpLaunchEnvironment, acpLaunchFingerprint } from '../../domain/session/launch-fingerprint.ts'
import { AcpClientError } from '../../protocol/v1/errors.ts'
import {
  AcpFactoryOwnership,
  getResumePersistence,
  raceAbort,
  resumeAcpLifecycle,
  setupAndPublishAcpLifecycle,
} from '../../host-compat/agent-loop.ts'
import type { AcpLoopInternals, AcpResumePersistence } from '../../host-compat/agent-loop.ts'
import { initHostScope } from '../../host-compat/host-scope.ts'
import type { HostLoaderLike } from '../../host-compat/host-scope.ts'
import { assertHostCompatible, initStructureGate } from '../../host-compat/structure-gate.ts'
import { AcpRemoteService } from '../../remote/service.ts'
import { createAcpPermissionHandler, InMemoryAcpPendingPermissionBroker } from '../../domain/policy/permissions.ts'
import { InMemoryAcpElicitationBroker, elicitationResponseOf } from '../../domain/policy/elicitation.ts'
import type { AcpApprovalRequester, AcpPermissionAuditChannel } from '../../domain/policy/permissions.ts'
import { createAgentConfigAudit } from '../../domain/policy/events.ts'
import { createAcpLogger } from '../../domain/observability/logging.ts'
import type { AcpLogger } from '../../domain/observability/logging.ts'
import { AcpMetricsRegistry, createAcpMetricReporter } from '../../domain/observability/metrics.ts'
import { installInstalledProfileRegistry } from '../composition/installed-profile-registry.ts'
import type { InstalledProfileRegistry } from '../composition/installed-profile-registry.ts'
import { resolveSubprocessSeam } from '../composition/subprocess.ts'
import type { SubprocessSeamResolution } from '../../runtime/process/subprocess.ts'
import { ACP_SIDECAR_CONFIG_AUDIT_ID, acpCanonicalHash16, installAcpSidecar } from '../../persistence/sidecar.ts'
import type { AcpBindingLookup, AcpBindingRecord, AcpBoundSessionBinding, AcpReconciliationCause, AcpRecoveryState, AcpSidecar } from '../../persistence/sidecar.ts'

/**
 * widen-accessor：读没有类型增强声明的 ctx slot（approval/webServer 的类型增强
 * 住在 dsh-user-approval / dsh-host-webserver，均不在本包依赖面）。
 */
function getCtxSlot<T>(ctx: Context, name: string): T | undefined {
  const holder = ctx as Context & { get(name: string, strict?: boolean): unknown }
  return holder.get(name) as T | undefined
}

/**
 * 宿主 session 持久记录的轻量列表面（SessionPersistence.list 的结构窄化；
 * host-compat 岛的 AcpResumePersistence 钉版只含 inspect/prepare，本类型是路由层的
 * 本地增量，不动钉版面）。宿主 rc.2 无会话删除面（见 src/persistence/sidecar.ts
 * 模块头的调研结论），故「list 列出」=「存在且未删除」。
 */
type AcpSessionListCapable = AcpResumePersistence & {
  list?(signal?: AbortSignal): Promise<readonly SessionHeader[]>
}

/**
 * 双绑守卫的判定产物：`binding` 原样放行，或 `blocked` 拒绝复用（
 * 调用方预置 continuity 闩锁，会话进入 reconciliation-required，零 spawn）。
 * 两者互斥。
 */
interface AcpBindingGuardResult {
  readonly binding?: AcpBindingRecord
  readonly blocked?: AcpReconciliationCause
}

/**
 * 会话是否有 open turn（审批桥 `approval.request` 的前置条件）：session events
 * 折叠——倒序找末个 turn 边界，`turn/start` → true、`turn/end` → false（镜像
 * dsh-user-approval 的 hasOpenTurn 判定）。
 */
function hasOpenTurn(session: Session): boolean {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const type = session.events[index]?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * 审批审计通道（生产接线）：sidecar 落盘。 sidecar 是 ACP 会话的
 * 强制前提（createAcpMachine 在缺席时 fail loud，本函数不再可能拿到
 * undefined），原先的 warn-resolve 臂已随该门槛删除。
 */
function acpAuditChannel(sidecar: AcpSidecar, id: SessionId): AcpPermissionAuditChannel {
  return { append: (record) => sidecar.append(id, record) }
}

/** Concrete agent factory with ACP routing; replaces `agent-loop` under the bundle patch. */
export default class AcpAgentLoop extends AgentLoop {
  /**
   * The settings-synced ACP provider registry (`acp-<id>` routes). Installed
   * here so the loop and its consumers share exactly one registry; the health
 * endpoint reads probe snapshots through it.
   */
  readonly installedProfileRegistry: InstalledProfileRegistry
  /**
   * sidecar 持久化规则 sidecar 存储（审计 + ACP binding 的唯一持久化通道）。`dshHomePath`
 * slot 缺席时为 `undefined`（installAcpSidecar 已 warn）；这是 ACP
   * 会话的强制前提：{@link createAcpMachine} 拿到 undefined 直接抛错（fail
 * loud，会话拒绝启动），不再「退化为纯窥测」。 的 permissionHandler
   * 接线与 fork/delete 连带清理经此成员取实例。
   */
  readonly acpSidecar: AcpSidecar | undefined
  /**
 * 全插件共享的内存指标 registry：probe（registry/llm-stub）、会话
   * （AcpAgent driver）、审批桥（permissionHandler）的埋点都落在这里；快照经
   * health 端点（顶层 `metrics` 字段）导出。每次计数/观察同时经构造期接线的
   * reporter 上报宿主 telemetry 服务（`ctx.get('telemetry')` 探测；缺席降级为
   * 结构化 debug 日志，主链路永不因遥测失败）。
   */
  readonly acpMetrics: AcpMetricsRegistry
 /** 结构化 logger（cordis ctx.logger 承载不变；字段词表见 domain/observability/logging.ts）。 */
  private readonly acpLog: AcpLogger
  private readonly acpOwnership: AcpFactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly acpRuntime: { ctx: Context }
  /** compat 协议帧的宿主缝：父类 private 成员（runtime.ctx / ownership）的显式等价物。 */
  private readonly acpInternals: AcpLoopInternals
  /**
 * subprocess seam 的构造期解析产物（见模块头「Subprocess seam」段）：
   * 解析一次后注入 registry（probe）/ createAcpMachine 的 driver（会话懒启动
   * spawn）/ dshAcp Remote service（version 探针）。`{ok:false}` 时各 spawn 点
   * fail closed（spawn-failure），native 路由不受影响。
   */
  private readonly acpSubprocess: SubprocessSeamResolution
  /** Session-scoped ACP permission waits; the Remote and handler share this broker. */
  private readonly acpPendingPermissions = new InMemoryAcpPendingPermissionBroker()
  /** Session-scoped ACP form/url elicitation broker shared by connection handlers and Remote UI. */
  private readonly acpPendingElicitations = new InMemoryAcpElicitationBroker(Date.now, (sessionId, audit) => {
    const sidecar = this.acpSidecar
    if (sidecar === undefined) return
    return sidecar.append(sessionId as SessionId, { kind: 'elicitation', data: audit }).catch((error: unknown) => {
      this.acpLog.warn(`dsh-acp: failed to persist elicitation audit (${errorChain(error)})`, { operation: 'audit', result: 'error' })
      throw error
    })
  })
  /**
   * 宿主模块实例一致性 宿主 scope 解析的结算凭证。构造期 fire-and-forget 启动（initHostScope
   * 永不 reject，失败被 host-compat/host-scope 缓存并在首个 hostCreateScope 处
   * 复抛），任何 AcpAgent 构造前在 ACP 路由屏障 {@link acpRouteReady} 处 await。
   * 第二参是 ctx.loader（锚链必须经其 internal 级联 ESM loader 解析，
   * tsx 源启形态下 CJS resolve 不吃 tsconfig paths 会分叉出第二实例）；loader
   * 缺席（无 web/loader 的宿主）则跳宿主链直走兜底。
   */
  private readonly hostScopeInit: Promise<void>
  /**
 * host-compat 结构门（fail closed）的结算凭证。构造期 fire-and-forget 启动
   * （initStructureGate 永不 reject，失败缓存并 logger.error + stderr 双写），
   * ACP 路由屏障 {@link acpRouteReady} 处 await 后 assertHostCompatible 复抛缓存
   * 错误（ACP 会话拒绝创建）；native 路由不经过此门。
   */
  private readonly structureGateInit: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const loader = getCtxSlot<HostLoaderLike>(ctx, 'loader')
    this.hostScopeInit = initHostScope(ctx.logger, loader)
    this.structureGateInit = initStructureGate(ctx.logger, loader, ctx)
    this.acpRuntime = { ctx }
    this.acpOwnership = new AcpFactoryOwnership(ctx.fiber)
    this.acpInternals = { loopCtx: ctx, ownership: this.acpOwnership }
 // 结构化 logger + 共享指标 registry + telemetry 降级 reporter（探测
    // ctx.get('telemetry')；宿主未默认装配该服务 → 默认走结构化 debug 日志）。
    this.acpLog = createAcpLogger(ctx.logger)
    this.acpMetrics = new AcpMetricsRegistry({
      onEvent: createAcpMetricReporter({ telemetry: getCtxSlot<unknown>(ctx, 'telemetry'), log: this.acpLog }),
    })
 // 构造期解析一次 ctx.subprocess（dsh-base 默认装配 subprocess-local）；
    // 缺席时各 ACP spawn 点 fail closed（spawn-failure），native 路由不受影响。
    this.acpSubprocess = resolveSubprocessSeam(ctx)
    if (!this.acpSubprocess.ok) this.acpLog.error(this.acpSubprocess.message, { operation: 'startup', result: 'config' })
    this.acpSidecar = installAcpSidecar(ctx)
    // 插件卸载时落齐审计队列并关闭 sidecar（WAL checkpoint TRUNCATE +
    // 连接释放）。cordis effect 的 dispose 回调允许返回 Promise（同
    // acpOwnership.dispose）；失败仅 warn——卸载路径不被存储故障卡死。
    const acpSidecar = this.acpSidecar
    ctx.effect(() => () => {
      if (acpSidecar === undefined) return
      return acpSidecar.dispose().catch((error: unknown) => {
        this.acpLog.warn(`dsh-acp: failed to dispose the sidecar store (${errorChain(error)})`, { operation: 'dispose', result: 'error' })
      })
    }, 'acpAgentLoop.sidecar()')
 // 启动时一次性 retention 清扫（接线点 = sidecar 安装处，startup-only）。
    // 刻意不做周期 sweep：audit 行有界（队列上限 + 默认 30 天保留）且本操作幂等
    // 低开销，周期定时器的收益不抵 Cordis effect/dispose 复杂度。per-session 删除
 // 维持既定边界不接线：dsh rc.2 宿主无会话删除钩子（sidecar.ts 模块头
    // 调研结论），remove 原语保留给未来真正的删除钩子与运维手清，sidecar 行的
    // 生命周期 = harness-home 的生命周期（超龄 audit 行由本清扫收敛）。
    // retention 属非关键运维项：fire-and-forget 不阻塞插件激活，失败仅 warn
    // 继续（绝不因此禁用 ACP 或影响 native 路由）；阈值取 store 构造默认保留期
    // （ACP_SIDECAR_DEFAULT_RETENTION_MS）。
    if (acpSidecar !== undefined) {
      void acpSidecar.enforceRetention().catch((error: unknown) => {
        this.acpLog.warn(`dsh-acp: sidecar retention sweep failed; continuing without it (${errorChain(error)})`, { operation: 'startup', result: 'retention-failed' })
      })
    }
    this.installedProfileRegistry = installInstalledProfileRegistry(ctx, {
      subprocess: this.acpSubprocess,
      metrics: this.acpMetrics,
 // agent 配置改动审计摘要 → sidecar `agent-config` 专档（异步落盘，
      // 失败只 warn——审计丢失不得阻断设置同步；env 只记键名级 diff）。
      ...(this.acpSidecar === undefined
        ? {}
        : {
            auditConfigChange: (changes) => {
              const sidecar = this.acpSidecar as AcpSidecar
              void Promise.all(changes.map((change) =>
                sidecar.append(ACP_SIDECAR_CONFIG_AUDIT_ID as SessionId, { kind: 'agent-config', data: createAgentConfigAudit(change) }),
              )).catch((error: unknown) => {
                this.acpLog.warn(
                  `dsh-acp: failed to persist the agent-config audit (${errorChain(error)})`,
                  { operation: 'audit', result: 'error' },
                )
              })
            },
          }),
    })
    ctx.effect(() => () => this.acpOwnership.dispose(), 'acpAgentLoop.transactions()')
    ctx.effect(() => () => this.acpPendingPermissions.dispose(), 'acpAgentLoop.pendingPermissions()')
    ctx.effect(() => () => this.acpPendingElicitations.dispose(), 'acpAgentLoop.pendingElicitations()')
 // （原 生产接线）：dshAcp Remote service（health / live options /
    // rebindBlank）。构造即注册 cordis service；strict descriptor 由
    // scripts/gen-typert.mjs 预生成、typert-loader 自动注册，gateway 经 /api
    // 信任围栏派发——不再依赖 webServer 旁路路由（headless 宿主同构可用）。
    new AcpRemoteService(ctx, {
      pendingPermissions: this.acpPendingPermissions,
      pendingElicitations: this.acpPendingElicitations,
      imageInputAvailable: getCtxSlot<AttachmentStore>(ctx, 'attachments') !== undefined,
      registry: {
        agents: () => this.installedProfileRegistry.agents(),
        probeCache: this.installedProfileRegistry.adapter,
      },
      resolveLiveAgent: (sessionId) => {
        const agent = this.acpRuntime.ctx.agents.get(sessionId as SessionId)
        return agent instanceof AcpAgent ? agent : undefined
      },
 // health 五态的结构门输入（remote 层不得 import host-compat，经 deps 注入）
      hostCompatible: () => {
        try {
          assertHostCompatible()
          return true
        } catch {
          return false
        }
      },
 // health 的默认实现经宿主 seam spawn/解析；
      // 缺席时 fail closed（executable=false / version=null）
      subprocess: this.acpSubprocess,
 // 内存指标快照随 health 视图导出（顶层 `metrics` 字段）
      metricsSnapshot: () => this.acpMetrics.snapshot(),
 // 活体 ACP 会话的连续性清单随 health 视图导出（`liveSessions` 字段）
      listLiveSessions: () =>
        this.acpRuntime.ctx.agents.list()
          .filter((agent): agent is AcpAgent => agent instanceof AcpAgent)
          .map((agent) => ({ sessionId: String(agent.id), continuity: agent.continuityState })),
 // backendOf 的事实源——sidecar binding（创建即有）→ 日志
      // request/header 窥测（首 turn 才落）→ 活体注册表（存在性证据）。全部
      // 只读；binding 读取失败非权威（与 readBindingFor 同款容错）。
      backendFacts: {
        readBindingProvider: async (sessionId) => {
          const lookup: AcpBindingLookup | undefined = await this.acpSidecar
            ?.readLatestBinding(sessionId as SessionId)
            .catch((): undefined => undefined)
          return lookup?.status === 'ok' ? lookup.binding.provider : undefined
        },
        peekHeaderProvider: async (sessionId) => {
          const persistence = getResumePersistence(this.acpRuntime.ctx)
          if (persistence === undefined) {
            throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
          }
          const inspected = await persistence.inspect(sessionId as SessionId)
          return foldRequestHeader(inspected.events)?.config.provider
        },
        hasLiveAgent: (sessionId) => this.acpRuntime.ctx.agents.get(sessionId as SessionId) !== undefined,
      },
 // boundSessions 的计数源——sidecar 全量 binding 索引按 provider 过滤
      // （只读；sidecar 未接线 = 不可能有任何 ACP binding，计数 0 是事实而非编造）。
      bindingFacts: {
        countBoundSessions: async (provider) => {
          const sidecar = this.acpSidecar
          if (sidecar === undefined) return 0
          const bindings = await sidecar.listBindings()
          return bindings.filter((entry) => entry.binding.provider === provider).length
        },
      },
 // sidecar 缺席时三个 seam 整体不接线——beginModelSwitch 响亮
      // 拒绝（fail-closed），liveOptions 无活体时维持旧抛错行为
      ...(this.acpSidecar === undefined
        ? {}
        : (() => {
            const sidecar = this.acpSidecar as AcpSidecar
            return {
 // 待定模型切换事务的持久 seam（begin/commit/rollback 与快照
              // 的 modelSwitch 视图共用）
              modelSwitchStore: {
                read: (sessionId: string) => sidecar.readPendingModelSwitch(sessionId as SessionId),
                write: (record: Parameters<AcpSidecar['writePendingModelSwitch']>[0]) => sidecar.writePendingModelSwitch(record),
                clear: (sessionId: string) => sidecar.clearPendingModelSwitch(sessionId as SessionId),
              },
 // last-known option 快照的只读 seam（冷启动 stale 展示面）
              optionSnapshotStore: {
                read: (sessionId: string) => sidecar.readOptionSnapshot(sessionId as SessionId),
              },
              recoveryStateStore: {
                read: async (sessionId: string) => {
                  const state = await sidecar.readRecoveryState(sessionId as SessionId)
                  if (state === undefined) return undefined
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
                },
              },
 // 以当前 profile 配置重组运行时指纹（与 AcpAgent 的
              // optionsSnapshotFingerprint 同公式），比对 stale 快照的指纹；
              // 无 binding/无 profile 配置 → undefined（fingerprintChanged 恒 false）
              snapshotFingerprint: async (sessionId: string): Promise<string | undefined> => {
                const lookup = await sidecar.readLatestBinding(sessionId as SessionId).catch((): undefined => undefined)
                if (lookup?.status !== 'ok') return undefined
                const binding = lookup.binding
                const profileId = acpAgentIdFromRoute(binding.provider)
                if (profileId === undefined) return undefined
                const config = this.installedProfileRegistry.agents().get(profileId)
                if (config === undefined) return undefined
                const descriptor = descriptorOf(profileId, config)
                const effectiveEnv = await acpLaunchEnvironment({
                  config,
                  descriptor,
                  dataHomeStrategy: 'native',
                })
                const computedFingerprint = acpLaunchFingerprint({
                  profileId,
                  config,
                  descriptor,
                  env: effectiveEnv,
                })
                return acpCanonicalHash16({
                  launchFingerprint: computedFingerprint,
                  agent: { name: binding.agent.name ?? null, version: binding.agent.version ?? null },
                  protocolVersion: binding.protocolVersion,
                })
              },
            }
          })()),
    })
  }

  /**
 * ACP 路由的就绪屏障：宿主 scope 解析（宿主模块实例一致性）+ host-compat 结构门。两者
   * 的 init 均不 reject；结构门失败在此响亮复抛（错误码 ACP_HOST_INCOMPATIBLE +
   * 具体失败项与升级指引），host-scope 失败维持原语义——AcpAgent 构造时经 hostCreateScope    * 复抛缓存错误，setup 回滚、ACP 会话响亮失败。native 路由不经过此屏障。
   */
  private async acpRouteReady(): Promise<void> {
    await this.hostScopeInit
    await this.structureGateInit
    assertHostCompatible()
  }

  /**
 * 会话创建门：只有五态为 `ready` 的 ACP profile 允许创建新会话（词表与
   * 判定规则见 src/domain/session/agent-state.ts——与 health 行的 `state` 字段同一
   * 实现）。probe 缓存缺席或随配置漂移失效时先补一次 `listModels` 探测（失败同样
   * 落缓存——缓存的错误即失败事实），再以新鲜快照派生：
   * - `auth-required` → `AcpClientError('auth_required')`，消息携带 loginHint
 * （external-login-only：登录只发生在 agent 自家 CLI，本门负责把用户
   *   引到那里）；
   * - `unavailable` → 以缓存的 failureKind + probe message 拒绝；
   * - `saved-unverified` / `incompatible` 不可达（前者：listModels 结算后缓存恒在
   *   场；后者：本门之前的 acpRouteReady 已 assertHostCompatible）——防御性兜底
   *   仍响亮拒绝而非放行。
 * resume 有意不经过本门：历史会话的连续性由 binding 机制承担；拿 probe
   * 状态卡 resume 会把用户锁在自己的历史外面。
   */
  private async assertAcpProfileReady(resolved: AcpResolvedAgent): Promise<void> {
    const routeId = acpRouteId(resolved.id)
    const key = acpProbeConfigKey(resolved.config)
    let snapshot = this.installedProfileRegistry.adapter.probeSnapshot(routeId)
 // 新鲜度集中判定（agent-config.ts acpProbeFresh）——key 漂移或过 TTL
    // 的条目按「从未探测」计，先补一次 listModels 探测（过期条目在 llm-stub
    // 里按 miss 重 probe；失败同样落缓存——缓存的错误即失败事实）
    if (snapshot === undefined || !acpProbeFresh(snapshot, key, Date.now())) {
      await this.installedProfileRegistry.adapter.listModels(routeId).catch(() => undefined)
      snapshot = this.installedProfileRegistry.adapter.probeSnapshot(routeId)
    }
    const fresh = snapshot !== undefined && acpProbeFresh(snapshot, key, Date.now()) ? snapshot : undefined
    const state: AcpAgentConfigState = deriveAcpAgentState({
      hostCompatible: true, // 本门之前的 acpRouteReady() 已断言结构门
      configValid: true, // settings schema 保证（registry 拒绝写入非法值）
      probe: fresh === undefined
        ? undefined
        : fresh.result.kind === 'ok'
          ? { result: { kind: 'ok', modelCount: fresh.result.models.length, hasModelConfigOption: fresh.result.hasModelConfigOption } }
          : { result: { kind: 'error', failureKind: fresh.result.failureKind } },
    })
    if (state === 'ready') return
    if (state === 'auth-required') {
      const hint = resolved.config.loginHint
      throw new AcpClientError(
        'auth_required',
        `ACP agent "${resolved.id}" is not logged in; no session can be created on it`
        + (hint === undefined
          ? " — log in with the agent's own CLI, then retry"
          : ` — run \`${hint}\` to log in, then retry`),
        { category: 'config' },
      )
    }
    if (state === 'unavailable' && fresh !== undefined && fresh.result.kind === 'error') {
      throw new AcpClientError(
        fresh.result.failureKind,
        `ACP agent "${resolved.id}" is unavailable (last probe failed: ${fresh.result.error.message}); `
        + 'fix the agent configuration and refresh its model catalog before creating a session',
        { category: 'config' },
      )
    }
    throw new AcpClientError(
      'protocol-error',
      `ACP agent "${resolved.id}" is not ready for session creation (state: ${state}); refresh its model catalog and retry`,
      { category: 'config' },
    )
  }

  /**
   * Create an owned agent, routing ACP providers (`acp-<id>`) to
   * {@link AcpAgent}. Non-ACP providers delegate to the parent unchanged.
   */
  override async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const provider = options.agentOptions?.provider
    if (provider === undefined) return super.createAgent(ownerCtx, options)
    const resolved = this.installedProfileRegistry.resolveRoute(provider)
    if (resolved === undefined) return super.createAgent(ownerCtx, options)
    const agentOptions = options.agentOptions ?? {}
    await this.acpRouteReady()
 // 会话创建门：只有五态为 ready 的 profile 允许创建新 ACP 会话
    await this.assertAcpProfileReady(resolved)
    const preparation = SessionPreparation.create(this.acpRuntime.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    const published = setupAndPublishAcpLifecycle(
      this.acpInternals,
      ownerCtx,
      options.sessionId,
      preparation,
      agentOptions,
      options.setup,
      options.signal,
      'startup',
      (loopCtx, session) => this.createAcpMachine(loopCtx, options.sessionId, agentOptions, session, resolved),
    )
    this.acpOwnership.trackWrapper(published)
    return published
  }

  /**
   * Resume an owned agent, routing sessions whose provider hits the ACP
   * registry to {@link AcpAgent}. Provider resolution is marker-first（sidecar
   * binding → persisted `request/header` → transient resume options）。与持久 provider
   * 匹配的最后一条 `request/header` model 同样是会话真源；刷新/重启时
   * 宿主携带的新全局默认 model 不得覆盖它。binding 中的 ACP
   * session id 仅在 binding provider 与最终路由一致时用于 `session/load`；
   * 瞬时的显式选项不得继承另一 provider 的 ACP 会话。
   */
  override async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = getResumePersistence(this.acpRuntime.ctx)
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    // 恢复必须 marker-first。宿主传入的 provider 可能只是刷新/重启瞬间的全局
    // 默认值；它不是历史 execution backend 的真源，绝不能在读取 binding 之前
    // 决定机器类型。
    const explicit = options.agentOptions?.provider
    const peeked = await this.peekStoredRoute(persistence, options.resumeSessionId, options.signal)
    const binding = peeked?.binding
    const loggedProvider = peeked?.provider
    const provider = binding?.provider ?? loggedProvider ?? explicit
    if (provider === undefined) return super.resume(ownerCtx, options)

    // binding 与 DSH 历史矛盾时，binding 仍用于定位应该展示/处置的 Agent，
    // 但预置 continuity 闩锁；绝不 spawn，也绝不让任一方覆盖另一方。
    const routeConflict = binding !== undefined
      && loggedProvider !== undefined
      && binding.provider !== loggedProvider
    const blocked: AcpReconciliationCause | undefined = routeConflict
      ? 'backend-conflict'
      : peeked?.blocked

    const resolved = this.installedProfileRegistry.resolveRoute(provider)
    if (resolved === undefined) {
      // 持久历史命中 ACP 但 profile 已删除/改名时，不能静默退回 native。
      if (provider.startsWith('acp-') || binding !== undefined || blocked !== undefined) {
        throw new AcpClientError(
          'protocol-error',
          `dsh-acp: execution backend ${JSON.stringify(provider)} for session ${JSON.stringify(String(options.resumeSessionId))} is unavailable; restore that ACP profile or start a new session`,
          { category: 'config' },
        )
      }
      // 已有 native request/header 同样优先于瞬时默认值。
      const nativeOptions: ResumeAgentOptions = {
        ...options,
        agentOptions: {
          ...options.agentOptions,
          ...(peeked?.model === undefined ? {} : { model: peeked.model }),
          provider,
        },
      }
      return super.resume(ownerCtx, nativeOptions)
    }

    if (explicit !== undefined && explicit !== provider) {
      this.acpLog.warn(
        `dsh-acp: ignoring transient resume provider ${JSON.stringify(explicit)}; persisted backend ${JSON.stringify(provider)} is authoritative`,
        { dshSessionId: String(options.resumeSessionId), acpProvider: provider, operation: 'resume-route', result: 'binding-first' },
      )
    }
    const persistedModel = loggedProvider === provider ? peeked?.model : undefined
    const agentOptions: AgentOptions = {
      ...options.agentOptions,
      ...(persistedModel === undefined ? {} : { model: persistedModel }),
      provider,
    }
    const guard: AcpBindingGuardResult = blocked !== undefined
      ? { ...(binding === undefined ? {} : { binding }), blocked }
      : await this.guardBindingReuse(persistence, options.resumeSessionId, binding)
    await this.acpRouteReady()
    return resumeAcpLifecycle(
      this.acpInternals,
      ownerCtx,
      persistence,
      options,
      agentOptions,
      (loopCtx, session) => this.createAcpMachine(loopCtx, options.resumeSessionId, agentOptions, session, resolved, guard.binding, guard.blocked, peeked?.recovery),
    )
  }

  /**
 * 双绑守卫：同一 ACP session 不得同时绑定两个活动 DSH session。
   * resume 复用 binding 前扫 sidecar 全量 binding 索引——若**另一个** dsh session
   * 的最新 binding 指向同一 provider 的同一 agentSessionId，且该 session「活动」，
 * 则拒绝复用： 返回 `{blocked:'binding-in-use'}`（调用方预置 continuity
   * 闩锁，会话进入 reconciliation-required、零 spawn，直到用户处置——不再自动
   * 降级 session/new）。
   *
   * 「活动」的启发式（跨进程/崩溃残留的判断边界，如实声明）：
   *  1. 本进程活动会话：`ctx.agents` 注册表里有活体 agent——确定冲突（最强证据）。
   *  2. 宿主 session 持久记录：`sessionPersistence.list()` 含该 id——rc.2 无会话
   *     删除面（sidecar.ts 模块头调研结论），列出即「存在且未删除」，视为活动
   *     （保守覆盖「另一会话当前未加载、随时可能被用户打开」的窗口）。
   *  3. 两者皆否 → 崩溃/清理残留（会话日志已整体清走、只剩 sidecar 残档），放行复用。
   * 跨进程盲区（如实声明）：另一 dsh 进程共享 DSH_HOME 且正持有该 ACP session 时，
   * 本进程无法判定——启发式不宣称全覆盖。
   * 失败姿态：sidecar 枚举失败 / 持久列表不可得或调用失败均**非权威**——warn 后
   * 放行（守卫是兜底防线，不得以基础设施故障阻断正常恢复；正常恢复路径上
   * binding 属于本 session 自己，复用是合法语义）。
   */
  private async guardBindingReuse(
    persistence: AcpResumePersistence,
    id: SessionId,
    binding: AcpBindingRecord | undefined,
  ): Promise<AcpBindingGuardResult> {
    if (binding === undefined) return {}
    const sidecar = this.acpSidecar
    if (sidecar === undefined) return { binding }
    const guardFields = {
      dshSessionId: String(id),
      acpProvider: binding.provider,
      acpSessionId: binding.agentSessionId,
      operation: 'binding-guard',
    } as const
    let others: readonly AcpBoundSessionBinding[]
    try {
      others = await sidecar.listBindings()
    } catch (error: unknown) {
      this.acpLog.warn(`dsh-acp: binding-conflict scan failed; resuming with the recorded binding (${errorChain(error)})`, { ...guardFields, result: 'scan-failed' })
      return { binding }
    }
    const conflict = others.find(
      (entry) => entry.dshSessionId !== (id as string)
        && entry.binding.provider === binding.provider
        && entry.binding.agentSessionId === binding.agentSessionId,
    )
    if (conflict === undefined) return { binding }
    // 启发式 1：本进程活体（确定冲突，不再查持久列表）
    if (this.acpRuntime.ctx.agents.get(conflict.dshSessionId as SessionId) !== undefined) {
      this.acpLog.warn(
        `dsh-acp: ACP session "${binding.agentSessionId}" is still bound to live session "${conflict.dshSessionId}"; ` +
        `refusing to rebind it to session "${id as string}" (the session stays blocked until the conflict is resolved)`,
        { ...guardFields, result: 'binding-in-use' },
      )
      return { blocked: 'binding-in-use' }
    }
    // 启发式 2：宿主 session 持久记录在场即「存在且未删除」
    const listCall = (persistence as AcpSessionListCapable).list
    if (listCall === undefined) {
      this.acpLog.warn('dsh-acp: session persistence exposes no list(); the binding-conflict check falls back to the in-process liveness check only', { ...guardFields, result: 'degraded' })
      return { binding }
    }
    try {
      const headers = await listCall.call(persistence)
      if (!headers.some((header) => (header.id as string) === conflict.dshSessionId)) return { binding }
    } catch (error: unknown) {
      this.acpLog.warn(`dsh-acp: host session listing failed during the binding-conflict check; resuming with the recorded binding (${errorChain(error)})`, { ...guardFields, result: 'scan-failed' })
      return { binding }
    }
    this.acpLog.warn(
      `dsh-acp: ACP session "${binding.agentSessionId}" is bound to session "${conflict.dshSessionId}" which still exists in the host session list; ` +
      `refusing to rebind it to session "${id as string}" (the session stays blocked until the conflict is resolved)`,
      { ...guardFields, result: 'binding-in-use' },
    )
    return { blocked: 'binding-in-use' }
  }

  /**
   * Resume 路由窥测：一次只读 inspect 折出 request/header 回退路由，再读
   * sidecar binding（marker-first）。inspect 与 binding 读取各自容错：任一失败
 * 都不权威——resume 落回父类，由父类自己的 load 暴露真实错误。：binding
   * 语义门槛失败（outdated）时 payload 不再可信——provider 只从日志 header 窥测
   * 取，同时带上 `{blocked:'binding-outdated'}`（调用方预置 continuity 闩锁）。
   * fork 判定不在此层：fork 出的新 dsh id 在 sidecar 天然查无记录，id 碰撞防御
   * 统一在 createAcpMachine 用 session.header.parentSession 判定（恢复连续性规则：fork 一律
   * session/new）。
   */
  private async peekStoredRoute(
    persistence: AcpResumePersistence,
    id: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<{ provider?: string; model?: string; binding?: AcpBindingRecord; blocked?: AcpReconciliationCause; recovery?: AcpRecoveryState } | undefined> {
    let route: { provider?: string; model?: string } | undefined
    try {
      const inspected = signal === undefined
        ? await persistence.inspect(id)
        : await raceAbort(persistence.inspect(id, signal), signal, id)
      const header = foldRequestHeader(inspected.events)
      route = {
        ...header?.config.provider === undefined ? {} : { provider: header.config.provider },
        ...header?.config.model === undefined ? {} : { model: header.config.model },
      }
    } catch {
      route = undefined
    }
    let lookup: AcpBindingLookup | undefined
    let bindingReadFailed = false
    let recovery: AcpRecoveryState | undefined
    if (this.acpSidecar !== undefined) {
      try {
        lookup = await this.acpSidecar.readLatestBinding(id)
      } catch (error: unknown) {
        bindingReadFailed = true
        // A binding read error is not equivalent to “no binding”. Keep the
        // route only as a diagnostic hint and force a loud recovery state.
        this.acpLog.warn(`dsh-acp: failed to read binding for session ${String(id)} (${error instanceof Error ? error.message : String(error)})`, { operation: 'binding-read', result: 'error' })
        recovery = {
          dshSessionId: String(id),
          kind: 'local-history-damaged',
          cause: 'dsh-log-truncated',
          detail: `binding state could not be read: ${errorChain(error)}`,
          updatedAt: Date.now(),
        }
      }
    }
    let recoveryReadFailed = false
    if (this.acpSidecar !== undefined) {
      try {
        const storedRecovery = await this.acpSidecar.readRecoveryState(id)
        // A binding read failure is itself unrecoverable local evidence loss;
        // do not let an older healthy recovery row mask that fact.
        if (recovery === undefined || storedRecovery?.kind !== 'healthy') recovery = storedRecovery
      } catch (error: unknown) {
        recoveryReadFailed = true
        recovery = {
          dshSessionId: String(id),
          kind: 'local-history-damaged',
          cause: 'dsh-log-truncated',
          detail: `recovery state could not be read: ${errorChain(error)}`,
          updatedAt: Date.now(),
        }
      }
    }
    const binding = lookup?.status === 'ok' ? lookup.binding : undefined
    const blocked: AcpReconciliationCause | undefined = bindingReadFailed || recoveryReadFailed
      ? 'dsh-log-truncated'
      : lookup?.status === 'outdated' ? 'binding-outdated' : undefined
    if (route === undefined && binding === undefined && blocked === undefined && recovery === undefined) return undefined
    return {
      ...route?.provider === undefined ? {} : { provider: route.provider },
      ...route?.model === undefined ? {} : { model: route.model },
      ...(binding === undefined ? {} : { binding }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(recovery === undefined ? {} : { recovery }),
    }
  }

  /**
   * ACP 机器组装（插件私有增量，非上游复制——作为 host-compat 协议帧的
   * createMachine 回调注入）。fork 防御（恢复连续性规则：fork 会话即便 id 碰撞命中 binding
   * 也不恢复 parent 的 ACP 上下文；判定放在此处而非路由层——session.header 已随
 * prepare 加载，显式 resume 路径无需为此窥测日志）。：sidecar 是 ACP
   * 会话的强制前提——缺席直接抛错（fail loud；prepareAcpLifecycle 的 catch 会
   * dispose 并原样上抛，createAgent/resume 响亮 reject、不发布 handle），不再
   * 「退化为纯窥测」；recordBinding/recordAudit 因此恒在场（AcpAgent 的
 * fail-closed binding 写与 reconciliation 记录都经它们落盘）。 生产接线
   * 权限桥（driver 对象被 AcpAgent 按引用持有、startSession 懒消费，此处赋值对懒
   * 启动生效；approval 服务缺席 → 桥 fail closed（unavailable→cancelled）；审计
   * 通道见 acpAuditChannel）。
   */
  private createAcpMachine(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    resolved: AcpResolvedAgent,
    resumeBinding?: AcpBindingRecord,
    presetBlocked?: AcpReconciliationCause,
    recoveryState?: AcpRecoveryState,
  ): AcpAgent {
    const sidecar = this.acpSidecar
    if (sidecar === undefined) {
      throw new AcpClientError(
        'spawn-failure',
        'dsh-acp: sidecar storage is unavailable (the dshHomePath slot is absent); ACP sessions refuse to start without binding/audit persistence (fail-closed to preserve binding and audit integrity)',
        { category: 'config' },
      )
    }
    const forked = session.header.parentSession !== undefined
    // 正常 fork 的新 DSH id 不会有 sidecar binding。若二者同时出现，说明 id
    // 碰撞或残留索引；自动 session/new 会覆盖唯一恢复证据。保留 binding 并预置
    // reconciliation，只有用户显式 rebindBlank 才允许推进到下一 generation。
    const effectiveBlocked = forked && resumeBinding !== undefined
      ? 'backend-conflict'
      : presetBlocked
    const attachments = getCtxSlot<AttachmentStore>(loopCtx, 'attachments')
    const driver: AcpAgentOptions = {
      profile: resolved,
      subprocess: this.acpSubprocess,
      ...(attachments === undefined ? {} : { attachments }),
      metrics: this.acpMetrics,
      cancelPendingPermissions: (sessionId: string) => this.acpPendingPermissions.cancelSession(sessionId),
      cancelPendingElicitations: (sessionId: string) => this.acpPendingElicitations.cancelSession(sessionId),
      ...(resumeBinding === undefined ? {} : { resumeBinding }),
      ...(recoveryState === undefined ? {} : { recoveryState }),
 // 双绑守卫/语义门槛/fork-id 碰撞拒绝复用 binding 时预置 blocked 原因——
      // AcpAgent 构造期置 continuity 闩锁，后续 turn 以 ACP_RECONCILIATION_REQUIRED
      // 失败（零 spawn）。正常 fork 是新 dsh id、天然无 binding；若异常命中，
      // 上方 effectiveBlocked 保留该证据并要求显式 reconciliation。
      ...(effectiveBlocked === undefined ? {} : { presetBlocked: effectiveBlocked }),
      // sidecar 持久化规则：建立（new 或对账通过的 load）后 fail-closed 写 binding；分轴审计与
      // reconciliation 记录同通道落盘。闭包绑定本 dsh sessionId。
      recordBinding: (binding) => sidecar.append(id, { kind: 'binding', data: binding }),
      recordRecoveryState: (state) => sidecar.writeRecoveryState(state),
      recordAudit: (entry) => sidecar.append(id, entry),
      // 非审批审计在 sidecar 有界队列里，turn 收束/dispose 前落齐
      flushAudit: () => sidecar.flush(),
 // 运行时 auth_required（登录态在 probe 之后漂移）→ 丢弃该路由的
      // probe 缓存，下次 health/目录构建/创建门重探测到真实状态
      invalidateProbeCache: () => { this.installedProfileRegistry.adapter.invalidateProbe(acpRouteId(resolved.id)) },
 // 待定模型切换事务的持久 seam（options-sync 守卫 / rebindBlank 清行
      // 共用；闭包绑定本 dsh sessionId）
      modelSwitchStore: {
        read: () => sidecar.readPendingModelSwitch(id),
        write: (record) => sidecar.writePendingModelSwitch(record),
        clear: () => sidecar.clearPendingModelSwitch(id),
      },
 // 活体权威快照到达（建立/set_config_option/set_mode/turn 收束）即刷新
      // sidecar 的 last-known option 快照（冷启动 stale 只读展示面的唯一写路径）
      recordOptionsSnapshot: (snapshot) => sidecar.writeOptionSnapshot(id, snapshot),
      recordFileAudit: async (event) => sidecar.append(id, { kind: 'filesystem', data: event }),
    }
    driver.fileSystemHandlers = () => createAcpFileSystemHandlers({
      profileId: resolved.id,
      audit: (event) => driver.recordFileAudit?.(event),
      onAuditError: (error, event) => {
        this.acpLog.warn(`dsh-acp: filesystem ${event.operation} completed but its audit was not persisted (${errorChain(error)})`, {
          dshSessionId: String(id), acpProvider: `acp-${resolved.id}`, operation: 'filesystem-audit', result: 'error',
        })
      },
    })
    driver.terminalHandlers = ({ cwd, env }: AcpConnectionRuntimeContext) => createAcpTerminalHandlers({
      subprocess: this.acpSubprocess.ok
        ? this.acpSubprocess.seam
        : (() => { throw new Error(this.acpSubprocess.message) })(),
      profileId: resolved.id,
      dshSessionId: String(id),
      // Terminal commands inherit the exact immutable native launch snapshot
      // used by this ACP connection. This includes descriptor aliases and
      // executable overrides; values are never copied into terminal audits.
      cwd,
      env,
      audit: (event) => driver.recordAudit?.({ kind: 'terminal', data: event }) ?? Promise.resolve(),
      onAuditError: (error, event) => {
        this.acpLog.warn(`dsh-acp: terminal ${event.operation} completed but its audit was not persisted (${errorChain(error)})`, {
          dshSessionId: String(id), acpProvider: `acp-${resolved.id}`, operation: 'terminal-audit', result: 'error',
        })
      },
    })
    const agent = new AcpAgent(loopCtx, id, options, session, driver)
    driver.permissionHandler = createAcpPermissionHandler({
      agent,
      agentId: resolved.id,
      agentName: resolved.config.name,
      dshSessionId: String(id),
      workspaceRoot: session.header.cwd ?? process.cwd(),
      approval: getCtxSlot<AcpApprovalRequester>(loopCtx, 'approval'),
      pending: this.acpPendingPermissions,
      toolCallPresentation: (toolCallId) => agent.getToolCallPresentationSnapshot(toolCallId),
      audit: acpAuditChannel(sidecar, id),
      hasOpenTurn: () => hasOpenTurn(session),
      turnSignal: () => agent.turnAbortSignal,
 // 桥内日志补齐会话级字段（acpSessionId 由桥按请求自带）
      log: (message, fields) => { this.acpLog.warn(message, { dshSessionId: String(id), acpProvider: `acp-${resolved.id}`, ...fields }) },
      metrics: this.acpMetrics,
    })
    driver.elicitationHandler = (params) => this.acpPendingElicitations.open({ sessionId: String(id), params, ...(agent.turnAbortSignal === undefined ? {} : { signal: agent.turnAbortSignal }) }).then(elicitationResponseOf)
    return agent
  }
}
