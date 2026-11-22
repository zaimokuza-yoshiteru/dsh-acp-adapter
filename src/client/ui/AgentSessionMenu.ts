import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import {
  IconChevronDownOutlineMedium,
  IconChevronRightOutlineMedium,
  IconChevronLeftOutlineMedium,
  Menu,
  Tooltip,
  focusWithoutRing,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentControlChoice, AgentControlGroup, AgentControlTranslate } from './agent-session-controls.ts'
import css from './AcpAgentControl.module.css'

type Props = {
  readonly groups: readonly AgentControlGroup[]
  readonly footer?: readonly MenuEntry[]
  readonly label: string
  readonly primaryGroup?: AgentControlGroup | undefined
  readonly replacesPermission?: boolean
  readonly pendingIntent?: boolean
  readonly actions?: readonly { id: string; label: string; run(): void }[]
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
export function AgentSessionMenu({
  groups,
  footer,
  label,
  primaryGroup,
  replacesPermission,
  pendingIntent,
  actions,
  t,
  open,
  disabled,
  side = 'top',
  align = 'start',
  onOpenChange,
  onSelect,
}: Props): ReactNode {
  const [pane, setPane] = useState<string | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const firstContent = useRef<HTMLSpanElement>(null)
  const group = groups.find((candidate) => candidate.id === pane) ?? primaryGroup
  const selected = group?.choices.find((choice) => choice.current)
  const atRoot = pane === null || !groups.some((candidate) => candidate.id === pane)
  useEffect(() => {
    if (!open) setPane(null)
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    // The list is portaled to avoid clipping inside the team panel. Focus its
    // first native row after replacing a pane, retaining native arrow keys.
    const first = firstContent.current
      ?.closest('[role=menu]')
      ?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')
    if (first !== null && first !== undefined) focusWithoutRing(first)
  }, [open, group?.id])
  const groupRows = groups
    .filter((item) => item.id !== primaryGroup?.id)
    .map((item, index) => ({
      id: `setting:${item.id}`,
      label: h(
        'span',
        {
          className: css.settingRow,
          ref: group === undefined && index === 0 ? firstContent : undefined,
          title: item.description ?? undefined,
        },
        h('span', { className: css.settingName }, item.name),
        h('span', { className: css.currentValue, title: item.current }, item.current),
        h(IconChevronRightOutlineMedium, null),
      ),
      disabled: item.choices.length === 0,
    }))
  const items: MenuEntry[] = []
  if (group !== undefined) {
    if (!atRoot)
      items.push({
        id: 'back',
        label: h('span', { ref: firstContent }, t('agentControlBack')),
        icon: h(IconChevronLeftOutlineMedium, null),
      })
    items.push(
      { type: 'label', id: 'setting-title', text: group.name },
      ...(group.description ? [{ type: 'label' as const, id: 'setting-description', text: group.description }] : []),
      ...group.choices.flatMap((choice, index) => [
        ...(choice.group !== undefined && choice.group !== group.choices[index - 1]?.group
          ? [{ type: 'label' as const, id: `group:${index}`, text: choice.group }]
          : []),
        {
          id: `choice:${choice.id}`,
          disabled: choice.disabled,
          label: h(
            'span',
            { className: css.choice, ref: atRoot && index === 0 ? firstContent : undefined },
            choice.label,
            choice.description ? h('span', { className: css.choiceDescription }, choice.description) : null,
          ),
        },
      ]),
    )
  }
  if (atRoot) {
    items.push(...groupRows)
    for (const action of actions ?? []) items.push({ id: `action:${action.id}`, label: action.label })
  }
  if (items.length === 0)
    items.push({
      id: 'unavailable',
      label: h('span', null, t('agentControlUnavailable')),
      disabled: true,
    })
  return h(
    'span',
    {
      ref: anchor,
      className: css.menuAnchor,
      'data-acp-permission-replacement': replacesPermission || undefined,
      'data-acp-intent-pending': pendingIntent || undefined,
    },
    h(Menu, {
      open,
      portal: true,
      autoFocus: true,
      side,
      align,
      items,
      listClassName: css.menuList,
      anchorRef: anchor,
      selectedId: selected ? `choice:${selected.id}` : undefined,
      onClose: () => onOpenChange(false),
      onSelect: (id: string) => {
        if (id === 'back') {
          setPane(null)
          return
        }
        const action = atRoot ? actions?.find((candidate) => `action:${candidate.id}` === id) : undefined
        if (action !== undefined) {
          onOpenChange(false)
          action.run()
          return
        }
        const setting = atRoot ? groups.find((candidate) => `setting:${candidate.id}` === id) : undefined
        if (setting) {
          setPane(setting.id)
          return
        }
        const choice = group?.choices.find((candidate) => `choice:${candidate.id}` === id)
        if (choice === undefined || choice.disabled || disabled) return
        onOpenChange(false)
        onSelect(choice)
      },
      anchor: h(Tooltip, {
        label: primaryGroup?.name ?? t('agentControlTooltip'),
        portal: true,
        side: 'top',
        disabled: open,
        children: h<ButtonHTMLAttributes<HTMLButtonElement>>(
          'button',
          {
            type: 'button',
            className: css.trigger,
            disabled,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: () => {
              setPane(null)
              onOpenChange(!open)
            },
          },
          h('span', { className: css.triggerLabel }, label),
          h(IconChevronDownOutlineMedium, { className: `${css.chevron}${open ? ` ${css.chevronOpen}` : ''}` }),
        ),
      }),
      ...(footer === undefined || footer.length === 0 ? {} : { footer }),
    }),
  )
}
