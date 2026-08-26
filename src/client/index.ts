/**
 * @zaimokuza/dsh-acp-adapter client entry (browser half). tsdown bundles this file to
 * lib/client.js wrapped in the `window.__ModuleLoader__.load({ id, factory })`
 * handoff (see tsdown.config.ts); the host serves it at
 * /plugins/@zaimokuza/dsh-acp-adapter/client.js per the package.json `dsh.client`
 * declaration。
 *
 * registers the ACP settings section: agent CRUD over the `dsh-acp`
 * settings namespace and concise per-agent health states fed by the `dshAcp`
 * Remote namespace (the handwritten bypass HTTP endpoints are gone), and adds
 * the enhanced model picker. moves both seats onto the slot store
 * discipline: each registration declares an exclusive store factory
 * (`store: createAcpPanelStore` / `store: createModelPickerStore`), the
 * framework mints the store instance per entry x scope and hands the baked
 * actions to the inject factory, which ATTACHES the glue to them
 * (ui-conversation's inject-side-effect precedent). The components read
 * through the framework's `useStore` seat and write nothing — every state
 * transition flows glue → baked action → store.
 *
 * Dependency posture: `react` is a platform module answered by
 * the loader's module table at runtime, so it is imported here WITHOUT a
 * package.json entry and typed
 * through the ambient structural minimum in react.d.ts. The dsh client
 * services this plugin consumes (slots/locale/connection/remote/settingsScope/
 * commandUi/sessions, plus the optionally-read conversation) are narrowed
 * structurally below — the same discipline the host half applies to dsh
 * services it must not import. The narrowing is the TYPING face only;
 * the dependency edges are fully declared in package.json — `dsh.client.inject`
 * carries the provider package names (informational graph metadata, rc.2
 * semantics), each double-listed in peerDependencies + devDependencies at
 * 0.1.1-rc.2. `conversation` stays an optional ctx.get read (upstream
 * ui-model-selection precedent: absent service only degrades the composer
 * block), with its provider @deepseek-ai/dsh-client-ui-conversation declared
 * the same way; scripts/verify-bundle.mjs pins both directions. Icons come
 * from the baseline module-table row @deepseek-ai/dsh-client-ui-primitives
 * (devDependencies-only for types — the baseline needs no inject edge).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
// dshAcp Remote 的 wire contract 经 ./client 导出（typert publicRemoteType
// 硬要求：payload 类型须从非根 public subpath 可达；类型真源 src/contract/remote.ts）。
export type * from '../contract/remote.ts'
// 生成的 remote contribution（strict zod codec + TypertRemoteNamespaceMap
// declaration merge）。tsdown 把它与 zod 一起内联进 lib/client.js；tsc 侧经
// sibling lib/typert.remote-client.d.ts 拿类型。`import type {}` 激活
// `TypertRemoteNamespaceMap` 的 merge，给 `TypertClientRemote['dshAcp']` 供型
// （运行时实例经 `ctx.get('remote.dshAcp')` 解析，非 remote 本体的属性）。
import contribution from '../../lib/typert.remote-client.js'
import type {} from '../../lib/typert.remote-client.js'
import { AcpPanelController } from './data/controller.ts'
import type { SettingsMutateLike, SettingsScopeLike } from './data/controller.ts'
import type { AcpRemoteLike } from './data/acp-remote.ts'
import { createAcpPanelStore } from './data/stores/panel-store.ts'
import type { AcpPanelStoreActions } from './data/stores/panel-store.ts'
import { createModelPickerStore } from './data/stores/picker-store.ts'
import type { ModelPickerStoreActions } from './data/stores/picker-store.ts'
import { AcpSection } from './ui/AcpSection.ts'
import type { AcpSectionWire } from './ui/AcpSection.ts'
import { ACP_SETTINGS_NS, decodeAcpSettings } from './data/logic.ts'
import type { AcpSettings } from './data/logic.ts'
import { en, zh } from './ui/locales.ts'
import { ModelPicker } from './host-compat/model-picker/ModelPicker.ts'
import type { ModelPickerWire } from './host-compat/model-picker/ModelPicker.ts'
import { createAcpContextUsageComponent } from './ui/AcpContextUsage.ts'
import { PickerService } from './data/picker-service.ts'
import type { PickerServiceDeps } from './data/picker-service.ts'
import {
  AGENT_DEFAULT_MODEL_NS,
  decodeAgentDefaultModel,
  isSameBackendSelection,
  isNativeToNativeSelection,
  failClosedGroupsForUnavailableProbe,
  isAcpProvider,
} from './data/selector-logic.ts'
import type { ModelDirectoryState, PickerModelSelection, PickerTranslate } from './data/selector-logic.ts'
// 复制壳（/model popup 行 + composer seat 组件 + picker 文案）收进
// client 侧兼容岛 host-compat/model-picker/——岛只负责 DSH row/popup/command/
// slot 的交互适配，ACP 业务逻辑全在 data/ 业务模块（architecture.spec.ts
// 层守卫钉死双向边界）。
import { optionsOf, selectionOf } from './host-compat/model-picker/popup.ts'
import type { PickerSelectOption } from './host-compat/model-picker/popup.ts'
import { en as pickerEn, zh as pickerZh } from './host-compat/model-picker/selector-locales.ts'
import { AcpToolRow } from './ui/AcpToolRow.ts'
import { ACP_EXTERNAL_TOOL_NAME } from './data/tool-presentation.ts'
import { createAcpPermissionInputDock } from './ui/AcpPermissionInputDock.ts'
import { createAcpElicitationInputDock } from './ui/AcpElicitationInputDock.ts'

/** Dictionary namespaces owned by this plugin ( panel / picker). */
const NS = 'settings.acp'
const PICKER_NS = 'acp-model'

/** Structural face of the locale service (dsh-client-locale LocaleRuntime). */
interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): PickerTranslate
}

/** Structural face of the settings-scope binder (ui-settings SettingsScopeBinder). */
interface SettingsScopeBinderLike {
  bind<T>(spec: { namespace: string; decode?: (value: unknown) => T | undefined }): SettingsScopeLike
}

/** Structural face of the connection handle, narrowed to the settings wire the panel writes through. */
interface ConnectionLike {
  api: { settings: SettingsMutateLike }
}

/** Structural face of the client slots service (dsh-client-ui-slots SlotRegistry). */
interface SlotsLike {
  inject(name: string, contribute: () => unknown): unknown
  register(entry: Record<string, unknown>, component: unknown): unknown
}

/** Session descriptor the command contribution receives (dsh-client-ui-commands). */
interface CommandSessionLike {
  sessionId: string
}

/** Structural face of the command contribution registry (ui-commands CommandUiContract). */
interface CommandUiLike {
  register(entry: {
    name: string
    description: string
    available?(session: CommandSessionLike): boolean
    ui: {
      kind: 'popupSelect'
      options(session: CommandSessionLike): Promise<PickerSelectOption[]>
      onSelect(option: { id: string }, session: CommandSessionLike): Promise<void>
    }
  }): () => void
}

/** Structural face of the sessions service (subagent guard; scope/binding ride the PickerService deps). */
interface SessionsLike {
  subagentAddress(sessionId: string): string | undefined
}

/** Structural face of the workspaces service ( cross-backend new-session workspace resolution). */
interface WorkspacesLike {
  list: {
    getSnapshot(): {
      items: readonly { workspaceId: string; sessionIds: readonly string[] }[]
      recentWorkspaceId?: string | undefined
    }
  }
}

/** Required services (cordis fiber inject; settingsScope.bind reads connection/remote off this same fiber).
 * 注意：`remote.dshAcp` 刻意不在其中——它是本插件 `$mount` 自提供的 namespace 服务，
 * 声明 inject 会让 fiber 等待一个只有自己启动后才存在的键（死锁）；消费侧在 mount
 * 就位后经 `ctx.get('remote.dshAcp')` 解析（见 apply 内 namespace ）。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'commandUi', 'sessions', 'workspaces']

/**
 * Client plugin body: the `acp` settings section with its controller and copy.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const locale = ctx.get('locale') as LocaleLike
  ctx.effect(() => locale.register(NS, { zh, en }), '@zaimokuza/dsh-acp-adapter: ACP section dictionaries')

  const connection = ctx.get('connection') as ConnectionLike
  const binder = ctx.get('settingsScope') as SettingsScopeBinderLike
  const scope = binder.bind<AcpSettings>({ namespace: ACP_SETTINGS_NS, decode: decodeAcpSettings })

 // 挂载 dshAcp Remote namespace。`$mount` resolve 即 namespace 服务就位：
  // gateway 把它注册为独立 cordis 服务键 `remote.dshAcp`（挂在 client root 的
  // 子 fiber 上），而不是 remote 服务本体的普通属性。因此不能写成
  // `typertRemote.dshAcp` —— remote 的 traceable 代理会把该属性访问翻译成
  // context 解析 `ctx['remote.dshAcp']`，强制本 fiber 在 inject 声明它；而自挂载
  // 语义下声明 inject 会死锁（fiber 等一个只有自己 apply 才会提供的服务）。这里改走
  // `ctx.get('remote.dshAcp')`（reflect 通道，无 inject 闸），在 mounted 就位后取实例；
  // mount 失败的 rejection 经各调用点 try/catch 落进 UI 降级，空 catch 防无人调用时的
  // unhandled rejection。
  const typertRemote = ctx.get('remote') as unknown as TypertClientRemote
  const mounted = typertRemote.$mount(contribution)
  void mounted.catch(() => undefined)
  const namespace = async (): Promise<TypertClientRemote['dshAcp']> => {
    await mounted
    const ns = ctx.get('remote.dshAcp') as TypertClientRemote['dshAcp'] | undefined
    if (ns === undefined) throw new Error('dshAcp remote namespace is not mounted')
    return ns
  }
  const acpRemote: AcpRemoteLike = {
    health: async (request) => (await namespace()).health(request),
    options: async (sessionId) => (await namespace()).options(sessionId),
    setOption: async (sessionId, request) => (await namespace()).setOption(sessionId, request),
    backendOf: async (sessionId) => (await namespace()).backendOf(sessionId),
    rebindBlank: async (sessionId) => (await namespace()).rebindBlank(sessionId),
    boundSessions: async (agentId) => (await namespace()).boundSessions(agentId),
 // 模型热切换持久事务三方法（ModelSwitchController 的 host 侧）
    beginModelSwitch: async (sessionId, request) => (await namespace()).beginModelSwitch(sessionId, request),
    commitModelSwitch: async (sessionId, request) => (await namespace()).commitModelSwitch(sessionId, request),
    rollbackModelSwitch: async (sessionId, request) => (await namespace()).rollbackModelSwitch(sessionId, request),
    pendingPermissions: async (sessionId) => (await namespace()).pendingPermissions(sessionId),
    answerPermission: async (sessionId, request) => (await namespace()).answerPermission(sessionId, request),
    cancelPermission: async (sessionId, request) => (await namespace()).cancelPermission(sessionId, request),
    pendingElicitations: async (sessionId) => (await namespace()).pendingElicitations(sessionId),
    answerElicitation: async (sessionId, request) => (await namespace()).answerElicitation(sessionId, request),
    cancelElicitation: async (sessionId, request) => (await namespace()).cancelElicitation(sessionId, request),
  }
  const acpPermissionInputDock = createAcpPermissionInputDock(acpRemote)
  const acpElicitationInputDock = createAcpElicitationInputDock(acpRemote)

  const controller = new AcpPanelController({ scope, settings: connection.api.settings, remote: acpRemote })
  ctx.effect(() => () => { controller.dispose() }, '@zaimokuza/dsh-acp-adapter: ACP panel controller')

  const panelWire: AcpSectionWire = {
    refreshHealth: (recheck) => { void controller.refreshHealth(recheck) },
    refreshAgentHealth: (agentId) => { void controller.refreshAgentHealth(agentId) },
    saveAgent: (editingId, draft) => controller.saveAgent(editingId, draft),
    deleteAgent: (id) => controller.deleteAgent(id),
    countBoundSessions: (id) => controller.countBoundSessions(id),
  }

  // slots.inject waits on the shell's 'settings.section' declaration; the
  // contribution leaves with this plugin's fiber (ui-settings-models precedent).
  // The store seat: exclusive factory, minted by the framework per entry; the
 // inject factory receives the baked actions and attaches the glue.
 // 收进独立 inject scope——设置面板是可选 ACP 增强，其注册失败
  // （cordis 子 fiber 隔离：scope 内 throw 只 dispose 该 scope）不得拖垮
  // 下方 picker 核心贡献（/model 命令 + conversation.input.model seat）。
  ctx.inject(['slots'], (scope) => {
    const scopeSlots = scope.get('slots') as SlotsLike
    scopeSlots.inject('settings.section', () => scopeSlots.register(
      {
        name: 'settings.section',
        id: 'acp',
        order: 900,
        label: 'ACP',
        locale: NS,
        store: createAcpPanelStore,
        inject: (actions: AcpPanelStoreActions) => {
          controller.attach(actions)
          return { panel: panelWire }
        },
      },
      AcpSection,
    ))
  })

  // ------------------------------------------------------------------
 // — 增强模型选择器（/model 命令 + conversation.input.model seat）。
  // ------------------------------------------------------------------
  ctx.effect(
    () => locale.register(PICKER_NS, { zh: pickerZh, en: pickerEn }),
    '@zaimokuza/dsh-acp-adapter: picker dictionaries',
  )
  // 非 slot 面（命令描述、popup 行构建）读 bound translate；seat 组件读标准 locale seat。
  const t = locale.bind(PICKER_NS)

  const sessions = ctx.get('sessions') as unknown as SessionsLike
  const conversation = ctx.get('conversation') as PickerServiceDeps['conversation']
 // fail-closed：pickerService 装配消费宿主服务面（remote 事件订阅等）；
  // 其失败 = 宿主结构超出已验证面。只禁用 picker 族贡献并点名（设置面板已
  // 在上方独立存活），这类整体漂移的预防门是安装兼容检查
  // （scripts/install-gate.sh）——插件内无法重建已被 patch 替换的原生 picker。
  let pickerService: PickerService | null = null
  try {
    pickerService = new PickerService({
      sessions: ctx.get('sessions') as unknown as PickerServiceDeps['sessions'],
      connection: connection as unknown as PickerServiceDeps['connection'],
      remote: ctx.get('remote') as PickerServiceDeps['remote'],
      acpRemote,
      onConnectionReset: (listener) =>
        (ctx as unknown as { on(name: 'connection/reset', fn: () => void): () => void })
          .on('connection/reset', listener),
      ...(conversation === undefined ? {} : { conversation }),
      settingsScope: binder
        .bind({ namespace: AGENT_DEFAULT_MODEL_NS, decode: decodeAgentDefaultModel }) as unknown as PickerServiceDeps['settingsScope'],
      t,
 // 跨 backend 分流的工作区解析面（公开 IWorkspaces.list 观察面；
      // workspaces 服务由 dsh-client-runtime 提供，package.json inject 边已覆盖）。
      workspaces: ctx.get('workspaces') as WorkspacesLike,
    })
    const service = pickerService
    ctx.effect(() => () => { service.dispose() }, '@zaimokuza/dsh-acp-adapter: picker service')
  } catch (error) {
    console.error('[dsh-acp] model picker contributions disabled (host surface drifted beyond the verified structure):', error)
  }

  if (pickerService !== null) {
    const service: PickerService = pickerService

 // 入口 1：/model popupSelect（内置同名命令的等价注册；pre- 双载时命令
    // 名冲突会 throw；该宿主窗口期冲突不由本插件处理，故注册在独立
    // scope，失败不拖垮上面的设置面板）。popup 读 glue 的权威快照（非 store——
    // 非 React 路径没有 store seat）。
    ctx.inject(['commandUi'], (scope) => {
      const commandUi = scope.get('commandUi') as CommandUiLike
      scope.effect(() => commandUi.register({
        name: 'model',
        description: t('command.description'),
        available: (session) => sessions.subagentAddress(session.sessionId) === undefined,
        ui: {
          kind: 'popupSelect',
          options: async (session) => {
            if (sessions.subagentAddress(session.sessionId) !== undefined) {
              throw new Error('model selection is unavailable for addressed subagent sessions')
            }
            const directory = service.pickerFor(session.sessionId).directory
            await directory.load()
            const state = directory.getSnapshot()
            if (state.current === null) return []
 // backend 已锁定的会话把跨 backend 行标记出来（仍列出，
            // 可发现性）；backendOf 失败（null）按「未知」降级不标记，host 侧
            // options-sync 的 turn 时 throw 兜底。
            const probe = await service.backendProbe(session.sessionId)
            const groups = probe.status === 'unavailable' || probe.state === null
              ? failClosedGroupsForUnavailableProbe(state.groups, state.current)
              : state.groups
            const view = {
              current: state.current,
              routable: state.routable ?? false,
              groups: [...groups],
              failures: [...state.failures],
            }
            return probe.status === 'ok' && probe.state !== null
              ? optionsOf(view, t, probe.state, service.permissionPreset(session.sessionId) ?? null)
              : optionsOf(view, t)
          },
          onSelect: async (option, session) => {
            if (sessions.subagentAddress(session.sessionId) !== undefined) {
              throw new Error('model selection is unavailable for addressed subagent sessions')
            }
            const directory = service.pickerFor(session.sessionId).directory
            const selection = selectionOf(directory.getSnapshot(), option.id)
            if (selection === undefined) {
              throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group')
            }
 // 分流：跨 backend 不 selectModel（host 只会忽略它）；popup 行
            // 已带壳内确认框（optionsOf 的 confirmation），onSelect 运行 = 用户已
            // 确认。事务：解析工作区 → CAS 写默认 → 公开 session.create（预分配
            // id，同 id 重试幂等）→ 列表确认 → open。失败 → throw（错误条如实显示）。
            const probe = await service.backendProbe(session.sessionId)
            if (probe.status === 'unavailable' || probe.state === null) {
              const currentProvider = directory.getSnapshot().current?.provider
              // Preserve DSH's native fail-soft path: a known native→native
              // selection does not need ACP identity. Every ACP/cross-backend
              // action still fails closed while identity is unavailable.
              if (isNativeToNativeSelection(currentProvider, selection.provider)) {
                await service.selectModel(session.sessionId, selection)
                return
              }
              const detail = probe.status === 'unavailable' ? ` (${probe.message})` : ''
              throw new Error(`ACP subsystem unavailable; model selection is disabled until backend identity can be verified${detail}`)
            }
            if (!isSameBackendSelection(selection, probe.state, directory.getSnapshot().current?.provider)) {
              const name = modelNameOf(directory.getSnapshot(), selection)
              const failure = await service.useInNewSession(session.sessionId, selection, name)
              if (failure !== undefined) throw new Error(failure)
              return
            }
            if (probe.state.state === 'blank' && isAcpProvider(selection.provider)) {
              const name = modelNameOf(directory.getSnapshot(), selection)
              const failure = await service.adoptBlankSession(session.sessionId, selection, name)
              if (failure !== undefined) throw new Error(failure)
              return
            }
            if (isAcpProvider(selection.provider)) {
              await service.enableNativeAccess(session.sessionId)
            }
            await service.selectModel(session.sessionId, selection)
          },
        },
      }), '@zaimokuza/dsh-acp-adapter: /model contribution')
    })

    // 入口 2：composer 的命名模型 seat，与 /model 共享同一 per-session picker。
    // store seat：single 槽一个 entry 只有一个 store 位，目录/活体/披露三面以
    // 复合 store 的三 slice 承载（stores/picker-store.ts 的机制说明）。注入工厂
    // 收到框架烘焙的 actions（session+store 形态的第二位置参数）即 attach glue；
    // defaultModel 是框架 settings scope 的裸 observable（非本插件 store），留在
 // hooks 隔间。：seat 与下方 dock/toolview 各占独立 scope——可选 ACP
    // 子模块的失败各自隔离，picker 核心贡献（本 seat + 上方 /model）始终挂载。
    ctx.inject(['slots'], (scope) => {
      const scopeSlots = scope.get('slots') as SlotsLike
      const defaultScope = binder.bind({
        namespace: AGENT_DEFAULT_MODEL_NS,
        decode: decodeAgentDefaultModel,
      })
      scopeSlots.inject('conversation.input.model', () => scopeSlots.register(
        {
          name: 'conversation.input.model',
          locale: PICKER_NS,
          store: createModelPickerStore,
          inject: (sessionId: string, actions: ModelPickerStoreActions) => {
            const available = sessions.subagentAddress(sessionId) === undefined
            if (!available) return { available: false }
            const picker = service.pickerFor(sessionId)
            picker.attach(actions)
            const pickerWire: ModelPickerWire = {
              load: () => { picker.directory.load().catch(() => { /* surfaced on the store */ }) },
 // 同 provider ACP 选择经 ModelSwitchCoordinator 的持久事务
              // （service 内路由；native 走目录旧路径）
              select: (selection) => service.selectModel(sessionId, selection).then(() => true, () => false),
              enableNativeAccess: () => service.enableNativeAccess(sessionId)
                .then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error)),
              setDefault: (selection) => service.setDefaultModel(selection),
              switchOption: (configId, value) => { void picker.live.switchOption(configId, value) },
              reloadLive: () => { picker.live.load().catch(() => { /* surfaced on the store */ }) },
 // 收尾：reconciliation-required 逃生门（continuity blocked 时 UI 展示）。
              rebind: () => { void picker.live.rebind() },
 // 待定模型切换的用户回滚出路（rollback-required / undecidable banner 的按钮）。
              rollbackSwitch: () => { void picker.modelSwitch.rollback() },
 // backend 查询（行级跨 backend 标记）+「在新会话中使用」分流
 // （确认框在组件层两段式；本 wire 即确认后的唯一写入口）
 // + 一次性提示（新会话 seat 挂载时取走）。：三值探测——
              // unavailable 时 seat 进 native-only 模式（Current/ACP 档隐藏 +
              // 非阻塞诊断），原生选择不受影响。
              backend: () => service.backendProbe(sessionId),
              useInNewSession: (selection, label) => service.useInNewSession(sessionId, selection, label),
              adoptBlankSession: (selection, label) => service.adoptBlankSession(sessionId, selection, label),
              takeNotice: () => service.takePendingNotice(),
            }
            return {
              available: true,
              picker: pickerWire,
              hooks: { defaultModel: defaultScope },
            }
          },
        },
        ModelPicker,
      ))
    })

 // ACP context 统计行进 composer dock（list 槽，session scope；
    // 上游 ui-conversation 的 'stats'(order 0) 之后）。无 store seat——注册位
    // 组件由 ui 层工厂闭包绑定 pickerService 的会话级 live 通道；槽声明缺席
    // （ui-conversation 未加载）时 slots.inject 永不触发，诚实降级。
 // 独立 scope——dock 失败不撤销 picker seat。
    ctx.inject(['slots'], (scope) => {
      const scopeSlots = scope.get('slots') as SlotsLike
      scopeSlots.inject('conversation.composer.dock', () => scopeSlots.register(
        {
          name: 'conversation.composer.dock',
          id: 'acp-context-usage',
          order: 1,
          locale: PICKER_NS,
        },
        createAcpContextUsageComponent({
          backendOf: (sessionId: string) => service.backendOf(sessionId),
          liveFor: (sessionId: string) => service.pickerFor(sessionId).live,
        }),
      ))
    })

    // ACP permission requests are interactive full-width rows above the
    // composer. The input dock is the public slot for clickable prose; the
    // ambient composer dock remains reserved for readouts such as context.
    ctx.inject(['slots'], (scope) => {
      const scopeSlots = scope.get('slots') as SlotsLike
      scopeSlots.inject('conversation.input.dock', () => scopeSlots.register(
        { name: 'conversation.input.dock', id: 'acp-permissions', order: -10, locale: NS },
        acpPermissionInputDock,
      ))
    })
    // Elicitation has its own fiber: a host drift or render failure in one
    // interactive broker must not remove the other broker from the composer.
    ctx.inject(['slots'], (scope) => {
      const scopeSlots = scope.get('slots') as SlotsLike
      scopeSlots.inject('conversation.input.dock', () => scopeSlots.register(
        { name: 'conversation.input.dock', id: 'acp-elicitations', order: -9, locale: NS },
        acpElicitationInputDock,
      ))
    })

 // ACP 外部工具的 keyed toolview 渲染器（key = 稳定 wire name
    // ACP_EXTERNAL_TOOL_NAME；槽由 @deepseek-ai/dsh-client-ui-tool 声明，按
    // toolName 分发，未命中落宿主 GenericToolCard——旧日志的动态 name 因此
    // 自然走通用行）。纯渲染贡献：无 store/inject，不注册任何假可执行工具；
    // 展示事实来自 tool/result 的 meta.acpToolPresentation 信封（running 态
 // 无信封，渲染通用标题 + 有界 args 预览）。：独立 scope。
    ctx.inject(['slots'], (scope) => {
      const scopeSlots = scope.get('slots') as SlotsLike
      scopeSlots.inject('tool.call.toolview', () => scopeSlots.register(
        { name: 'tool.call.toolview', key: ACP_EXTERNAL_TOOL_NAME, locale: PICKER_NS },
        AcpToolRow,
      ))
    })
  }
}

/** Look up a selection's display name in the loaded directory (notice copy; falls back to the model id). */
function modelNameOf(state: ModelDirectoryState, selection: PickerModelSelection): string {
  for (const group of state.groups) {
    if (group.id !== selection.provider) continue
    for (const model of group.models) {
      if (model.id === selection.model) return model.name
    }
  }
  return selection.model
}
