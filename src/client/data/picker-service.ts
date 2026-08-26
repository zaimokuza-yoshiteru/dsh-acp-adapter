/**
 * PickerService ( split from selector-controller.ts): per-session
 * directory/live/disclosure orchestration + composer block publishing.
 *
 * store discipline: the three data faces are slices of the picker seat's
 * composite store (stores/picker-store.ts). The glue controllers own the
 * authoritative state; this service owns the MERGED disclosure projection
 * (directory route + permissions projection) and wires the store mirror:
 * the seat's inject factory calls `picker.attach(actions)` with the
 * framework-baked actions, which resyncs all three slices in one pass
 * (directoryReplaced / liveReplaced / disclosureUpdated). The composer block
 * reads glue authority (directory.getSnapshot + live continuity, ) —
 * never the store — so it works with or without a mounted seat.
 * @module @zaimokuza/dsh-acp-adapter/client/picker-service
 */

import { errorMessageOf } from './logic.ts'
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
import type { CapabilityDisclosureState } from './stores/disclosure-store.ts'
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
  // 与 cordis Fiber.effect 真实签名对齐（fiber.ts：execute 立即执行，只有它
  // 返回的 disposer 才在 fiber 卸载时运行；类型上 execute 必须返回 disposer，
  // 不接受 void）。此前声明为 `fn: () => void`——TS 的 void 返回签名兼容任意
  // 返回值，`() => {…}`（清理体误当本体）与 `() => () => {…}`（正确形态）都
 // 能过 typecheck，这正是 订阅创建即死事故漏网的原因（事故档案：
  // 该 disposer 必须由 Fiber 保留到卸载时执行。
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
 * ticket——包括默认模型在内一切不变。
 */
export interface CrossHandoffTicket {
  readonly sessionId: string
  readonly selection: PickerModelSelection
  readonly label?: string | undefined
}

/** Outcome of the best-effort default-model compensation after a rejected create. */
export type RestoreDefaultModelResult =
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

  constructor(private readonly deps: PickerServiceDeps) {
    // adapter 拓扑提交、设置文档变化、host 重启都会改变目录（内置 service 同
    // 款三个触发器）。重置先清空再拉，避免显示上一个 host 世代的投影。
    const resetAll = () => {
      for (const picker of this.pickers.values()) {
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
  }

  /** 加载目录；活体选项只对 ACP 会话预拉（非 ACP 会话调 dshAcp options 必然 throw）。 */
  private prime(picker: SessionPicker): void {
    void picker.directory.load()
      .then(() => {
        if (isAcpProvider(picker.directory.getSnapshot().current?.provider)) {
 // live 快照落地后跑崩溃恢复——pending 事务行按
          // decideModelSwitchRecovery 收敛（stale/无行时 recover 无操作）
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

    // 权限范围披露投影：目录 current（路由）+ permissions projection（preset）
 // 两路合并（只读展示镜像，不含任何确认/阻断语义）。
    const computeDisclosure = (): CapabilityDisclosureState => {
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
      // continuity blocked 同样禁用 composer（此前横幅只在 picker live
      // pane 内，picker 未打开时失败要到 prompt 时才浮现；composer 会先把
      // prompt 放行进一个必被拒的 turn）。routable 分支优先；live 快照未
      // 加载/未握手（continuity 缺席）时如实不阻断。
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
      const reason = state.routable === false
        ? this.deps.t('blocked.composer')
        : continuityBlocked
          ? this.deps.t('blocked.continuity')
          : switchBlocked
            ? this.deps.t('blocked.modelSwitch')
            : null
      conversation.blocks.set(sessionId, reason === null ? undefined : { reason })
    }

    let sink: ModelPickerStoreActions | null = null
    // 会话 scope 死后 recompute 必须惰性化：in-flight 的 directory.load() 落地
    // 仍会触发 onChange，没有这道闸会把已清空的 composer block 重新发布给死会话
    // （旧实现靠 store.subscribe 的退订挡住同一路径）。
    let active = true
    const recompute = () => {
      if (!active) return
      const disclosure = computeDisclosure()
      sink?.disclosureUpdated(disclosure.provider, disclosure.preset)
      publishBlock()
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
 // 模型热切换协调器（同 provider ACP 选择的唯一入口；事务状态机见
 // model-switch-controller.ts）。 采用惰性构造：非 ACP 会话不应加载或调用
    // switch coordinator——getter 只在真实 ACP 路径（prime 的 ACP 分支 /
    // selectModel 同 provider ACP 分流 / seat 的 rollbackSwitch）首次触达时
    // 才创建实例；native 会话全程零构造、零 RPC。
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
      const disclosure = computeDisclosure()
      actions.disclosureUpdated(disclosure.provider, disclosure.preset)
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

    const picker: SessionPicker = { directory, live, attach, get modelSwitch() { return lazyModelSwitch() } }
    this.pickers.set(sessionId, picker)

    // 首次建 picker 时主动加载（内置 directoryFor 不预拉，由入口打开时触发；
    // 本插件的权限展示/composer block 需要 provider+preset 尽快就位，故预拉），
    // 并发布一次初始 block 状态（通常为无 block：idle/routable null 绝不阻断）。
    publishBlock()
    this.prime(picker)

    scope.effect(() => () => {
      active = false
      for (const unsub of unsubs) unsub()
      this.deps.conversation?.blocks.set(sessionId, undefined)
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
   * 风险确认由调用方 UI 在进入本方法之前完成；本方法不猜测或伪造
   * permission projection。
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

  /** 读取 DSH 权限投影；只用于决定 ACP 行是否需要展示原生访问确认。 */
  permissionPreset(sessionId: string): string | undefined {
    return presetOfPermissionsProjection(this.deps.sessions
      .binding(sessionId)
      ?.session.projections.faceOf('permissions').getSnapshot())
  }

  /**
 * 模型选择的统一路由（seat wire `select` 与 /model popup 共用）：
   * - 同 provider 的 ACP 选择 → ModelSwitchCoordinator 的持久事务（唯一热切换
   *   入口；失败时错误已落目录 select 文案位，本方法抛出同源消息）；
   * - 其余（native 路由）→ 目录的 select-then-adopt 旧路径。
 * 跨 backend 的选择不走这里（的 popup 分流到「在新会话中使用」）。
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
      const detail = probe.status === 'unavailable' ? ` (${probe.message})` : ''
      throw new Error(`ACP subsystem unavailable; model selection is disabled until backend identity can be verified${detail}`)
    }
    if (probe.state.state === 'blank' && isAcpProvider(selection.provider)) {
      const failure = await this.adoptBlankSession(sessionId, selection)
      if (failure !== undefined) throw new Error(failure)
      return
    }
    if (!isSameBackendSelection(selection, probe.state, current?.provider)) {
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
   * {@link confirmCrossHandoff} 永不运行——包括 `agent-default-model` 默认在
   * 内一切不变。
   */
  prepareCrossHandoff(sessionId: string, selection: PickerModelSelection, label?: string): CrossHandoffTicket {
    return { sessionId, selection, ...(label === undefined ? {} : { label }) }
  }

  /**
 * 确认后的跨 backend 新会话事务（唯一写入口；顺序即 末段与
 * 的契约次序）：
   * ① 解析工作区（当前会话所属 workspace → 宿主 recentWorkspaceId → 当前会话
   *    cwd 直建未分组会话）；三者皆无 → 报错请用户选择，**绝不猜测目录**；
   * ② CAS 写 `agent-default-model`（复用 {@link setDefaultModel}）——失败即返
   *    回，不创建会话；成功后目标模型保持为后续新会话默认（不还原，与 DSH
   *    原生模型选择一致）；
   * ③ 预生成稳定 `session-${randomUUID()}`，调公开 wire `session.create`
   *    （connection.api.sessions.create；host 对同 id 同 cwd 幂等——
   *    reference ensureSession 采用活体/持久会话）；
   * ④ 有界窗口内经公开 `sessions.list` 镜像确认行到场，再 `sessions.open`
   *    （open 契约要求 id 已入列表）；
   * ⑤ 网络/响应丢失只用同一个 session id 重试（先查列表采用已发布行）；
   *    `workspace-attach-failed` = 会话已发布但未分组——打开该未分组会话并
   *    留明确提示，绝不创建第二个。
   * 旧会话全程不动、保持可导航。
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
   * 空白 native session 无可迁移上下文，但 rc.2 也无法替换其已实例化的
   * AgentHandle。透明创建并打开 ACP session；不修改旧 session 的模型或权限。
   */
  async adoptBlankSession(sessionId: string, selection: PickerModelSelection, label?: string): Promise<string | undefined> {
    const probe = await this.backendProbe(sessionId)
    if (probe.status !== 'ok' || probe.state?.state !== 'blank') {
      throw new Error('blank-session adoption requires a verified blank execution backend')
    }
    if (!isAcpProvider(selection.provider)) {
      throw new Error('blank-session ACP adoption requires an ACP model')
    }
    if (this.newSessionInflight) return this.deps.t('cross.inflight')
    this.newSessionInflight = true
    try {
      return await this.runCrossHandoff(this.prepareCrossHandoff(sessionId, selection, label), 'blank')
    } finally {
      this.newSessionInflight = false
    }
  }

  private async runCrossHandoff(ticket: CrossHandoffTicket, kind: 'cross' | 'blank'): Promise<string | undefined> {
    const t = this.deps.t
    const model = ticket.label ?? ticket.selection.model
    // ---- ① 工作区解析（先于任何写；失败 → 请用户选择，不猜测目录） ----
    const workspaces = this.deps.workspaces
    if (workspaces === undefined) return t('cross.unavailable')
    const workspaceSnapshot = workspaces.list.getSnapshot()
    const ownWorkspace = workspaceSnapshot.items.find((item) => item.sessionIds.includes(ticket.sessionId))
    const workspaceId = ownWorkspace?.workspaceId ?? workspaceSnapshot.recentWorkspaceId ?? undefined
    const cwd = workspaceId === undefined
      ? this.deps.sessions.list.getSnapshot().byId[ticket.sessionId]?.cwd
      : undefined
    if (workspaceId === undefined && (cwd === undefined || cwd === '')) return t('cross.noWorkspace')
    // ---- ② CAS 写默认模型（失败不创建会话）；只有新会话成功发布后它才应
    // 成为产品默认。业务明确拒绝创建时，下方用 CAS 补偿恢复旧默认。
    const defaultScopeBefore = this.deps.settingsScope.getSnapshot()
    const defaultBefore = decodeAgentDefaultModel(defaultScopeBefore.value)
    const write = await this.writeDefaultModel(ticket.selection)
    if (!write.ok) return write.message
    const appliedRevision = write.appliedRevision
    // ---- ③ 预分配 id + 公开 wire create（同 id 重试幂等） ----
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
        const restore = await this.restoreDefaultModelAfterFailedHandoff(ticket.selection, defaultBefore, defaultScopeBefore.revision, appliedRevision)
        if (restore.status === 'restored') return t('cross.createFailedRestored', { message: lastError })
        if (restore.status === 'conflict') return t('cross.createFailedConflict', { message: lastError })
        return t('cross.createFailedRecovery', { message: lastError, recovery: restore.message })
      }
      // Two transport failures with no list evidence are ambiguous: the host
      // may have created the session even though both responses were lost.
      // Keep the target as the default and tell the user exactly what is
      // unknown; silently calling this a definitive failure invites duplicate
      // sessions on retry.
      return t('cross.createAmbiguous', { model, message: lastError })
    }
    // ---- ④ 有界确认行进列表镜像 → open（契约：open 的 id 必须在列表） ----
    if (!(await this.waitForSessionRow(newSessionId, timeoutMs))) {
      return t('cross.confirmTimeout', { sessionId: newSessionId })
    }
    // ACP backend 不继承受限模式：新会话入列后，在导航/首轮之前
    // 经 DSH 公开命令写入真实 permission event。调用本事务代表用户已在
    // picker/popup 的确认层明确接受原生 Agent 访问。
    if (isAcpProvider(ticket.selection.provider)) {
      try {
        await this.enableNativeAccess(newSessionId)
      } catch (error) {
        this.pendingNotice = t('cross.nativeAccessFailed', { message: errorMessageOf(error) })
        this.deps.sessions.open(newSessionId)
        return undefined
      }
    }
    // 提示先于 open 落槽：新会话的 seat 挂载即取走本条（attach 失败如实告知未分组）。
    this.pendingNotice = attachFailure !== null
      ? t('cross.attachFailed', { model, message: attachFailure })
      : t(kind === 'blank' ? 'blank.started' : 'cross.started', { model })
    this.deps.sessions.open(newSessionId)
    return undefined
  }

  /**
   * 创建被宿主明确拒绝后的默认模型补偿。只在设置仍精确等于本次目标时 CAS
   * 恢复，避免覆盖用户在并发窗口中的后续选择；响应丢失等歧义结局不调用。
   */
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
    // Some host settings projections update asynchronously. If the revision
    // and full selection (including effort) are still exactly the pre-write
    // snapshot, the successful write may simply not be projected yet. In both
    // stale and target projections, the compensation CAS must use the revision
    // returned by the original write. A later writer that chose the same value
    // still advances that revision and is therefore never overwritten.
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
      const message = response.result.error.message || 'settings compensation rejected'
      const code = response.result.error.code ?? ''
      if (code === 'settings-conflict') return { status: 'conflict' }
      return { status: 'failed', message }
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
  }
}
