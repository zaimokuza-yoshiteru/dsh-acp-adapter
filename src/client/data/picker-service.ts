/**
 * PickerService coordinates per-session model directory, live ACP options,
 * backend access, and composer block publishing.
 *
 * The three data faces are slices of the picker seat's composite store
 * (stores/picker-store.ts). Glue controllers own authoritative data; this
 * service computes the merged backend-access projection (route + permissions)
 * and wires the store mirror:
 * the seat's inject factory calls `picker.attach(actions)` with the
 * framework-baked actions, which resyncs all three slices in one pass
 * (directoryReplaced / liveReplaced / backendAccessUpdated). The composer block
 * reads glue authority (directory snapshot + live continuity) —
 * never the store — so it works with or without a mounted seat.
 * @module @zaimokuza/dsh-acp-adapter/client/picker-service
 */

import { errorMessageOf } from './logic.ts'
import { localizedDiagnostic } from './diagnostics.ts'
import {
  AGENT_DEFAULT_MODEL_NS,
  decodeAgentDefaultModel,
  decodeBackendState,
  defaultModelOps,
  isAcpProvider,
  isNativeToNativeSelection,
  isSameBackendSelection,
  presetOfPermissionsProjection,
} from './selector-logic.ts'
import type { AcpBackendProbe, PickerBackendState, PickerModelSelection, PickerTranslate } from './selector-logic.ts'
import { SessionModelDirectory } from './directory-controller.ts'
import { LiveOptionsController } from './live-controller.ts'
import { ModelSwitchController } from './model-switch-controller.ts'
import type { AcpRemoteLike } from './acp-remote.ts'
import type { SessionsWireLike, SettingsWireLike } from './picker-wire.ts'
import type { BackendAccessState } from './stores/backend-access-store.ts'
import type { ModelPickerStoreActions } from './stores/picker-store.ts'

// ---------------------------------------------------------------------------
// 结构面（窄化，绝不 value-import cordis/client runtime）
// ---------------------------------------------------------------------------

interface SettingsScopeLike {
  getSnapshot(): {
    status: 'idle' | 'loading' | 'ready' | 'error'
    value: unknown
    revision: number
    writable: boolean
  }
}

interface ConversationLike {
  blocks: {
    set(sessionId: string, block: { reason: string } | undefined): void
  }
}

/**
 * 会话 projection 的键寻址裸 observable 面（runtime ProjectionValueStore）：
 * faceOf 恒定义（缺席 = undefined 快照），getSnapshot 直接给出值本体。
 */
interface ProjectionSnapshotLike {
  getSnapshot(): unknown
  subscribe(callback: () => void): () => void
}

interface SessionBindingLike {
  session: {
    command(line: string): Promise<
      | { ok: true; value: { matched: boolean } }
      | { ok: false; error: { code: string; message: string } }
    >
    projections: {
      faceOf(name: string): ProjectionSnapshotLike
    }
  }
}

interface SessionScopeLike {
  // Cordis Fiber.effect executes the setup immediately and retains the returned
  // disposer until unload; the structural face preserves that lifecycle contract.
  effect(fn: () => () => void, name?: string): () => void
}

interface SessionsServiceLike {
  scope(sessionId: string): SessionScopeLike | undefined
  binding(sessionId: string): SessionBindingLike | undefined
  /**
 * 公开 `ISessions.list`（rc.2 client runtime contract/sessions.ts）的
   * 窄化观察面——新会话确认的权威：`sessions.open` 的契约要求 id 已在列表
   * store（「unknown ids fail loud」），直接 wire create 的行经宿主
   * `host/session-added` 帧进入本镜像。
   */
  list: {
    getSnapshot(): {
      byId: Record<string, { cwd?: string | undefined } | undefined>
      current?: string | undefined
    }
    subscribe(callback: () => void): () => void
  }
 /** 公开 `ISessions.open`（导航到已入列表的会话）。 */
  open(sessionId: string): void
}

/**
 * 宿主 workspaces 服务的窄化面（跨 backend 新会话流程的工作区解析源）。
 * `list` 是公开 `IWorkspaces.list`（rc.2 client runtime contract/workspaces.ts）
 * 的观察面：items 携带 sessionIds 成员关系（当前会话所属工作区的判定依据——
 * 与宿主 startSession 同源规则），recentWorkspaceId 是宿主推导的最近工作区。
 */
interface WorkspacesLike {
  list: {
    getSnapshot(): {
      items: readonly { workspaceId: string; sessionIds: readonly string[] }[]
      recentWorkspaceId?: string | undefined
    }
  }
}

interface RemoteLike {
  $on(name: string, listener: (...args: never[]) => void): () => void
}

// ---------------------------------------------------------------------------
// PickerService
// ---------------------------------------------------------------------------

/** One session's picker glue pair plus the seat attach point. */
export interface SessionPicker {
  readonly sessionId: string
  directory: SessionModelDirectory
  live: LiveOptionsController
 /** 同 profile 模型热切换的协调器（seat wire `select` 与 /model popup 的 ACP 同路由选择经此走持久事务）。 采用惰性：native 会话访问不到它。 */
  readonly modelSwitch: ModelSwitchController
  /**
   * 把框架烘焙的复合 store actions 绑到本 picker：两路 glue attach（各自
   * resync 权威 slice）+ 一次披露 resync（合并投影由本 service 计算）。
   * 幂等可重入：seat entry 重建时用新 actions 重绑并再次全量灌入。
   */
  attach(actions: ModelPickerStoreActions): void
}

export interface PickerServiceDeps {
  sessions: SessionsServiceLike
  connection: { api: { sessions: SessionsWireLike; settings: SettingsWireLike } }
  remote: RemoteLike
 /** The mounted dshAcp remote namespace (feeds LiveOptionsController). */
  acpRemote: AcpRemoteLike
  /** cordis 生命周期事件 `connection/reset` 的订阅通道（host 重启后全部重拉）。 */
  onConnectionReset?(listener: () => void): () => void
  conversation?: ConversationLike
  settingsScope: SettingsScopeLike
  t: PickerTranslate
  /**
 * New Session 流程（跨 backend 分流的落点：工作区解析）。缺席 = 宿主
   * 未接线 workspaces 服务——useInNewSession 响亮报错，不静默吞掉用户点击。
   */
  workspaces?: WorkspacesLike
  /**
 * 新会话行进列表镜像的有界确认窗口（默认
   * {@link DEFAULT_LIST_CONFIRM_TIMEOUT_MS}）。超时即诚实报错，绝不无限等待。
   */
  listConfirmTimeoutMs?: number
}

/** `sessions.list` 行确认的有界窗口默认值（10s；宿主 session-added 帧正常一拍即达）。 */
export const DEFAULT_LIST_CONFIRM_TIMEOUT_MS = 10_000

/**
 * 跨 backend 新会话确认单。{@link PickerService.prepareCrossHandoff}
 * 纯组装（零 I/O、零写）；UI 持有 ticket 呈现确认框，确认才调
 * {@link PickerService.confirmCrossHandoff}（唯一写入口），取消 = 丢弃
 * ticket——包括当前会话与默认模型在内一切不变。
 */
export interface CrossHandoffTicket {
  readonly sessionId: string
  readonly selection: PickerModelSelection
  readonly label?: string | undefined
}

type RestoreDefaultModelResult =
  | { readonly status: 'restored' }
  | { readonly status: 'conflict' }
  | { readonly status: 'failed'; readonly message: string }

type DefaultModelWriteResult =
  | { readonly ok: true; readonly appliedRevision: number }
  | { readonly ok: false; readonly message: string }

export class PickerService {
  private readonly pickers = new Map<string, SessionPicker>()
  private readonly disposers: Array<() => void> = []
 /** 跨 backend 分流成功后的一次性用户提示（下一挂载的 picker seat 取走展示）。 */
  private pendingNotice: string | null = null
 /** 跨 backend 新会话事务的在飞闩锁——双击/快速重复选择恰好产生一个会话。 */
  private newSessionInflight = false
  /** One automatic reusable blank-launcher → real ACP session handoff per visit. */
  private readonly blankDefaultHandoffInflight = new Set<string>()
  private readonly blankDefaultHandoffAttempt = new Map<string, string>()
  private readonly blankDefaultHandoffErrors = new Map<string, string>()
  /** One Full Access convergence command per session at a time. */
  private readonly nativeAccessInflight = new Set<string>()
  /** Composer gate while a default-ACP draft is being admitted to Full Access. */
  private readonly nativeAccessPending = new Set<string>()
  /** Last admission failure; kept visible instead of allowing a doomed prompt. */
  private readonly nativeAccessErrors = new Map<string, string>()
  /** Per-session block recomputation without coupling the controllers to UI state. */
  private readonly blockRefreshers = new Map<string, () => void>()

  constructor(private readonly deps: PickerServiceDeps) {
    // adapter 拓扑提交、设置文档变化、host 重启都会改变目录（内置 service 同
    // 款三个触发器）。重置先清空再拉，避免显示上一个 host 世代的投影。
    const resetAll = () => {
      for (const picker of this.pickers.values()) {
        this.blankDefaultHandoffInflight.delete(picker.sessionId)
        this.blankDefaultHandoffAttempt.delete(picker.sessionId)
        this.blankDefaultHandoffErrors.delete(picker.sessionId)
        this.nativeAccessPending.delete(picker.sessionId)
        this.nativeAccessErrors.delete(picker.sessionId)
        picker.directory.resetConnected()
        picker.live.resetConnected()
        this.prime(picker)
      }
    }
    const refreshAll = () => {
      for (const picker of this.pickers.values()) this.prime(picker)
    }
    this.disposers.push(
      deps.remote.$on('llm/adapters-updated', refreshAll as (...args: never[]) => void),
      deps.remote.$on('settings/document-updated', refreshAll as (...args: never[]) => void),
    )
    if (deps.onConnectionReset !== undefined) {
      this.disposers.push(deps.onConnectionReset(resetAll))
    }
    // DSH may reuse a blank native launcher after the global default changed
    // to ACP. Navigation is the stable signal that this launcher became active;
    // prime it again so the verified blank state is handed to a real ACP
    // session before the user can send the first prompt.
    let currentSession = deps.sessions.list.getSnapshot().current
    this.disposers.push(deps.sessions.list.subscribe(() => {
      const next = deps.sessions.list.getSnapshot().current
      if (next === currentSession) return
      currentSession = next
      if (next === undefined) return
      this.blankDefaultHandoffAttempt.delete(next)
      const picker = this.pickers.get(next)
      if (picker !== undefined) this.prime(picker)
    }))
  }

  /** 加载目录；活体选项只对 ACP 会话预拉（非 ACP 会话调 dshAcp options 必然 throw）。 */
  private prime(picker: SessionPicker): void {
    void picker.directory.load()
      .then(async () => {
        const probe = await this.backendProbe(picker.sessionId)
        if (probe.status === 'ok'
          && probe.state?.state === 'draft'
          && isAcpProvider(probe.state.provider)
          && probe.state.model !== undefined) {
          const current = picker.directory.getSnapshot().current
          if (current?.provider !== probe.state.provider || current.model !== probe.state.model) {
            picker.directory.applyBackendSelection({ provider: probe.state.provider, model: probe.state.model })
          }
        }
        const actualProvider = probe.status === 'ok' && probe.state?.state !== 'blank'
          ? probe.state?.provider
          : picker.directory.getSnapshot().current?.provider
        if (probe.status === 'ok'
          && probe.state?.state === 'blank'
          && this.deps.sessions.list.getSnapshot().current === picker.sessionId) {
          const current = picker.directory.getSnapshot().current
          if (current !== null && isAcpProvider(current.provider)) {
            await this.handoffBlankDefault(picker.sessionId, current)
            return
          }
        }
        if (isAcpProvider(actualProvider)) {
          await this.maintainNativeAccess(picker.sessionId, this.permissionPreset(picker.sessionId))
          // Live snapshot arrival also runs pending model-switch recovery.
          void picker.live.load()
            .then(() => picker.modelSwitch.recover())
            .catch(() => undefined)
        }
      })
      .catch(() => undefined)
  }

  pickerFor(sessionId: string): SessionPicker {
    const cached = this.pickers.get(sessionId)
    if (cached) return cached

    const scope = this.deps.sessions.scope(sessionId)
    if (!scope) {
      throw new Error(`dsh-acp: session scope not ready: ${sessionId}`)
    }

    // Backend route + permissions projection form one read-only access state.
    const computeBackendAccess = (): BackendAccessState => {
      const provider = directory.getSnapshot().current?.provider ?? ''
      const projection = this.deps.sessions
        .binding(sessionId)
        ?.session.projections.faceOf('permissions')
      // faceOf 恒定义；binding 缺席（会话行未入列表镜像）时 projection 为
      // undefined → preset undefined → UI 如实显示未知（优雅降级）。
      const preset = presetOfPermissionsProjection(projection?.getSnapshot())
      return { provider, preset }
    }

    const publishBlock = () => {
      const conversation = this.deps.conversation
      if (!conversation) return
      const state = directory.getSnapshot()
      // A blocked continuity state also disables the composer. Routable status
      // wins first; an absent live snapshot does not block input.
      const liveSnapshot = live.getSnapshot().snapshot
      const continuityBlocked = liveSnapshot?.continuity.status === 'blocked'
 // 待定模型切换无法自证一致时 composer 锁定——rollback-required /
      // corrupt 恒阻断；pending 行在 live 会话阻断（stale 会话无活体可写，
      // recover 待 resume 后收敛，不阻断输入）。
      const switchBlocked = liveSnapshot !== null && liveSnapshot !== undefined && (
        liveSnapshot.modelSwitch.status === 'rollback-required'
        || liveSnapshot.modelSwitch.status === 'corrupt'
        || (liveSnapshot.modelSwitch.status === 'pending' && liveSnapshot.freshness === 'live')
      )
      const nativeAccessError = this.nativeAccessErrors.get(sessionId)
      const blankHandoffError = this.blankDefaultHandoffErrors.get(sessionId)
      const reason = state.routable === false
        ? this.deps.t('blocked.composer')
        : continuityBlocked
          ? this.deps.t('blocked.continuity')
          : switchBlocked
            ? this.deps.t('blocked.modelSwitch')
            : blankHandoffError !== undefined
              ? this.deps.t('blank.failed', {
                  message: localizedDiagnostic(this.deps.t, 'error.technical', blankHandoffError),
                })
              : this.blankDefaultHandoffInflight.has(sessionId)
                ? this.deps.t('blank.preparing')
                : nativeAccessError !== undefined
                  ? this.deps.t('native.failed', {
                      message: localizedDiagnostic(this.deps.t, 'error.technical', nativeAccessError),
                    })
                  : this.nativeAccessPending.has(sessionId)
                    ? this.deps.t('native.preparing')
                    : null
      conversation.blocks.set(sessionId, reason === null ? undefined : { reason })
    }

    let sink: ModelPickerStoreActions | null = null
    // 会话 scope 死后 recompute 必须惰性化：in-flight 的 directory.load() 落地
    // still triggers onChange; this guard prevents a dead session from receiving
    // a composer block after teardown.
    let active = true
    const recompute = () => {
      if (!active) return
      const backendAccess = computeBackendAccess()
      sink?.backendAccessUpdated(backendAccess.provider, backendAccess.preset)
      publishBlock()
      if (isAcpProvider(backendAccess.provider) && backendAccess.preset !== 'danger-full-access') {
        void this.maintainNativeAccess(sessionId, backendAccess.preset)
      }
    }

    const directory = new SessionModelDirectory({
      sessions: this.deps.connection.api.sessions,
      sessionId,
      onChange: recompute,
    })
    const live = new LiveOptionsController({
      sessionId,
      remote: this.deps.acpRemote,
    })
    // Model-switch coordinator (the sole same-provider ACP selection entry).
    // It is lazy so native sessions never construct it or issue RPCs.
    let modelSwitchInstance: ModelSwitchController | null = null
    const lazyModelSwitch = (): ModelSwitchController => {
      modelSwitchInstance ??= new ModelSwitchController({
        sessionId,
        remote: this.deps.acpRemote,
        sessions: this.deps.connection.api.sessions,
        directory,
        live,
      })
      return modelSwitchInstance
    }

    const attach = (actions: ModelPickerStoreActions): void => {
      sink = actions
      directory.attach(actions)
      live.attach(actions)
      const backendAccess = computeBackendAccess()
      actions.backendAccessUpdated(backendAccess.provider, backendAccess.preset)
    }

    const unsubs: Array<() => void> = []
    const projection = this.deps.sessions
      .binding(sessionId)
      ?.session.projections.faceOf('permissions')
    if (projection) unsubs.push(projection.subscribe(recompute))
    // continuity 变化（load/rebind 收敛）也要触发 recompute——composer
    // block 的第二数据源。live slice 的每次转换都同步通知（load 开始等无关
    // 转换下 publishBlock 幂等，块内容不变只是重发同值）。
    unsubs.push(live.subscribe(recompute))

    const picker: SessionPicker = { sessionId, directory, live, attach, get modelSwitch() { return lazyModelSwitch() } }
    this.pickers.set(sessionId, picker)
    this.blockRefreshers.set(sessionId, publishBlock)

    // 首次建 picker 时主动加载（内置 directoryFor 不预拉，由入口打开时触发；
    // 本插件的权限展示/composer block 需要 provider+preset 尽快就位，故预拉），
    // 并发布一次初始 block 状态（通常为无 block：idle/routable null 绝不阻断）。
    publishBlock()
    this.prime(picker)

    scope.effect(() => () => {
      active = false
      for (const unsub of unsubs) unsub()
      this.deps.conversation?.blocks.set(sessionId, undefined)
      this.blankDefaultHandoffInflight.delete(sessionId)
      this.blankDefaultHandoffAttempt.delete(sessionId)
      this.blankDefaultHandoffErrors.delete(sessionId)
      this.nativeAccessPending.delete(sessionId)
      this.nativeAccessErrors.delete(sessionId)
      this.blockRefreshers.delete(sessionId)
      this.pickers.delete(sessionId)
    }, `dsh-acp:picker:${sessionId}`)
    return picker
  }

  /** 把给定选择写入 agent-default-model 设置命名空间。返回错误消息或 undefined。 */
  async setDefaultModel(selection: PickerModelSelection): Promise<string | undefined> {
    const result = await this.writeDefaultModel(selection)
    return result.ok ? undefined : result.message
  }

  /** Write the default and retain the host's applied revision as the transaction token. */
  private async writeDefaultModel(selection: PickerModelSelection): Promise<DefaultModelWriteResult> {
    const snapshot = this.deps.settingsScope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) {
      return { ok: false, message: this.deps.t('default.writeError') }
    }
    const current = decodeAgentDefaultModel(snapshot.value)
    const ops = defaultModelOps(selection, current?.reasoningEffort !== undefined)
    try {
      const response = await this.deps.connection.api.settings.mutate({
        ns: AGENT_DEFAULT_MODEL_NS,
        ops,
        expectedRevision: snapshot.revision,
      })
      if (!response.result.ok) {
        return { ok: false, message: response.result.error.message || this.deps.t('default.writeError') }
      }
      const value = response.result.value
      const appliedRevision = typeof value === 'object' && value !== null && Number.isInteger((value as { revision?: unknown }).revision)
        ? (value as { revision: number }).revision
        : undefined
      return appliedRevision === undefined
        ? { ok: false, message: 'settings write response missing applied revision' }
        : { ok: true, appliedRevision }
    } catch (error) {
      return { ok: false, message: errorMessageOf(error) }
    }
  }

  /**
 * host 权威的会话 backend 探测（picker 主防线的数据面； 使用三值状态）。
   * `ok(null)` = 「未知」合法空答（不标记、照常 selectModel）；`unavailable` =
   * RPC 失败/超时/非法载荷——picker seat 据此进 native-only 模式（Current/ACP
   * 档隐藏 + 非阻塞诊断）；host 侧 options-sync 的 turn 时 throw 兜底不变
   * （见 src/domain/session/options-sync.ts）。
   */
  async backendProbe(sessionId: string): Promise<AcpBackendProbe> {
    try {
      const result = await this.deps.acpRemote.backendOf(sessionId)
      if (!result.ok) return { status: 'unavailable', message: result.error.message }
      const state = decodeBackendState(result.value)
      if (state === undefined) return { status: 'unavailable', message: 'invalid backendOf payload' }
      return { status: 'ok', state }
    } catch (error) {
      return { status: 'unavailable', message: errorMessageOf(error) }
    }
  }

  /**
 * backendOf 的兼容读面（调用方按「未知」降级）：探测非 ok 一律归
   * null——不标记、native 流程零打扰。需要区分「未知」与「故障」的消费方
   * （picker seat 的 native-only 判定）改用 {@link backendProbe}。
   */
  async backendOf(sessionId: string): Promise<PickerBackendState | null> {
    const probe = await this.backendProbe(sessionId)
    return probe.status === 'ok' ? probe.state : null
  }

  /**
   * ACP 正式会话只使用 Agent 原生访问。这里走 DSH 公开
   * `/permission` 命令，使 projection、session event 和真实 spawn policy 保持一致。
   * 本方法不猜测或伪造 permission projection。
   */
  async enableNativeAccess(sessionId: string): Promise<void> {
    const binding = this.deps.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('this session is not materialized yet')
    const result = await binding.session.command('/permission danger-full-access')
    if (!result.ok) {
      throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
    }
    if (!result.value.matched) throw new Error('the host offers no /permission command')
  }

  /**
   * Replace DSH's reusable native blank launcher with a session whose factory
   * really constructed the selected ACP backend. The verified blank launcher
   * has no Agent context to migrate, so this is automatic materialization,
   * not a cross-backend confirmation flow.
   */
  private async handoffBlankDefault(sessionId: string, selection: PickerModelSelection): Promise<void> {
    const key = `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`
    if (this.blankDefaultHandoffInflight.has(sessionId)
      || this.blankDefaultHandoffAttempt.get(sessionId) === key) return
    this.blankDefaultHandoffAttempt.set(sessionId, key)
    this.blankDefaultHandoffInflight.add(sessionId)
    this.blankDefaultHandoffErrors.delete(sessionId)
    this.blockRefreshers.get(sessionId)?.()
    try {
      const failure = await this.useInNewSession(sessionId, selection, selection.model)
      if (failure !== undefined) this.blankDefaultHandoffErrors.set(sessionId, failure)
    } catch (error) {
      this.blankDefaultHandoffErrors.set(sessionId, errorMessageOf(error))
    } finally {
      this.blankDefaultHandoffInflight.delete(sessionId)
      this.blockRefreshers.get(sessionId)?.()
    }
  }

  /**
   * Keep an ACP execution backend on DSH Full Access. Backend identity comes
   * from the host, so a native session that merely mirrors an ACP default is
   * never widened. A provider-qualified draft is already an ACP wrapper and
   * must converge before its first prompt; waiting for an established binding
   * creates a deadlock because AcpAgent refuses to establish outside Full
   * Access. Failures remain guarded by AcpAgent before spawn and are retried on
   * the next projection or directory refresh.
   */
  private async maintainNativeAccess(sessionId: string, observedPreset?: string): Promise<void> {
    if (observedPreset === 'danger-full-access') {
      this.nativeAccessPending.delete(sessionId)
      this.nativeAccessErrors.delete(sessionId)
      this.blockRefreshers.get(sessionId)?.()
      return
    }
    if (this.nativeAccessInflight.has(sessionId)) return
    this.nativeAccessInflight.add(sessionId)
    try {
      const probe = await this.backendProbe(sessionId)
      if (probe.status !== 'ok'
        || probe.state === null
        || probe.state.state === 'blank'
        || !isAcpProvider(probe.state.provider)) return
      this.nativeAccessPending.add(sessionId)
      this.nativeAccessErrors.delete(sessionId)
      this.blockRefreshers.get(sessionId)?.()
      await this.enableNativeAccess(sessionId)
    } catch (error) {
      // Keep the composer blocked with the actionable failure. A later
      // projection/directory refresh retries convergence.
      this.nativeAccessErrors.set(sessionId, errorMessageOf(error))
    } finally {
      this.nativeAccessPending.delete(sessionId)
      this.nativeAccessInflight.delete(sessionId)
      this.blockRefreshers.get(sessionId)?.()
    }
  }

  /** 读取 DSH 权限投影；用于 ACP Full Access 自动收敛。 */
  permissionPreset(sessionId: string): string | undefined {
    return presetOfPermissionsProjection(this.deps.sessions
      .binding(sessionId)
      ?.session.projections.faceOf('permissions').getSnapshot())
  }

  /**
 * 模型选择的统一路由（seat wire `select` 与 /model popup 共用）：
   * - 同 provider 的 ACP 选择 → ModelSwitchCoordinator 的持久事务（唯一热切换
   *   入口；失败时错误已落目录 select 文案位，本方法抛出同源消息）；
   * - 其他 routes → directory select-then-adopt.
 * Cross-backend choices use the explicit new-session handoff instead.
   */
  async selectModel(sessionId: string, selection: PickerModelSelection): Promise<void> {
    const picker = this.pickerFor(sessionId)
    const current = picker.directory.getSnapshot().current
    const probe = await this.backendProbe(sessionId)
    if (probe.status === 'unavailable' || probe.state === null) {
      // ACP 子系统故障不能拖垮已知 native→native 的原生路径；除此之外都
      // fail-closed。ACP 当前会话只允许点击当前行（no-op）。
      if (isNativeToNativeSelection(current?.provider, selection.provider)) {
        await picker.directory.select(selection)
        return
      }
      if (current !== null
        && current.provider === selection.provider
        && current.model === selection.model) return
      const detail = probe.status === 'unavailable'
        ? ` (${localizedDiagnostic(this.deps.t, 'error.technical', probe.message)})`
        : ''
      throw new Error(`ACP subsystem unavailable; model selection is disabled until backend identity can be verified${detail}`)
    }
    if (!isSameBackendSelection(selection, probe.state, current?.provider)) {
      if (probe.state.state === 'blank' || probe.state.state === 'draft') {
        const failure = await this.useInNewSession(sessionId, selection)
        if (failure !== undefined) throw new Error(failure)
        return
      }
      throw new Error('changing execution backend requires confirmation and a new session')
    }
    const sameProviderAcp = probe.state.state === 'established'
      && current !== null
      && selection.provider === current.provider
      && isAcpProvider(selection.provider)
    if (!sameProviderAcp) {
      await picker.directory.select(selection)
      return
    }
    const ok = await picker.modelSwitch.switchModel(selection)
    if (!ok) {
      throw new Error(picker.directory.getSnapshot().error ?? 'model switch failed')
    }
  }

  /**
 * 「在新会话中使用」的确认单组装（纯读零写）。UI 拿 ticket 渲染确认框
   * （「将创建新会话；当前上下文不会带过去」）；取消 = 丢弃 ticket，
   * {@link confirmCrossHandoff} 永不运行——当前会话与默认模型都不改变。
   */
  prepareCrossHandoff(sessionId: string, selection: PickerModelSelection, label?: string): CrossHandoffTicket {
    return { sessionId, selection, ...(label === undefined ? {} : { label }) }
  }

  /**
 * 确认后的跨 backend 新会话事务：
   * 解析工作区（当前会话所属 workspace → 宿主 recentWorkspaceId → 当前会话
   *    cwd 直建未分组会话）；三者皆无 → 报错请用户选择，**绝不猜测目录**；
   * 写入目标 `agent-default-model`。DSH create wire 没有模型参数，
   *    新 Agent 只能从该官方默认选择创建；这也复制 DSH“选择即默认”语义；
   * 预生成稳定 `session-${randomUUID()}`，调公开 wire `session.create`
   *    （connection.api.sessions.create；host 对同 id 同 cwd 幂等——
   *    reference ensureSession 采用活体/持久会话）；
   * 有界窗口内经公开 `sessions.list` 镜像确认行到场，再 `sessions.open`
   *    （open 契约要求 id 已入列表）；
   * 网络/响应丢失只用同一个 session id 重试（先查列表采用已发布行）；
   *    `workspace-attach-failed` = 会话已发布但未分组——打开该未分组会话并
   *    留明确提示，绝不创建第二个。
   * 旧会话全程不动、保持可导航；目标选择成为后续新会话默认，与 DSH
   * 原生模型选择一致。宿主明确拒绝创建时用 CAS 恢复旧默认。
   * @returns 错误消息；成功为 undefined。
   */
  async confirmCrossHandoff(ticket: CrossHandoffTicket): Promise<string | undefined> {
    if (this.newSessionInflight) return this.deps.t('cross.inflight')
    this.newSessionInflight = true
    try {
      return await this.runCrossHandoff(ticket, 'cross')
    } finally {
      this.newSessionInflight = false
    }
  }

 /** 一键形态（/model popup：壳内确认框已确认后才调 onSelect）。 */
  async useInNewSession(sessionId: string, selection: PickerModelSelection, label?: string): Promise<string | undefined> {
    return this.confirmCrossHandoff(this.prepareCrossHandoff(sessionId, selection, label))
  }

  /**
   * A blank native session has no portable context and its AgentHandle cannot
   * be replaced. Create and open a new ACP session without changing the old one.
   */
  async adoptBlankSession(sessionId: string, selection: PickerModelSelection, label?: string): Promise<string | undefined> {
    const probe = await this.backendProbe(sessionId)
    if (probe.status !== 'ok' || (probe.state?.state !== 'blank' && probe.state?.state !== 'draft')) {
      throw new Error('blank-session adoption requires a verified blank or draft execution backend')
    }
    if (!isAcpProvider(selection.provider)) {
      throw new Error('blank-session ACP adoption requires an ACP model')
    }
    // Kept as a compatibility method for older callers. If a live wrapper is
    // already present, only its own profile may be switched in place; a
    // different wrapper must use the automatic new-session handoff.
    const current = this.pickerFor(sessionId).directory.getSnapshot().current
    if (!isSameBackendSelection(selection, probe.state, current?.provider)) {
      return this.useInNewSession(sessionId, selection, label)
    }
    await this.pickerFor(sessionId).directory.select(selection)
    return undefined
  }

  private async runCrossHandoff(ticket: CrossHandoffTicket, kind: 'cross' | 'blank'): Promise<string | undefined> {
    const t = this.deps.t
    const technical = (message: string): string => localizedDiagnostic(t, 'error.technical', message)
    const model = ticket.label ?? ticket.selection.model
    // Resolve the workspace before any write; if absent, ask the user rather than guessing.
    const workspaces = this.deps.workspaces
    if (workspaces === undefined) return t('cross.unavailable')
    const workspaceSnapshot = workspaces.list.getSnapshot()
    const ownWorkspace = workspaceSnapshot.items.find((item) => item.sessionIds.includes(ticket.sessionId))
    const workspaceId = ownWorkspace?.workspaceId ?? workspaceSnapshot.recentWorkspaceId ?? undefined
    const cwd = workspaceId === undefined
      ? this.deps.sessions.list.getSnapshot().byId[ticket.sessionId]?.cwd
      : undefined
    if (workspaceId === undefined && (cwd === undefined || cwd === '')) return t('cross.noWorkspace')
    // The create wire has no model parameter: write the official default first.
    // 目标继续作为默认；明确创建失败时才用下方 CAS 补偿恢复。
    const defaultScopeBefore = this.deps.settingsScope.getSnapshot()
    const defaultBefore = decodeAgentDefaultModel(defaultScopeBefore.value)
    const write = await this.writeDefaultModel(ticket.selection)
    if (!write.ok) return t('cross.createFailed', { message: technical(write.message) })
    const appliedRevision = write.appliedRevision
    // Preallocate an id and retry the public create wire with that same id.
    const newSessionId = `session-${globalThis.crypto.randomUUID()}`
    const payload = workspaceId !== undefined
      ? { workspaceId, sessionId: newSessionId }
      : { cwd: cwd as string, sessionId: newSessionId }
    const timeoutMs = this.deps.listConfirmTimeoutMs ?? DEFAULT_LIST_CONFIRM_TIMEOUT_MS
    let attachFailure: string | null = null
    let published = false
    let definitiveCreateFailure = false
    let lastError = ''
    for (let attempt = 0; attempt < 2 && !published; attempt += 1) {
      try {
        const { result } = await this.deps.connection.api.sessions.create(payload)
        if (result.ok) {
          published = true
        } else if (result.error.code === 'workspace-attach-failed') {
          // 会话已发布但工作区挂载失败——采用该未分组会话，绝不二次创建
          published = true
          attachFailure = result.error.message
        } else {
          // 业务拒绝（新鲜 uuid 不会 session-conflict）：不盲目重试
          lastError = result.error.message
          definitiveCreateFailure = true
          break
        }
      } catch (error) {
        // 响应丢失：先查列表镜像——行已在即采用（只产生一个会话）；否则同 id 重试
        lastError = errorMessageOf(error)
        if (await this.waitForSessionRow(newSessionId, timeoutMs)) published = true
      }
    }
    if (!published) {
      if (definitiveCreateFailure) {
        const restore = await this.restoreDefaultModelAfterFailedHandoff(
          ticket.selection,
          defaultBefore,
          defaultScopeBefore.revision,
          appliedRevision,
        )
        if (restore.status === 'restored') return t('cross.createFailedRestored', { message: technical(lastError) })
        if (restore.status === 'conflict') return t('cross.createFailedConflict', { message: technical(lastError) })
        return t('cross.createFailedRecovery', {
          message: technical(lastError),
          recovery: technical(restore.message),
        })
      }
      // Two transport failures with no list evidence are ambiguous: the host
      // may have created the session even though both responses were lost.
      // Tell the user exactly what is unknown; silently calling this a
      // definitive failure invites duplicate sessions on retry.
      return t('cross.createAmbiguous', { model, message: technical(lastError) })
    }
    // Confirm the row in the bounded list mirror before opening it.
    if (!(await this.waitForSessionRow(newSessionId, timeoutMs))) {
      return t('cross.confirmTimeout', { sessionId: newSessionId })
    }
    // ACP backend 不继承受限模式：新会话入列后，在导航/首轮之前
    // 经 DSH 公开命令写入真实 permission event。ACP 的产品约定是自动使用
    // 原生 Agent 访问；这里不增加第二层确认。
    if (isAcpProvider(ticket.selection.provider)) {
      try {
        await this.enableNativeAccess(newSessionId)
      } catch (error) {
        this.pendingNotice = t('cross.nativeAccessFailed', { message: technical(errorMessageOf(error)) })
        this.deps.sessions.open(newSessionId)
        return undefined
      }
    }
    // 提示先于 open 落槽：新会话的 seat 挂载即取走本条（attach 失败如实告知未分组）。
    this.pendingNotice = attachFailure !== null
      ? t('cross.attachFailed', { model, message: technical(attachFailure) })
      : t(kind === 'blank' ? 'blank.started' : 'cross.started', { model })
    this.deps.sessions.open(newSessionId)
    // A cross-backend handoff is an explicit recovery decision for an old ACP
    // session. Record it after the new session is known to exist; failure to
    // write the audit marker never changes the new-session outcome, but is
    // surfaced instead of being presented as durable evidence.
    if (this.deps.acpRemote.recordRecoveryAction !== undefined) {
      const oldBackend = await this.backendProbe(ticket.sessionId)
      if (oldBackend.status === 'ok'
        && oldBackend.state !== null
        && oldBackend.state.state === 'established'
        && isAcpProvider(oldBackend.state.provider)) {
        try {
          await this.deps.acpRemote.recordRecoveryAction(ticket.sessionId, 'new-session')
        } catch (error) {
          this.pendingNotice = t('cross.recoveryActionFailed', { message: technical(errorMessageOf(error)) })
        }
      }
    }
    return undefined
  }

  /** 宿主明确拒绝创建后恢复旧默认；CAS 避免覆盖并发产生的新选择。 */
  private async restoreDefaultModelAfterFailedHandoff(
    target: PickerModelSelection,
    previous: ReturnType<typeof decodeAgentDefaultModel>,
    previousRevision: number,
    appliedRevision: number,
  ): Promise<RestoreDefaultModelResult> {
    const snapshot = this.deps.settingsScope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) return { status: 'failed', message: 'settings are not writable' }
    const current = decodeAgentDefaultModel(snapshot.value)
    const sameSelection = (left: ReturnType<typeof decodeAgentDefaultModel>, right: PickerModelSelection | undefined): boolean =>
      left?.provider === right?.provider
      && left?.model === right?.model
      && left?.reasoningEffort === right?.reasoningEffort
    const isTarget = sameSelection(current, target)
    // settings 投影可能尚未反映成功写入；这种情况下仍使用写响应给出的 revision
    // 做补偿 CAS。任何后续写都会推进 revision，因此不会被本事务覆盖。
    const isUnchangedPreWrite = snapshot.revision === previousRevision && sameSelection(current, previous)
    if (!isTarget && !isUnchangedPreWrite) return { status: 'conflict' }
    const ops = previous === undefined
      ? [
          { op: 'unset' as const, path: ['provider'] },
          { op: 'unset' as const, path: ['model'] },
          ...(target.reasoningEffort === undefined && current?.reasoningEffort === undefined
            ? []
            : [{ op: 'unset' as const, path: ['reasoningEffort'] }]),
        ]
      : defaultModelOps(previous, current?.reasoningEffort !== undefined)
    try {
      const response = await this.deps.connection.api.settings.mutate({
        ns: AGENT_DEFAULT_MODEL_NS,
        ops,
        expectedRevision: appliedRevision,
      })
      if (response.result.ok) return { status: 'restored' }
      if (response.result.error.code === 'settings-conflict') return { status: 'conflict' }
      return { status: 'failed', message: response.result.error.message || 'settings compensation rejected' }
    } catch (error) {
      return { status: 'failed', message: errorMessageOf(error) }
    }
  }

  /** 有界等待新会话行进入 `sessions.list` 镜像（订阅 + 即时检查；超时归 false）。 */
  private waitForSessionRow(sessionId: string, timeoutMs: number): Promise<boolean> {
    const list = this.deps.sessions.list
    if (list.getSnapshot().byId[sessionId] !== undefined) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(false)
      }, timeoutMs)
      const unsubscribe = list.subscribe(() => {
        if (list.getSnapshot().byId[sessionId] !== undefined) {
          clearTimeout(timer)
          unsubscribe()
          resolve(true)
        }
      })
    })
  }

  /** 取走一次性提示（seat 挂载时消费；无 → null）。 */
  takePendingNotice(): string | null {
    const notice = this.pendingNotice
    this.pendingNotice = null
    return notice
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    this.nativeAccessInflight.clear()
    this.blankDefaultHandoffInflight.clear()
    this.blankDefaultHandoffAttempt.clear()
    this.blankDefaultHandoffErrors.clear()
    this.nativeAccessPending.clear()
    this.nativeAccessErrors.clear()
    this.blockRefreshers.clear()
  }
}
