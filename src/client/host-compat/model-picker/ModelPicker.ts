/**
 * Render the ACP-aware model picker seat. Directory data, live ACP options,
 * backend access, and cross-backend handoff come from data-layer services;
 * this module owns only the host-compatible interaction shell.
 *
 * When the ACP backend probe is unavailable, the picker enters native-only mode:
 * ACP filters are hidden and native model selection remains available. Native
 * Agent Access and Agent-mode options remain separate controls.
 *
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
import { localizedDiagnostic } from '../../data/diagnostics.ts'
import {
  acpAgentDisplayName,
  acpModelTriggerLabel,
  acpTriggerReasoningLabel,
  acpUnavailableMessageOf,
  failClosedGroupsForUnavailableProbe,
  currentRouteFactsOf,
  currentTabAvailable,
  currentValueNotInCatalog,
  defaultFilterOf,
  filterBucketsOf,
  filterFailures,
  filterGroups,
  flattenLiveValues,
  isAcpProvider,
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

/** The controller wire handed to the seat (bound in apply; plain callbacks). */
export interface ModelPickerWire {
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load(): void
  /** Submit a full provider/model/reasoning selection; resolves to host acceptance. */
  select(selection: PickerModelSelection): Promise<boolean>
  /** 经 DSH `/permission` 把 ACP 会话收敛到原生 Agent 访问。 */
  enableNativeAccess(): Promise<string | undefined>
  /** Switch one live config option (protocol-native vocabulary: string value ids for select rows, real booleans for boolean rows). */
  switchOption(configId: string, value: string | boolean): void
  /** Reload the live options snapshot. */
  reloadLive(): void
  /**
 * host 权威的会话 backend 查询（行级跨 backend 标记的数据面）。
 * 返回三值探测：ok(state) 照常；unavailable(message) = ACP Remote
   * 失败/非法载荷——seat 进入 native-only 模式（Current/ACP 档隐藏 + 非阻塞
   * 诊断），host 侧 turn 时 throw 兜底不变。
   */
  backend(): Promise<AcpBackendProbe>
  /**
 * 跨 backend 分流（确认后的唯一写入口；确认框两段式在组件层，取消即
   * 不调用）：保存 DSH 默认选择 → 公开 session.create（预分配 id，同 id重试幂等）
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
  const { t, useStore, picker } = props
  if (t === undefined || useStore === undefined || picker === undefined) return null
  return h(Loaded, {
    locked: props.locked === true,
    available: props.available === true,
    t,
    useStore,
    picker,
  })
}

function Loaded({ locked, available, t, useStore, picker }: {
  locked: boolean
  available: boolean
  t: AcpModelTranslate
  useStore: SnapshotSelectorHook<ModelPickerState>
  picker: ModelPickerWire
}): ReactNode {
  const state = useStore((value) => value.directory)
  const live = useStore((value) => value.live)
  const backendAccess = useStore((value) => value.backendAccess)

  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves BOTH catalog loads and rejected selections
  // (no ui-primitives Toast — the seat keeps its local strip).
  const [filter, setFilter] = useState<ProviderFilter>('all')
 // backend 异步到位前用户已手动切档时，默认档落定不得覆盖用户选择。
  const filterTouched = useRef(false)
  const [search, setSearch] = useState('')
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
  const [nativeError, setNativeError] = useState<string | null>(null)
 // 跨 backend 分流成功后的一次性提示（本 seat 属于 New Session 流程
  // 打开的新会话；自动消退，不阻断 composer）。
  const [notice, setNotice] = useState<string | null>(null)
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
  const acp = isAcpProvider(state.current?.provider)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
  const triggerEffortLabel = acp
    ? acpTriggerReasoningLabel(live.snapshot, effortLabel)
    : effortLabel
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
  // 分区题注的 agent 显示名（目录组名剥 ` · ACP` 后缀；目录未加载兜底裸 agent
  // id——selector-logic.ts acpAgentDisplayName）。仅 ACP 面板渲染时消费。
  const acpAgentName = acp ? acpAgentDisplayName(state.groups, state.current?.provider ?? backendAccess.provider) : ''

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

  /**
 * 跨 backend 分流：不 selectModel（host 只会忽略它）。两段式确认后才
   * 调 wire（确认块见 modelPane；取消 = 丢弃 confirmingCross，一切不变）。
   * 事务在 PickerService：解析工作区 → 公开 session.create → 列表确认 → open。
   * 失败落错误条（不创建会话）；成功即关闭菜单——宿主随即
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

  const requestSelection = (
    selection: PickerModelSelection,
    label: string,
    cross: boolean,
  ): void => {
    // The host does not expose a seam to replace an already-created live Agent
    // wrapper. Cross-wrapper choices therefore use the same automatic handoff
    // path as the /model entry, without a second confirmation dialog.
    const automaticDraftHandoff = backend?.state === 'blank' || backend?.state === 'draft'
    if (cross && automaticDraftHandoff) {
      useInNew(selection, label)
      return
    }
    if (cross) {
      setConfirmingCross({ selection, label })
      return
    }
    if (isAcpProvider(selection.provider) && backendAccess.preset !== 'danger-full-access') {
      setNativeError(null)
      void picker.enableNativeAccess()
        .then((message) => {
          if (message !== undefined) {
            setNativeError(message)
            return
          }
          choose(selection)
        })
        .catch((error: unknown) => { setNativeError(errorMessageOf(error)) })
      return
    }
    choose(selection)
  }

 // ACP 触发器身份展示：ACP 模型的 seat 触发钮显示「<Agent 名> · <模型名>」——agent 名
  // 复用 acpAgentDisplayName（组 displayName 剥 ` · ACP` 后缀的唯一来源，
  // 不二次硬编码切割）；native 模型保持只显示模型名。
  const modelLabel = currentChoice === undefined
    ? t('trigger.fallback')
    : acp
      ? `${acpAgentName} · ${currentChoice.model.name}`
      : currentChoice.model.name
  const triggerLabel = currentChoice === undefined
    ? modelLabel
    : acp
      ? acpModelTriggerLabel({
        provider: currentChoice.selection.provider,
        agentName: acpAgentName,
        modelName: currentChoice.model.name,
        ...(triggerEffortLabel === undefined ? {} : { reasoningEffort: triggerEffortLabel }),
      })
      : modelLabel
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : t('trigger.aria', { model: triggerLabel })

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = (itemIndex += 1) - 1
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  const errorStrip = (message: string, key: string): ReactNode =>
    h('div', { key, className: css.error, role: 'alert' },
      h('span', {}, t('error.action', { message: localizedDiagnostic(t, 'error.technical', message) })),
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
    // Native-only diagnostic: report ACP failures without blocking native
    // directory browsing or selection.
    if (acpUnavailableMessage !== null) {
      children.push(h('div', { key: 'acp-unavailable', className: css.warning },
        h('span', {}, localizedDiagnostic(t, 'acp.unavailable', acpUnavailableMessage)),
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
        h('span', {}, localizedDiagnostic(t, 'warning.groupLoad', failure.message, { name: failure.name })),
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
    if (crossError !== null) {
      children.push(h('div', { key: 'crossError', className: css.error, role: 'alert' },
        h('span', {}, crossError),
      ))
    }
    if (nativeError !== null) {
      children.push(h('div', { key: 'nativeError', className: css.error, role: 'alert' },
        h('span', {}, t('native.failed', { message: localizedDiagnostic(t, 'error.technical', nativeError) })),
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
            : 'live.error', { message: localizedDiagnostic(t, 'error.technical', live.error) })),
        h('button', {
          type: 'button',
          className: css.retry,
          onClick: () => { picker.reloadLive() },
        }, t('action.reload')),
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
      title: triggerLabel,
      disabled: locked,
      onClick: () => {
        if (open) close()
        else show()
      },
    },
      h('span', { className: css.triggerLabel }, triggerLabel),
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
