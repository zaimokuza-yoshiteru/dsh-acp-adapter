/**
 * ModelPicker: the composer's enhanced model seat (`conversation.input.model`),
 * — copied from the built-in ui-model-selection ModelSelect.tsx (MIT)
 * with the task-card enhancements:
 * - provider filter bar (text + Current|All|Model|ACP — Current only for
 * sessions with an established ACP binding, ) over the provider-grouped
 *   list, with `[Model]`/`[ACP]` tags on group headings
 *   (filterGroups/filterFailures);
 * - a per-row "设为默认" action writing the `agent-default-model` namespace;
 * - an "ACP 会话选项" pane rendering the session's live config options
 *   (mode/model/thought_level/model_config sections) through the dshAcp
 *   Remote namespace, optimistic refresh + rollback handled by the live glue;
 * - the "Agent 模式（{agent}）" section in the live pane writes agent-side
 *   behavior through the config-options seam. DSH access and Agent mode stay
 *   independent: the current DSH preset is read only to route ACP selection
 *   through the native Full Access confirmation, not rendered as permanent
 *   picker disclosure.
 *
 * compat island: this shell lives in `src/client/host-compat/model-picker/`
 * — the client-side counterpart of the host-side `src/host-compat/` island
 * (moving client code into src/host-compat/ would break the bundle layering:
 * that layer is host-only, self-contained, and the client bundle never includes
 * it). Island discipline: the copied shell only adapts DSH row/popup/slot
 * interactions; ALL ACP business logic (filters, backend probe, live snapshot
 * decoding, capability words, degradations, switch coordination) is imported
 * from `../../data/*` business modules, never reimplemented here. DSH private
 * store/types do not leak the other way (architecture.spec.ts layer guard).
 *
 * Fork provenance (upstream dsh-v0.1.1-rc.2, commit b150a551b8; the upstream
 * package is unpublished, hence a source-level fork): the dropdown shell —
 * trigger + root/model/effort panes, outside-mousedown close, Escape/arrow-key
 * handling, option row layout — follows upstream`ModelSelect.tsx` nearly
 * verbatim (JSX → createElement translation makes a mechanical diff
 * meaningless; test/contracts/upstream-picker-diff.spec.ts pins the upstream structure
 * instead so an upstream bump forces review). Adapter-original surfaces: the
 * filter bar, the per-row default action, and the live-options pane. Product
 * boundaries belong in documentation, while actionable access and backend
 * changes are confirmed at selection time instead of occupying the picker.
 *
 * fail-soft: when the ACP Remote/backend probe is unavailable, the seat
 * enters native-only mode — Current/ACP filter buckets hide, a non-blocking
 * diagnostic line shows the failure message, and native directory/selection
 * keeps working (it never touches ACP modules). See `filterBucketsOf` /
 * `nativeOnlyFilterOf` / `acpUnavailableMessageOf` in data/selector-logic.ts.
 *
 * : state rides the entry's composite store seat — `useStore` over
 * ModelPickerState with directory/live/disclosure slices (the PropsStore
 * `actions` share is the glue-only write set, unused here); the wire
 * callbacks arrive as the `picker` member; only the framework-owned
 * default-model scope still comes through the hooks compartment
 * (`useDefaultModel`). : classes come from ModelPicker.module.css and the
 * glyphs are the ui-primitives ic_ds_* icons (baseline module-table row) —
 * the former text-glyph deviation is closed.
 * @module @zaimokuza/dsh-acp-adapter/client/host-compat/model-picker/ModelPicker
 */

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { errorMessageOf } from '../../data/logic.ts'
import {
  acpAgentDisplayName,
  acpUnavailableMessageOf,
  failClosedGroupsForUnavailableProbe,
  currentRouteFactsOf,
  currentTabAvailable,
  currentValueNotInCatalog,
  decodeAgentDefaultModel,
  defaultFilterOf,
  filterBucketsOf,
  filterFailures,
  filterGroups,
  flattenLiveValues,
  isAcpProvider,
  isDefaultSelection,
  isSameBackendSelection,
  nativeOnlyFilterOf,
  partitionLiveOptions,
  PROVIDER_KIND_LABELS,
  providerKindOf,
  type AcpBackendProbe,
  type CurrentRouteFacts,
  type LiveConfigOption,
  type LiveOptionSection,
  type PickerCatalogModel,
  type PickerModelSelection,
  type PickerProviderGroup,
  type ProviderFilter,
} from '../../data/selector-logic.ts'
import type { SnapshotSelectorHook } from '../../data/stores/engine.ts'
import type { ModelPickerState } from '../../data/stores/picker-store.ts'
import type { LiveOptionsState } from '../../data/stores/live-options-store.ts'
import type { AcpModelKey } from './selector-locales.ts'
import css from './ModelPicker.module.css'

/** The seat's translate seat (slot renderer binds it from the entry's `locale` declaration). */
export type AcpModelTranslate = (key: AcpModelKey, params?: Record<string, string | number>) => string

/** The default-model settings scope snapshot face (SettingsScopeLike read side). */
interface DefaultScopeSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: unknown
}

/** The controller wire handed to the seat (bound in apply; plain callbacks). */
export interface ModelPickerWire {
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load(): void
  /** Submit a full provider/model/reasoning selection; resolves to host acceptance. */
  select(selection: PickerModelSelection): Promise<boolean>
  /** 在 UI 明确确认后，经 DSH `/permission` 切换为原生 Agent 访问。 */
  enableNativeAccess(): Promise<string | undefined>
  /** Write one selection to the `agent-default-model` namespace; error message or undefined. */
  setDefault(selection: PickerModelSelection): Promise<string | undefined>
  /** Switch one live config option (protocol-native vocabulary: string value ids for select rows, real booleans for boolean rows). */
  switchOption(configId: string, value: string | boolean): void
  /** Reload the live options snapshot. */
  reloadLive(): void
  /**
 * 收尾：reconciliation-required 的可执行出路——放弃旧 ACP 上下文并重开
   * （dshAcp/rebindBlank；仅 continuity blocked 时 UI 展示入口，DSH 侧历史保留）。
   */
  rebind(): void
  /**
 * 待定模型切换的用户回滚出路（rollback-required / live-undecidable
   * banner 的按钮；ModelSwitchController.rollback 直通）。
   */
  rollbackSwitch(): void
  /**
 * host 权威的会话 backend 查询（行级跨 backend 标记的数据面）。
 * 返回三值探测：ok(state) 照常；unavailable(message) = ACP Remote
   * 失败/非法载荷——seat 进入 native-only 模式（Current/ACP 档隐藏 + 非阻塞
   * 诊断），host 侧 turn 时 throw 兜底不变。
   */
  backend(): Promise<AcpBackendProbe>
  /**
 * 跨 backend 分流（确认后的唯一写入口；确认框两段式在组件层，取消即
   * 不调用）：CAS 写默认 → 公开 session.create（预分配 id，同 id 重试幂等）
   * → sessions.list 有界确认 → sessions.open。返回错误消息；成功为
   * undefined（宿主随即打开新会话）。
   */
  useInNewSession(selection: PickerModelSelection, label?: string): Promise<string | undefined>
  /** 空白 native 会话选择 ACP：无上下文确认，透明创建并打开目标 ACP 会话。 */
  adoptBlankSession(selection: PickerModelSelection, label?: string): Promise<string | undefined>
  /** 取走一次性提示（seat 挂载时消费；无 → null）。 */
  takeNotice(): string | null
}

/** Injected props of the seat; Partial because the renderer erases the share boundary. */
export interface ModelPickerProps {
  locked?: boolean | undefined
  available?: boolean | undefined
  t?: AcpModelTranslate | undefined
  useStore?: SnapshotSelectorHook<ModelPickerState> | undefined
  useDefaultModel?: SnapshotSelectorHook<DefaultScopeSnapshot> | undefined
  picker?: ModelPickerWire | undefined
}

/** Which pane the dropdown shows: the row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort' | 'live'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** The change events our inputs care about (the attribute bag types handlers loosely; see react.d.ts). */
interface InputEvent {
  target: { value: string }
}

interface KeyboardEventLike {
  key: string
  preventDefault(): void
}

interface FocusEventLike {
  relatedTarget: unknown
}

interface MouseEventLike {
  stopPropagation(): void
}

let nextPickerId = 0

const LIVE_SECTION_TITLE: Record<LiveOptionSection, AcpModelKey> = {
  mode: 'live.section.mode',
  thought_level: 'live.section.thoughtLevel',
  model_config: 'live.section.modelConfig',
  other: 'live.section.other',
}
// thought_level / model_config 紧邻模式区之后（协议：SHOULD render near the
// model selector），unknown category 的 other 垫底；各分区内部保持 agent 给定
// 顺序。 model 类选项不进面板（模型切换走目录行 + ModelSwitchCoordinator）。
const LIVE_SECTION_ORDER: readonly LiveOptionSection[] = ['mode', 'thought_level', 'model_config', 'other']

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face + the standard locale seat.
 * @returns the trigger and, while open, the multi-pane menu; null while the
 * shell has not injected yet (ModelsSection precedent).
 */
export function ModelPicker(props: ModelPickerProps): ReactNode {
  const { t, useStore, useDefaultModel, picker } = props
  if (t === undefined || useStore === undefined || useDefaultModel === undefined || picker === undefined) return null
  return h(Loaded, {
    locked: props.locked === true,
    available: props.available === true,
    t,
    useStore,
    useDefaultModel,
    picker,
  })
}

function Loaded({ locked, available, t, useStore, useDefaultModel, picker }: {
  locked: boolean
  available: boolean
  t: AcpModelTranslate
  useStore: SnapshotSelectorHook<ModelPickerState>
  useDefaultModel: SnapshotSelectorHook<DefaultScopeSnapshot>
  picker: ModelPickerWire
}): ReactNode {
  const state = useStore((value) => value.directory)
  const live = useStore((value) => value.live)
  const disclosure = useStore((value) => value.disclosure)
  const defaultSnap = useDefaultModel((value) => value)
  const storedDefault = decodeAgentDefaultModel(
    defaultSnap.status === 'ready' ? defaultSnap.value : undefined,
  )

  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves BOTH catalog loads and rejected selections
  // (no ui-primitives Toast — the seat keeps its local strip).
  const [filter, setFilter] = useState<ProviderFilter>('all')
 // backend 异步到位前用户已手动切档时，默认档落定不得覆盖用户选择。
  const filterTouched = useRef(false)
  const [search, setSearch] = useState('')
  const [defaultError, setDefaultError] = useState<string | null>(null)
 // 会话 backend 事实（菜单打开时经 host backendOf 拉取）。 现在为
  // 三值探测：unavailable = ACP 子系统故障 → native-only 模式（Current/ACP 档
  // 隐藏 + 非阻塞诊断）；ok(null) = 「未知」——不标记，host turn 时 throw 兜底。
  const [probe, setProbe] = useState<AcpBackendProbe | null>(null)
  const backend = probe !== null && probe.status === 'ok' ? probe.state : null
  const acpUnavailableMessage = acpUnavailableMessageOf(probe)
  const [crossError, setCrossError] = useState<string | null>(null)
 // 跨 backend 行的两段式确认（confirmingRebind 同款先例）——确认步显式
  // 陈述「创建全新会话 + 当前上下文不带过去」；取消即丢弃，一切不变（包括默认模型）。
  const [confirmingCross, setConfirmingCross] = useState<{ selection: PickerModelSelection; label: string } | null>(null)
  const [confirmingNative, setConfirmingNative] = useState<{
    selection: PickerModelSelection
    label: string
    cross: boolean
    blank: boolean
  } | null>(null)
  const [nativeAcknowledged, setNativeAcknowledged] = useState(false)
  const [nativeError, setNativeError] = useState<string | null>(null)
 // 跨 backend 分流成功后的一次性提示（本 seat 属于 New Session 流程
  // 打开的新会话；自动消退，不阻断 composer）。
  const [notice, setNotice] = useState<string | null>(null)
  // rebindBlank 二次确认闩锁（AcpSection confirmDelete 同款两段式；
  // 确认步显式陈述「DSH 历史保留 + Agent 语义上下文清空」两个事实）。
  const [confirmingRebind, setConfirmingRebind] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [menuId] = useState(() => `dsh-acp-pick-${(nextPickerId += 1)}`)

  const choices = useMemo(() => state.groups.flatMap((group) =>
    group.models.map((model) => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies PickerModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex((choice) =>
      choice.selection.provider === state.current?.provider
      && choice.selection.model === state.current.model)
  const currentChoice = selectedIndex >= 0 ? choices[selectedIndex] : undefined
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id as string | undefined,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'
  const acp = isAcpProvider(state.current?.provider)
  // 分区题注的 agent 显示名（目录组名剥 ` · ACP` 后缀；目录未加载兜底裸 agent
  // id——selector-logic.ts acpAgentDisplayName）。仅 ACP 面板渲染时消费。
  const acpAgentName = acp ? acpAgentDisplayName(state.groups, state.current?.provider ?? disclosure.provider) : ''

 // 「当前」Tab 事实——仅 host backendOf established ACP 时在场（绝不由
  // state.current 或全局默认推断）；allowedValues/currentValue 取自 live/
  // last-known 快照的 model 类 option，只作交集与「不在目录」判定。
  const currentFacts = useMemo<CurrentRouteFacts | null>(
    () => backend !== null && currentTabAvailable(backend) && backend.state === 'established'
      ? currentRouteFactsOf(backend.provider, live.snapshot)
      : null,
    [backend, live.snapshot],
  )
 // native-only 下用户已停在 Current/ACP 档时折叠回 'all'（档已隐藏）。
  const effectiveFilter = nativeOnlyFilterOf(filter, probe)
  const filteredGroups = useMemo(
    () => {
      const filtered = filterGroups(state.groups, effectiveFilter, search, currentFacts ?? undefined)
      return probe?.status === 'unavailable'
        ? failClosedGroupsForUnavailableProbe(filtered, state.current)
        : filtered
    },
    [state.groups, state.current, effectiveFilter, search, currentFacts, probe],
  )
  const filteredFailures = useMemo(
    () => filterFailures(state.failures, effectiveFilter, currentFacts?.provider),
    [state.failures, effectiveFilter, currentFacts],
  )
 // Agent 当前值不在 provider 目录 → 只读「不在目录/请重新探测」行
  // （绝不把未知模型注入目录）。
  const showNotInCatalog = effectiveFilter === 'current'
    && currentFacts !== null
    && currentValueNotInCatalog(state.groups, currentFacts)

  const reload = (): void => {
    picker.load()
    if (acp) picker.reloadLive()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) picker.load()
  }, [available, picker])

 // seat 挂载时取走「在新会话中使用」的一次性提示（本 seat 通常属于
  // 刚被 New Session 流程打开的新会话）；8s 自动消退。
  useEffect(() => {
    const text = picker.takeNotice()
    if (text === null) return
    setNotice(text)
    const timer = setTimeout(() => { setNotice(null) }, 8000)
    return () => { clearTimeout(timer) }
  }, [picker])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setOpen(true)
    setConfirmingCross(null)
    setConfirmingNative(null)
    setNativeAcknowledged(false)
    setFilter('all')
    filterTouched.current = false
    reload()
 // 每次打开菜单刷新 backend 事实（行级跨 backend 标记的输入）。
 // backend 到位后落定默认档——ACP 会话默认「当前」Tab；用户已手动
 // 切档（filterTouched）则不覆盖。：unavailable 时 native-only——
    // 默认档归 'all'（defaultFilterOf(null)），Current/ACP 档随分档隐藏。
    void picker.backend().then((resolved) => {
      setProbe(resolved)
      if (!filterTouched.current) {
        setFilter(defaultFilterOf(resolved.status === 'ok' ? resolved.state : null))
      }
    })
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    setConfirmingCross(null)
    setConfirmingNative(null)
    setNativeAcknowledged(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter((item) => item !== null)
    if (items.length === 0) return
    const active = items.findIndex((item) => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEventLike): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEventLike): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const choose = (selection: PickerModelSelection): void => {
    if (
      state.current?.provider === selection.provider
      && state.current.model === selection.model
      && (state.current.reasoningEffort ?? undefined) === selection.reasoningEffort
    ) {
      close(true)
      return
    }
    void picker.select(selection).then((accepted) => {
      if (accepted && rootRef.current !== null) close(true)
    })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    choose({
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  }

  const setDefault = (selection: PickerModelSelection): void => {
    setDefaultError(null)
    void picker.setDefault(selection)
      .then((message) => { if (message !== undefined) setDefaultError(message) })
      .catch((error: unknown) => { setDefaultError(errorMessageOf(error)) })
  }

  /**
 * 跨 backend 分流：不 selectModel（host 只会忽略它）。两段式确认后才
   * 调 wire（确认块见 modelPane；取消 = 丢弃 confirmingCross，一切不变）。
   * 事务在 PickerService：解析工作区 → CAS 写默认 → 公开 session.create →
   * 列表确认 → open。失败落错误条（不创建会话）；成功即关闭菜单——宿主随即
   * 打开新会话，提示条由新会话的 seat 展示。
   */
  const useInNew = (selection: PickerModelSelection, label: string): void => {
    setCrossError(null)
    void picker.useInNewSession(selection, label)
      .then((message) => {
        if (message !== undefined) setCrossError(message)
        else close()
      })
      .catch((error: unknown) => { setCrossError(errorMessageOf(error)) })
  }

  const adoptBlank = (selection: PickerModelSelection, label: string): void => {
    setCrossError(null)
    void picker.adoptBlankSession(selection, label)
      .then((message) => {
        if (message !== undefined) setCrossError(message)
        else close()
      })
      .catch((error: unknown) => { setCrossError(errorMessageOf(error)) })
  }

  const requestSelection = (
    selection: PickerModelSelection,
    label: string,
    cross: boolean,
  ): void => {
    const blank = backend?.state === 'blank' && isAcpProvider(selection.provider)
    if (isAcpProvider(selection.provider) && disclosure.preset !== 'danger-full-access') {
      setNativeError(null)
      setNativeAcknowledged(false)
      setConfirmingNative({ selection, label, cross, blank })
      return
    }
    if (blank) {
      adoptBlank(selection, label)
      return
    }
    if (cross) setConfirmingCross({ selection, label })
    else choose(selection)
  }

  const confirmNativeSelection = (): void => {
    const pending = confirmingNative
    if (pending === null || !nativeAcknowledged) return
    setConfirmingNative(null)
    setNativeAcknowledged(false)
    if (pending.blank) {
      adoptBlank(pending.selection, pending.label)
      return
    }
    if (pending.cross) {
      useInNew(pending.selection, pending.label)
      return
    }
    setNativeError(null)
    void picker.enableNativeAccess()
      .then((message) => {
        if (message !== undefined) {
          setNativeError(message)
          return
        }
        choose(pending.selection)
      })
      .catch((error: unknown) => { setNativeError(errorMessageOf(error)) })
  }

 // ACP 触发器身份展示：ACP 模型的 seat 触发钮显示「<Agent 名> · <模型名>」——agent 名
  // 复用 acpAgentDisplayName（组 displayName 剥 ` · ACP` 后缀的唯一来源，
  // 不二次硬编码切割）；native 模型保持只显示模型名。
  const modelLabel = currentChoice === undefined
    ? t('trigger.fallback')
    : acp
      ? `${acpAgentName} · ${currentChoice.model.name}`
      : currentChoice.model.name
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = (itemIndex += 1) - 1
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  const errorStrip = (message: string, key: string): ReactNode =>
    h('div', { key, className: css.error, role: 'alert' },
      h('span', {}, t('error.action', { message })),
      h('button', { type: 'button', className: css.retry, onClick: reload }, t('action.reload')),
    )

  const modelRow = (group: PickerProviderGroup, model: PickerCatalogModel): ReactNode => {
    const selected = state.current?.provider === group.id && state.current.model === model.id
    const selection: PickerModelSelection = {
      provider: group.id,
      model: model.id,
      ...model.reasoning?.defaultEffort === undefined
        ? {}
        : { reasoningEffort: model.reasoning.defaultEffort },
    }
    const isDefault = isDefaultSelection(storedDefault, group.id, model.id)
 // 会话 backend 已锁定且不等于本行路由 = 跨 backend——行仍可见
    // （可发现性），带「需新会话」行级标记，点击分流到「在新会话中使用」。
    const cross = backend !== null && !isSameBackendSelection(selection, backend, state.current?.provider)
    return h('div', { key: model.id, className: css.optionRow },
      h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': selected,
        className: selected ? `${css.option} ${css.optionSelected}` : css.option,
        title: model.name,
        disabled: busy,
        onClick: () => { requestSelection(selection, model.name, cross) },
      },
        h('span', { className: css.optionCopy },
          h('span', { className: css.modelName }, model.name),
          model.description === undefined
            ? null
            : h('span', { className: css.description }, model.description),
        ),
        cross ? h('span', { className: css.crossBadge }, t('cross.badge')) : null,
        h('span', { className: css.check }, selected ? h(IconCheckOutline16, { size: 16 }) : null),
      ),
      isDefault
        ? h('span', { className: `${css.defaultButton} ${css.isDefault}` }, t('default.isDefault'))
        : h('button', {
          ref: itemRef(),
          type: 'button',
          className: css.defaultButton,
          title: t('default.set'),
          onClick: (event: MouseEventLike) => {
            event.stopPropagation()
            setDefault(selection)
          },
        }, t('default.set')),
    )
  }

  const modelPane = (): ReactNode[] => {
 // 「当前」Tab 仅对已建立 ACP binding 的会话存在（host backendOf 权威）；
 // 其余会话保持原生三档。：ACP 子系统 unavailable 时 native-only——
    // Current/ACP 档隐藏（filterBucketsOf），诊断条上屏（下方 warning）。
    const buckets = filterBucketsOf(probe, currentFacts !== null)
    const children: ReactNode[] = [
      h('div', { key: 'filter', className: css.filter },
        h('input', {
          type: 'text',
          className: css.filterInput,
          placeholder: t('filter.placeholder'),
          value: search,
          onChange: (event: InputEvent) => { setSearch(event.target.value) },
        }),
        h('span', { className: css.segment, role: 'group' },
          buckets.map((bucket) =>
            h('button', {
              key: bucket,
              type: 'button',
              className: effectiveFilter === bucket
                ? `${css.segmentButton} ${css.segmentActive}`
                : css.segmentButton,
              'aria-pressed': effectiveFilter === bucket,
              onClick: () => {
                filterTouched.current = true
                setFilter(bucket)
              },
            }, t(bucket === 'current'
              ? 'filter.current'
              : bucket === 'all'
                ? 'filter.all'
                : bucket === 'api' ? 'filter.api' : 'filter.acp'))),
        ),
      ),
    ]
 // native-only 非阻塞诊断——ACP 子系统故障如实点名（Remote/超时/非法
    // 载荷），不阻断原生目录浏览与选择；修复后重开菜单即恢复全量分档。
    if (acpUnavailableMessage !== null) {
      children.push(h('div', { key: 'acp-unavailable', className: css.warning },
        h('span', {}, t('acp.unavailable', { message: acpUnavailableMessage })),
      ))
    }
 // 跨 backend 行的两段式确认块——确认步显式陈述「创建全新会话 +
    // 当前上下文不带过去」；取消即关闭确认块，一切不变（包括默认模型）。
    if (confirmingCross !== null) {
      children.push(h('div', { key: 'cross-confirm', className: css.warning },
        h('span', {},
          h('p', { className: css.policyNote }, t('cross.confirmPrompt', { model: confirmingCross.label })),
        ),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => {
            const pending = confirmingCross
            setConfirmingCross(null)
            useInNew(pending.selection, pending.label)
          },
        }, t('cross.confirmButton')),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => { setConfirmingCross(null) },
        }, t('cross.confirmCancel')),
      ))
    }
    if (confirmingNative !== null) {
      children.push(h('div', { key: 'native-confirm', className: css.warning },
        h('p', { className: css.policyNote }, t(
          confirmingNative.blank ? 'native.confirmBlankPrompt' : confirmingNative.cross ? 'native.confirmCrossPrompt' : 'native.confirmPrompt',
          { model: confirmingNative.label },
        )),
        h('label', { className: css.policyNote },
          h('input', {
            type: 'checkbox',
            checked: nativeAcknowledged,
            onChange: (event: { target: { checked: boolean } }) => {
              setNativeAcknowledged(event.target.checked)
            },
          }),
          ` ${t('native.acknowledge')}`,
        ),
        h('button', {
          type: 'button',
          className: css.retry,
          disabled: !nativeAcknowledged,
          onClick: confirmNativeSelection,
        }, t(confirmingNative.blank ? 'native.confirmBlankButton' : confirmingNative.cross ? 'native.confirmCrossButton' : 'native.confirmButton')),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => {
            setConfirmingNative(null)
            setNativeAcknowledged(false)
          },
        }, t('native.cancel')),
      ))
    }
 // Agent 当前值不在 provider 目录的只读行（不注入未知模型；
    // 重试即重新拉目录 + live 快照）。
    if (showNotInCatalog && currentFacts?.currentValue != null) {
      children.push(h('div', { key: 'not-in-catalog', className: css.warning },
        h('span', {}, t('current.notInCatalog', { model: currentFacts.currentValue })),
        h('button', { type: 'button', className: css.retry, onClick: reload }, t('action.reload')),
      ))
    }
    if (state.status === 'loading') {
      children.push(h('div', { key: 'loading', className: css.status }, t('status.loading')))
    }
    if (state.error !== null) children.push(errorStrip(state.error, 'error'))
    for (const failure of filteredFailures) {
      children.push(h('div', { key: `failure-${failure.id}`, className: css.warning },
        h('span', {}, t('warning.groupLoad', { name: failure.name, message: failure.message })),
        h('button', { type: 'button', className: css.retry, onClick: reload }, t('action.reload')),
      ))
    }
    children.push(h('div', { key: 'groups', className: css.groups },
      filteredGroups.map((group) => {
        const headingId = `${menuId}-${group.id}`
        return h('section', {
          key: group.id,
          role: 'group',
          'aria-labelledby': headingId,
          className: css.group,
        },
          h('div', { className: css.groupTitle, id: headingId },
            h('span', { className: css.tag }, PROVIDER_KIND_LABELS[providerKindOf(group.id)]),
            h('span', {}, group.name),
          ),
          group.models.map((model) => modelRow(group, model)),
        )
      }),
    ))
    if (state.status === 'ready' && filteredGroups.length === 0) {
      children.push(h('div', { key: 'empty', className: css.empty }, t('empty.models')))
    }
    if (defaultError !== null) {
      children.push(h('div', { key: 'defaultError', className: css.error, role: 'alert' },
        h('span', {}, defaultError),
      ))
    }
    if (crossError !== null) {
      children.push(h('div', { key: 'crossError', className: css.error, role: 'alert' },
        h('span', {}, crossError),
      ))
    }
    if (nativeError !== null) {
      children.push(h('div', { key: 'nativeError', className: css.error, role: 'alert' },
        h('span', {}, t('native.failed', { message: nativeError })),
      ))
    }
    return children
  }

  const effortPane = (): ReactNode[] => {
    const children: ReactNode[] = []
    if (state.error !== null) children.push(errorStrip(state.error, 'error'))
    if (effortChoices.length === 0) {
      children.push(h('div', { key: 'empty', className: css.empty }, t('empty.efforts')))
      return children
    }
    children.push(...effortChoices.map((level) =>
      h('button', {
        ref: itemRef(),
        key: level.key,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': effectiveEffort === level.effort,
        className: effectiveEffort === level.effort
          ? `${css.option} ${css.optionSelected}`
          : css.option,
        disabled: busy,
        onClick: () => { chooseEffort(level.effort) },
      },
        h('span', { className: css.optionCopy },
          h('span', { className: css.modelName }, level.label),
          level.description === undefined
            ? null
            : h('span', { className: css.description }, level.description),
        ),
        h('span', { className: css.check }, effectiveEffort === level.effort ? h(IconCheckOutline16, { size: 16 }) : null),
      )))
    return children
  }

  const liveOptionRows = (option: LiveConfigOption): ReactNode => {
 // stale 快照（editable === false）全部控件只读——只读展示面绝不授权写入
    const readonly = live.snapshot?.editable === false
    if (option.type === 'boolean') {
      return h('div', { key: option.id, className: css.liveRow },
        h('span', { className: css.liveRowLabel, title: option.description ?? option.name }, option.name),
        h('button', {
          ref: itemRef(),
          type: 'button',
          role: 'switch',
          'aria-checked': option.currentValue,
          'aria-label': option.name,
          className: css.liveToggle,
          disabled: readonly || live.switching === option.id,
          onClick: () => { picker.switchOption(option.id, !option.currentValue) },
        }, option.currentValue ? t('live.toggleOn') : t('live.toggleOff')),
      )
    }
    return h('div', { key: option.id, className: css.group },
      h('div', { className: css.liveTitle, title: option.description ?? option.name }, option.name),
      flattenLiveValues(option).map((row) => {
        const selected = row.value === option.currentValue
        return h('button', {
          ref: itemRef(),
          key: row.value,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': selected,
          className: selected ? `${css.option} ${css.optionSelected}` : css.option,
          disabled: readonly || live.switching === option.id,
          onClick: () => { picker.switchOption(option.id, row.value) },
        },
          h('span', { className: css.optionCopy },
            h('span', { className: css.modelName },
              row.groupName === undefined
                ? row.name
                : h('span', {},
                  h('span', { className: css.liveGroupName }, `${row.groupName} · `),
                  row.name)),
            row.description === undefined
              ? null
              : h('span', { className: css.description }, row.description),
          ),
          h('span', { className: css.check }, selected ? h(IconCheckOutline16, { size: 16 }) : null),
        )
      }),
    )
  }

  const livePane = (): ReactNode[] => {
    const children: ReactNode[] = []
    if (live.status === 'loading') {
      children.push(h('div', { key: 'loading', className: css.status }, t('live.loading')))
    }
    if (live.error !== null) {
      children.push(h('div', { key: 'error', className: css.error, role: 'alert' },
        h('span', {}, t(live.errorSource === 'switch'
          ? 'live.switchError'
          : live.errorSource === 'rebind'
            ? 'live.rebindError'
            : 'live.error', { message: live.error })),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => { picker.reloadLive() },
        }, t('action.reload')),
      ))
    }
 // 收尾：reconciliation-required 的可执行出路（不只是文案）——连续性闩锁
    // blocked 时展示 cause/指引 + rebindBlank 逃生按钮（放弃旧 ACP 上下文并重开；
    // DSH 侧历史完整保留）。逃生按钮改两段式确认（AcpSection confirmDelete
    // 同款）——首击展开确认步，确认步显式陈述两个事实（DSH 侧历史完整保留；
    // Agent 语义上下文将被清空且不可恢复）后才发起 rebind。失败经 live.error
    // （errorSource='rebind'）如实显示。
    const continuity = live.snapshot?.continuity ?? null
    if (continuity?.status === 'blocked') {
      children.push(h('div', { key: 'blocked', className: css.warning },
        h('p', { className: css.policyNote }, t('live.blocked', {
          cause: continuity.detail ?? continuity.cause ?? '',
        })),
        h('p', { className: css.policyNote }, t('live.blockedGuidance')),
        confirmingRebind
          ? h('div', { key: 'rebind-confirm' },
            h('p', { className: css.policyNote }, t('live.rebindConfirm')),
            h('button', {
              type: 'button',
              className: css.retry,
              disabled: live.rebinding,
              onClick: () => {
                setConfirmingRebind(false)
                picker.rebind()
              },
            }, t(live.rebinding ? 'live.rebinding' : 'live.rebindConfirmButton')),
            h('button', {
              type: 'button',
              className: css.retry,
              disabled: live.rebinding,
              onClick: () => { setConfirmingRebind(false) },
            }, t('live.rebindCancel')),
          )
          : h('button', {
            type: 'button',
            className: css.retry,
            disabled: live.rebinding,
            onClick: () => { setConfirmingRebind(true) },
          }, t(live.rebinding ? 'live.rebinding' : 'live.rebind')),
      ))
    }
 // stale 快照横幅（冷启动只读展示面——不得显示「Agent 不支持」或通用
    // 错误条）；指纹漂移追加诊断行（旧快照只作诊断，不作能力结论）。
    const switchView = live.snapshot?.modelSwitch ?? null
    if (live.snapshot?.freshness === 'stale') {
      children.push(h('div', { key: 'stale', className: css.warning },
        h('span', {}, t('live.staleBanner')),
        live.snapshot.fingerprintChanged
          ? h('p', { className: css.policyNote }, t('live.fingerprintChanged'))
          : null,
      ))
    }
 // 待定模型切换事务的 banner。rollback-required/corrupt 或 live 下的
    // undecidable pending = composer 已锁定（blocked.modelSwitch），此处给出路
    // （回滚按钮；corrupt 无 operationId 可信，不给回滚只指 rebind）；stale 下
    // 的 pending 如实预告 resume 后自动收敛。
    if (switchView?.status === 'rollback-required') {
      children.push(h('div', { key: 'switch-locked', className: css.warning },
        h('p', { className: css.policyNote }, t('live.switchLocked', {
          previous: switchView.previousModel,
          target: switchView.targetModel,
        })),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => { picker.rollbackSwitch() },
        }, t('live.switchRollback', { model: switchView.previousModel })),
      ))
    } else if (switchView?.status === 'corrupt') {
      children.push(h('div', { key: 'switch-corrupt', className: css.warning },
        h('p', { className: css.policyNote }, t('live.switchCorrupt')),
      ))
    } else if (switchView?.status === 'pending') {
      children.push(h('div', { key: 'switch-pending', className: css.warning },
        h('p', { className: css.policyNote }, t(
          live.snapshot?.freshness === 'live' ? 'live.switchUndecidable' : 'live.switchPendingStale',
          { previous: switchView.previousModel, target: switchView.targetModel },
        )),
        live.snapshot?.freshness === 'live'
          ? h('button', {
            type: 'button',
            className: css.retry,
            onClick: () => { picker.rollbackSwitch() },
          }, t('live.switchRollback', { model: switchView.previousModel }))
          : null,
      ))
    }
    const snapshot = live.snapshot
    if (snapshot === null || snapshot.configOptions === null) {
      if (live.status === 'ready') {
        children.push(h('div', { key: 'unavailable', className: css.empty }, t('live.unavailable')))
      }
      return children
    }
    const sections = partitionLiveOptions(snapshot.configOptions)
    if (sections.mode.length === 0 && snapshot.currentModeId !== null) {
      children.push(h('div', { key: 'readonlyMode', className: css.liveRow },
        h('span', { className: css.liveRowLabel }, t('live.section.mode', { agent: acpAgentName })),
        h('span', { className: css.liveRowValue },
          t('live.readonlyMode', { mode: snapshot.currentModeId })),
      ))
    }
    for (const section of LIVE_SECTION_ORDER) {
      const options = section === 'mode'
        ? sections.mode
        : section === 'thought_level'
          ? sections.thoughtLevel
          : section === 'model_config'
            ? sections.modelConfig
            : sections.other
      if (options.length === 0) continue
      children.push(h('div', { key: section, className: css.liveSection },
        h('div', { className: css.liveTitle },
          t(LIVE_SECTION_TITLE[section], section === 'mode' ? { agent: acpAgentName } : undefined)),
        options.map((option) => liveOptionRows(option)),
      ))
    }
    return children
  }

  const rootPane = (): ReactNode[] => [
    h('button', {
      ref: itemRef(),
      key: 'model',
      type: 'button',
      role: 'menuitem',
      className: css.cell,
      onClick: () => { setPane('model') },
    },
      h('span', { className: css.cellLabel }, t('menu.model')),
      h('span', { className: css.cellValue }, modelLabel),
      h(IconChevronRightOutline14, { size: 14, className: css.cellChevron }),
    ),
    reasoning === undefined ? null : h('button', {
      ref: itemRef(),
      key: 'effort',
      type: 'button',
      role: 'menuitem',
      className: css.cell,
      onClick: () => { setPane('effort') },
    },
      h('span', { className: css.cellLabel }, t('menu.effort')),
      h('span', { className: css.cellValue }, effortLabel ?? ''),
      h(IconChevronRightOutline14, { size: 14, className: css.cellChevron }),
    ),
    acp ? h('button', {
      ref: itemRef(),
      key: 'live',
      type: 'button',
      role: 'menuitem',
      className: css.cell,
      onClick: () => {
        setPane('live')
        if (live.status === 'idle') picker.reloadLive()
      },
    },
      h('span', { className: css.cellLabel }, t('menu.liveOptions')),
      h('span', { className: css.cellValue }, liveValueSummary(live)),
      h(IconChevronRightOutline14, { size: 14, className: css.cellChevron }),
    ) : null,
  ]

  return h('div', {
    ref: rootRef,
    className: css.root,
    onKeyDown: onRootKeyDown,
    onBlur,
  },
    h('button', {
      ref: triggerRef,
      type: 'button',
      className: css.trigger,
      'aria-label': triggerAria,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': open ? `${menuId}-menu` : undefined,
      title: effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`,
      disabled: locked,
      onClick: () => {
        if (open) close()
        else show()
      },
    },
      h('span', { className: css.triggerLabel }, modelLabel),
      effortLabel === undefined
        ? null
        : h('span', { className: css.triggerEffort }, effortLabel),
      h(IconChevronDownOutline14, {
        size: 14,
        className: open ? `${css.chevron} ${css.chevronOpen}` : css.chevron,
      }),
    ),
    notice === null
      ? null
      : h('div', { className: css.notice, role: 'status' }, notice),
    open
      ? h('div', {
        id: `${menuId}-menu`,
        className: css.menu,
        role: 'menu',
        'aria-label': t('menu.aria'),
        'aria-busy': state.status === 'loading' || busy,
      },
        pane === 'root' ? rootPane() : null,
        pane === 'model' ? modelPane() : null,
        pane === 'effort' ? effortPane() : null,
        pane === 'live' ? livePane() : null,
      )
      : null,
  )
}

/** The live cell's value caption: current mode id when known, else blank. */
function liveValueSummary(live: LiveOptionsState): string {
  return live.snapshot?.currentModeId ?? ''
}
