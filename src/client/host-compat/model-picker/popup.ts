/**
 * /model popup row builders — the copied-upstream shell surface of the picker
 * Host compatibility island. Everything here is a fork of the built-in
 * ui-model-selection package's popup logic: it only translates the native
 * directory snapshot into popupSelect rows and back (DSH row/popup interaction
 * adaptation). ACP business logic (backend detection, filters, confirmations
 * beyond the shell's own contract) lives in src/client/data/* and is imported,
 * never reimplemented, here.
 *
 * Fork provenance (upstream dsh-v0.1.1-rc.2, commit b150a551b8; the upstream
 * package `@deepseek-ai/dsh-client-ui-model-selection` is unpublished, hence a
 * source-level fork, MIT):
 * - verbatim: `rowId`, `selectionOf` (upstream`src/client/index.ts`);
 * - modified: `optionsOf` keeps the upstream grouping skeleton and adds the
 * `[Model]`/`[ACP]` provider tag prefix plus the cross-backend row
 * marking / in-shell confirmation copy (adapter-original enhancements);
 * - `PickerSelectOption` is the structural copy of the popupSelect shell's
 *   `SelectOption` row contract (dsh-client-ui-commands).
 * test/contracts/upstream-picker-diff.spec.ts pins the verbatim functions against the
 * reference checkout; scripts/check-upstream-picker-diff.mjs re-runs the same
 * pins standalone — an upstream bump turns both red and forces review.
 * @module @zaimokuza/dsh-acp-adapter/client/host-compat/model-picker/popup
 */

import { isAcpProvider, isSameBackendSelection, PROVIDER_KIND_LABELS, providerKindOf } from '../../data/selector-logic.ts'
import type {
  ModelDirectoryState,
  PickerBackendState,
  PickerModelSelection,
  PickerTranslate,
  SessionModelsView,
} from '../../data/selector-logic.ts'

/** Structural copy of the popupSelect shell's `SelectOption` row (dsh-client-ui-commands). */
export interface PickerSelectOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly active?: boolean
  /**
 * 该行是跨 backend 选择（会话 backend 已锁定且不等于该行路由）。
   * 只读标记——popup 壳没有行级 disable；onSelect 据此分流到「在新会话中使用」。
   */
  readonly crossBackend?: boolean
  /**
 * 跨 backend 行的壳内风险确认（wire copy of ui-commands
   * `SelectConfirmation`）——壳在调 onSelect 前展示确认框（勾选 + 确认/取消；
   * 取消即回到选项列表，onSelect 不运行，默认模型等一切不变）。
   */
  readonly confirmation?: {
    readonly title: string
    readonly description: string
    readonly acknowledgeLabel: string
    readonly cancelLabel: string
    readonly confirmLabel: string
  }
}

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
export function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/**
 * Flatten the directory into popup rows (built-in `optionsOf`, plus the
 * normalized `[Model]`/`[ACP]` provider tag prefixing the detail so the shell's
 * own text search can find it). Failure rows are listed for visibility but
 * never selectable (built-in semantics: they carry no `active` and
 * `selectionOf` refuses them).
 *
 * 可选第三参 `backend`（host `backendOf` 的应答）。会话 backend 已锁定时，
 * 跨 backend 的行仍列出（可发现性），但带 `crossBackend: true` 标记且 detail
 * 前缀「需新会话」披露；onSelect 据此分流到「在新会话中使用」，不再 selectModel。
 *
 * ACP 会话（backend established 且 acp-*）把当前 profile 的组置顶
 * （稳定排序，其余组保持目录原序）。：跨 backend 行附壳内确认框文案
 * （壳在 onSelect 前强制勾选确认；取消不触发 onSelect，默认模型不变）。
 */
export function optionsOf(
  directory: SessionModelsView,
  t: PickerTranslate,
  backend?: PickerBackendState,
): PickerSelectOption[] {
  const rows: PickerSelectOption[] = []
  const pinnedProvider = backend !== undefined && backend.state === 'established' && isAcpProvider(backend.provider)
    ? backend.provider
    : undefined
  const ordered = pinnedProvider === undefined
    ? directory.groups
    : [...directory.groups].sort((a, b) =>
      (a.id === pinnedProvider ? 0 : 1) - (b.id === pinnedProvider ? 0 : 1))
  for (const group of ordered) {
    const tag = PROVIDER_KIND_LABELS[providerKindOf(group.id)]
    const crossBackend = backend !== undefined && !isSameBackendSelection(
      { provider: group.id },
      backend,
      directory.current.provider,
    )
    // blank/draft handoff is automatic because rc.2 cannot replace the live
    // wrapper. Only an established backend needs an explicit confirmation.
    const explicitConfirmation = backend?.state === 'established'
    for (const model of group.models) {
      const base = model.description !== undefined
        ? `[${tag}] ${group.name} · ${model.description}`
        : `[${tag}] ${group.name}`
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail: crossBackend ? t('option.crossBackend', { detail: base }) : base,
        ...(directory.current.provider === group.id && directory.current.model === model.id
          ? { active: true } : {}),
        ...(crossBackend ? { crossBackend: true } : {}),
        ...(crossBackend && explicitConfirmation ? {
          confirmation: {
            title: t('cross.popup.title'),
            description: t('cross.popup.description', { model: model.name }),
            acknowledgeLabel: t('cross.popup.acknowledge'),
            cancelLabel: t('cross.popup.cancel'),
            confirmLabel: t('cross.popup.confirm'),
          },
        } : {}),
      })
    }
  }
  for (const failure of directory.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: t('option.loadError', { message: failure.message }),
    })
  }
  return rows
}

/**
 * Resolve a picked row back to its model selection by matching against the
 * loaded groups (built-in `selectionOf`; ids stay opaque). A same-route pick
 * preserves the current effort; any other pick starts from the model's own
 * default effort.
 */
export function selectionOf(state: ModelDirectoryState, id: string): PickerModelSelection | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
    }
  }
  return undefined
}
