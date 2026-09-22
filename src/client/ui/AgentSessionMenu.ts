import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { IconChevronDownOutlineMedium, IconChevronRightOutlineMedium, IconChevronLeftOutlineMedium, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentControlChoice, AgentControlGroup, AgentControlTranslate } from './agent-session-controls.ts'
import css from './AcpAgentControl.module.css'

type Props = {
  readonly groups: readonly AgentControlGroup[]
  readonly footer?: readonly MenuEntry[]
  readonly label: string
  readonly t: AgentControlTranslate
  readonly open: boolean
  readonly disabled?: boolean
  readonly side?: 'top' | 'bottom'
  readonly align?: 'start' | 'end'
  readonly onOpenChange: (open: boolean) => void
  readonly onSelect: (choice: AgentControlChoice) => void
}

/** One native menu for main sessions, member modes and batch modes.
 * Callers supply visible choices and write permissions; presentation never
 * derives authority from whether the menu is shown in a team or composer.
 */
export function AgentSessionMenu({ groups, footer, label, t, open, disabled, side = 'top', align = 'start', onOpenChange, onSelect }: Props): ReactNode {
  const [pane, setPane] = useState<string | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const firstContent = useRef<HTMLSpanElement>(null)
  const group = groups.find(candidate => candidate.id === pane)
  useEffect(() => { if (!open) setPane(null) }, [open])
  useLayoutEffect(() => {
    if (!open) return
    // The list is portaled to avoid clipping inside the team panel. Focus its
    // first native row after replacing a pane, retaining native arrow keys.
    firstContent.current?.closest('[role=menu]')?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus()
  }, [open, group?.id])
  const items: MenuEntry[] = group === undefined
    ? groups.map((item, index) => ({ id: item.id, label: h('span', {
      className: `${css.menuContent} ${css.settingRow}`, ref: index === 0 ? firstContent : undefined, title: item.description ?? undefined,
    }, h('span', { className: css.settingName }, item.name),
    h('span', { className: css.currentValue, title: item.current }, item.current), h(IconChevronRightOutlineMedium, null)), disabled: item.choices.length === 0 }))
    : [{ id: 'back', label: h('span', { className: css.menuContent, ref: firstContent }, t('agentControlBack')), icon: h(IconChevronLeftOutlineMedium, null) },
      { type: 'label', id: 'setting-title', text: group.name },
      ...(group.description ? [{ type: 'label' as const, id: 'setting-description', text: group.description }] : []),
      ...group.choices.flatMap((choice, index) => [
        ...(choice.group !== undefined && choice.group !== group.choices[index - 1]?.group
          ? [{ type: 'label' as const, id: `group:${index}`, text: choice.group }] : []),
        { id: choice.id, disabled: choice.disabled, label: h('span', { className: `${css.menuContent} ${css.choice}` }, choice.label,
          choice.description ? h('span', { className: css.choiceDescription }, choice.description) : null) },
      ])]
  if (items.length === 0) items.push({ id: 'unavailable', label: h('span', { className: css.menuContent }, t('agentControlUnavailable')), disabled: true })
  return h('span', { ref: anchor, className: css.menuAnchor }, h(Menu, {
    open, portal: true, autoFocus: true, side, align, items, listClassName: css.menuList,
    // Pane heights differ; let native positioning remeasure on each render.
    getAnchorRect: () => anchor.current?.getBoundingClientRect() ?? null,
    selectedId: group?.choices.find(choice => choice.current)?.id,
    onClose: () => onOpenChange(false),
    onSelect: (id: string) => {
      if (id === 'back') { setPane(null); return }
      if (group === undefined) { if (groups.some(candidate => candidate.id === id)) setPane(id); return }
      const choice = group.choices.find(candidate => candidate.id === id)
      if (choice === undefined || choice.disabled || disabled) return
      onOpenChange(false)
      onSelect(choice)
    },
    anchor: h(Tooltip, { label: t('agentControlTooltip'), portal: true, side: 'top', disabled: open, children: h<ButtonHTMLAttributes<HTMLButtonElement>>('button', {
      type: 'button', className: css.trigger, disabled, 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: () => { setPane(null); onOpenChange(!open) },
    }, h('span', { className: css.triggerLabel }, label),
    h(IconChevronDownOutlineMedium, { className: `${css.chevron}${open ? ` ${css.chevronOpen}` : ''}` })) }),
    ...(footer === undefined || footer.length === 0 ? {} : { footer }),
  }))
}
