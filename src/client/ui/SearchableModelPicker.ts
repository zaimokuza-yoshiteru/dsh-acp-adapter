import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { MenuSurface, StateDot, IconChevronDownOutlineRegular, IconDataOutlineRegular, Toast, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ModelPickerLocaleKey } from './model-picker-locales.ts'
import css from './SearchableModelPicker.module.css'

export type ModelPickerTranslate = (key: ModelPickerLocaleKey, params?: Record<string, string | number>) => string

interface Props extends ModelSelectInjected {
  locked: boolean
  t: ModelPickerTranslate
}

/** Opt-in searchable renderer for the existing session model directory slot. */
export function SearchableModelPicker({ available, directory, load, select, locked, t }: Props) {
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'model' | 'effort'>('model')
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const lastActionRef = useRef<'load' | 'select'>('load')
  const toastSequence = useRef(0)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const busy = state.pending !== null
  const groups = useMemo(() => state.groups.toSorted((a, b) =>
    (a.id === 'deepseek-account' ? 0 : a.id === 'deepseek-official' ? 1 : 2)
      - (b.id === 'deepseek-account' ? 0 : b.id === 'deepseek-official' ? 1 : 2)), [state.groups])
  const currentGroup = groups.find(group => group.id === state.current?.provider)
  const currentModel = currentGroup?.models.find(model => model.id === state.current?.model)
  const reasoning = currentModel?.reasoning
  const effort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effort === undefined
      ? t('providerDefault')
      : reasoning.efforts.find(row => row.id === effort)?.name ?? effort
  const choices = useMemo(() => groups.flatMap(group => group.models.map(model => ({ group, model }))), [groups])
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const filtered = choices.filter(({ group, model }) => {
    const providerName = group.id === 'deepseek-account' ? t('providerAccount') : group.name
    const searchable = `${model.name} ${model.id} ${group.name} ${providerName} ${group.id}`.toLocaleLowerCase()
    return terms.every(term => searchable.includes(term))
  })
  const effortChoices = reasoning === undefined ? [] : [
    ...(reasoning.defaultEffort === undefined ? [{ id: undefined as string | undefined, name: t('providerDefault') }] : []),
    ...reasoning.efforts.map(row => ({ id: row.id as string | undefined, name: row.name })),
  ]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    searchRef.current?.focus()
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [open])

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const width = menuRef.current?.offsetWidth ?? 0
      const height = menuRef.current?.offsetHeight ?? 0
      const margin = 12
      setPosition({
        left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(rect.top - height - 8, window.innerHeight - height - margin)),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state, filtered.length])

  if (!available) return null

  const show = (): void => {
    if (locked) return
    setQuery('')
    lastActionRef.current = 'load'
    setPane('model')
    setOpen(true)
    load()
  }
  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const settle = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      close()
    } else {
      toastSequence.current += 1
      setToast({ seq: toastSequence.current, text: result.error.code === 'session/writer-held'
        ? t('sessionInUse')
        : t('operationFailed', { message: `${result.error.code}: ${result.error.message}` }) })
    }
  }
  const submit = (selection: ModelSelection): void => {
    if (locked || busy) return
    lastActionRef.current = 'select'
    triggerRef.current?.focus()
    Promise.resolve().then(() => select(selection)).then(settle).catch((error: unknown) => {
      toastSequence.current += 1
      setToast({ seq: toastSequence.current, text: t('operationFailed', { message: error instanceof Error ? error.message : String(error) }) })
    })
  }
  const choose = (groupId: string, modelId: string): void => {
    if (locked || busy) return
    if (state.current?.provider === groupId && state.current.model === modelId) { close(); return }
    submit({ provider: groupId, model: modelId })
  }
  const chooseEffort = (value: string | undefined): void => {
    if (locked || busy || state.current === null) return
    if (effort === value) { close(); return }
    submit({ provider: state.current.provider, model: state.current.model, ...(value === undefined ? {} : { reasoningEffort: value }) })
  }
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const rows = menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-picker-row]:not(:disabled)')
      rows?.item(event.key === 'ArrowDown' ? 0 : rows.length - 1)?.focus()
    }
    // Enter intentionally stays in the search field: selecting on Enter while
    // an IME is committing a composition would choose a model unexpectedly.
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-picker-row]:not(:disabled)') ?? [])
    if (rows.length === 0) return
    event.preventDefault()
    const active = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = active < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  }
  const error = state.error !== null && state.status === 'error' && lastActionRef.current === 'load' ? state.error : null
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next instanceof Node && (rootRef.current?.contains(next) === true || menuRef.current?.contains(next) === true)) return
    setOpen(false)
  }
  const menu = open ? createPortal(h(MenuSurface, {
    ref: menuRef,
    role: 'dialog',
    'aria-label': t('model'),
    'aria-busy': state.status === 'loading' || busy,
    className: css.menu,
    style: { ...(position ?? { left: 12, top: 12 }), visibility: position === null ? 'hidden' : 'visible' },
    onKeyDown: onMenuKeyDown,
    children: [
      h('div', { className: css.heading, key: 'heading' },
        h('button', { type: 'button', className: pane === 'model' ? css.activeTab : css.tab, onClick: () => { setPane('model') } }, t('model')),
        h('button', { type: 'button', className: pane === 'effort' ? css.activeTab : css.tab, disabled: reasoning === undefined, onClick: () => { setPane('effort') } }, t('effort')),
      ),
      pane === 'model' ? h('input', {
        key: 'search',
        ref: searchRef,
        type: 'search',
        role: 'searchbox',
        'aria-label': t('search'),
        className: css.search,
        placeholder: t('search'),
        value: query,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) },
        onKeyDown: onSearchKeyDown,
        disabled: busy || locked,
      }) : null,
      error !== null ? h('div', { className: css.error, key: 'error', role: 'alert' },
        h('span', null, t('operationFailed', { message: error })),
        h('button', { type: 'button', onClick: reload }, t('retry')),
      ) : null,
      state.failures.map(failure => h('div', { className: css.warning, key: `failure:${failure.id}` },
        h('span', null, t('groupFailed', { name: failure.name || failure.id, message: failure.message })),
        h('button', { type: 'button', onClick: reload }, t('retry')),
      )),
      state.status === 'loading' ? h('div', { className: css.status, key: 'loading' }, t('loading')) : null,
      pane === 'model' ? h('div', { className: css.rows, role: 'menu', key: 'models' }, ...groups.map(group => {
        const visible = filtered.filter(row => row.group.id === group.id)
        if (visible.length === 0) return null
        return h('section', { role: 'group', 'aria-label': group.name, key: group.id },
          h('div', { className: css.groupTitle }, group.id === 'deepseek-account' ? t('providerAccount') : group.name),
          ...visible.map(({ model }) => {
            const selected = state.current?.provider === group.id && state.current.model === model.id
            return h('button', {
              type: 'button', role: 'menuitemradio', 'aria-checked': selected, 'data-picker-row': '',
              className: selected ? css.selected : css.row,
              key: `${group.id}:${model.id}`, title: `${group.id}/${model.id}`, disabled: busy || locked,
              onClick: () => { choose(group.id, model.id) },
              children: [h('span', { className: css.rowName, key: 'name' }, model.name), h('span', { className: css.check, key: 'check' },
                state.pending?.provider === group.id && state.pending.model === model.id ? h(StateDot, { state: 'ongoing' }) : selected ? '✓' : null)],
            })
          }),
        )
      })) : h('div', { className: css.rows, role: 'menu', key: 'efforts' },
        ...effortChoices.map(choice => h('button', {
          type: 'button', role: 'menuitemradio', 'aria-checked': effort === choice.id, 'data-picker-row': '',
          className: effort === choice.id ? css.selected : css.row, key: choice.id ?? 'default', disabled: busy || locked,
          onClick: () => { chooseEffort(choice.id) },
          children: [h('span', { className: css.rowName, key: 'name' }, choice.name), h('span', { className: css.check, key: 'check' },
          state.pending !== null && state.pending.provider === state.current?.provider && state.pending.model === state.current?.model
            && state.pending.reasoningEffort === choice.id ? h(StateDot, { state: 'ongoing' }) : effort === choice.id ? '✓' : null)],
        })),
      ),
      pane === 'model' && filtered.length === 0 && state.status === 'ready'
        ? h('div', { className: css.status, key: 'empty' }, choices.length === 0 ? t('noModels') : t('noResults')) : null,
      pane === 'effort' && effortChoices.length === 0
        ? h('div', { className: css.status, key: 'no-efforts' }, t('noEfforts')) : null,
    ],
  }), document.body) : null

  return h('div', { ref: rootRef, className: css.root, 'data-acp-searchable-model-picker': '', onBlur },
    h('button', {
      ref: triggerRef, type: 'button', className: css.trigger, disabled: locked || !available,
      'aria-label': currentModel?.name ?? (state.current === null ? t('trigger') : `${state.current.provider}/${state.current.model}`),
      'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-busy': busy,
      title: `${currentModel?.name ?? state.current?.model ?? t('trigger')}${effortLabel === undefined ? '' : ` · ${effortLabel}`}`,
      onClick: () => { open ? close() : show() },
      children: [h(IconDataOutlineRegular, { className: css.triggerIcon, size: 16, key: 'icon' }),
        h('span', { className: css.triggerName, key: 'name' }, currentModel?.name ?? state.current?.model ?? t('trigger')),
        effortLabel === undefined ? null : h('span', { className: css.triggerEffort, key: 'effort' }, effortLabel),
        busy ? h(StateDot, { state: 'ongoing', key: 'busy' }) : h(IconChevronDownOutlineRegular, { className: css.chevron, key: 'chevron' })],
    }),
    menu,
    toast === null ? null : h(Toast, {
      key: toast.seq,
      text: toast.text,
      icon: h(IconWarningOutlineRegular),
      anchor: rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null,
      onDone: () => { setToast(null) },
    }),
  )
}
