import {
  createElement as h,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutlineMedium, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { accountUsageLinks, accountUsageProvider } from '../../contract/account-usage.ts'
import { acpAgentIdFromRoute, acpProbeConfigKey } from '../../contract/agent-config.ts'
import type { AcpScopeSnapshot } from '../data/logic.ts'
import { includesRoute, type UseRouteOwnership } from '../data/managed-routes.ts'
import { composerSelection, useComposerDefault, type ComposerDefaultProvider } from './composer-provider.ts'
import { AccountUsageRow } from './AccountUsageRow.ts'
import type { AcpSectionWire } from './AcpSection.ts'
import css from './AccountPlanControl.module.css'

type Props = PropsRuntime<'conversation.input.right'> &
  PropsLocale<'acpActivity'> &
  Pick<ComposerDefaultProvider, 'watchDefaultProvider'> & {
    getDefaultSelection(): Promise<{ provider: string; model: string } | undefined>
    useAccountSettings: SnapshotSelectorHook<AcpScopeSnapshot>
    useRouteOwnership: UseRouteOwnership
    usePlanOpen: SnapshotSelectorHook<boolean>
    setOpen(open: boolean): void
    read: AcpSectionWire['accountUsage']
  }

/** A nonmodal account panel follows this composer's confirmed provider. */
export function AccountPlanControl({
  sessionId,
  useProjection,
  useRemoteAccess,
  useAccountSettings,
  useRouteOwnership,
  getDefaultSelection,
  watchDefaultProvider,
  usePlanOpen,
  setOpen,
  read,
  t,
}: Props) {
  const fallback = useComposerDefault(getDefaultSelection, watchDefaultProvider)
  const selection = composerSelection(useProjection('modelSelection'), fallback)
  const provider = selection?.provider
  const owned = useRouteOwnership((routes) => includesRoute(routes.providers, provider))
  const id = provider && owned ? acpAgentIdFromRoute(provider) : undefined
  const config = useAccountSettings((snapshot) =>
    id && snapshot.status === 'ready' && snapshot.writable ? snapshot.value?.agents?.[id] : undefined,
  )
  const mayRead = useRemoteAccess('dshAcp/accountUsage')
  const mayManage = useRemoteAccess('settings/mutate')
  const permitted = mayRead && mayManage
  const queries = config && id ? accountUsageProvider(id, config) : undefined
  const links = config && id ? accountUsageLinks(id, config, selection?.model) : []
  const open = usePlanOpen((value) => value)
  const target = Boolean(queries || links.length)
  const anchor = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  const panelId = `dsh-acp-plan-${sessionId}-${useId()}`
  const [position, place] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!permitted && open) setOpen(false)
    const button = anchor.current
    const composer = button?.closest('[data-composer-card]')
    if (!open || !permitted || !button || !composer) return
    const positionPanel = () => {
      const rect = button.getBoundingClientRect()
      const card = composer.getBoundingClientRect()
      const width = Math.min(302, window.innerWidth - 16)
      const above = Math.max(0, card.top - 16)
      const below = Math.max(0, window.innerHeight - card.bottom - 16)
      place({
        width,
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
        ...(Math.max(above, below) < 90
          ? { top: 8, maxHeight: window.innerHeight - 16 }
          : above >= 180 || above >= below
            ? { bottom: Math.max(8, window.innerHeight - card.top + 8), maxHeight: above }
            : { top: Math.max(8, card.bottom + 8), maxHeight: below }),
      })
    }
    positionPanel()
    const observer = new ResizeObserver(positionPanel)
    observer.observe(composer)
    observer.observe(button)
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionPanel)
      window.removeEventListener('scroll', positionPanel, true)
    }
  }, [open, permitted, sessionId, setOpen])
  useLayoutEffect(() => {
    if (open && position && keyboardOpen.current) {
      closeButton.current?.focus({ preventScroll: true })
      keyboardOpen.current = false
    }
  }, [open, position])
  if (!permitted || (!target && !open)) return null
  const close = () => {
    setOpen(false)
    anchor.current?.focus({ preventScroll: true })
  }
  return h(
    'span',
    { className: css.anchor, 'data-dsh-acp-plan-control': sessionId },
    h(
      'button',
      {
        type: 'button',
        ref: anchor,
        className: css.trigger,
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        'aria-label': t('accountCheck'),
        onClick: (event: MouseEvent<HTMLButtonElement>) => {
          if (open) return
          keyboardOpen.current = event.detail === 0
          setOpen(true)
        },
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
          if (open && event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        },
      },
      t('accountTrigger'),
    ),
    open && position
      ? createPortal(
          h(
            MenuSurface,
            {
              id: panelId,
              role: 'region',
              className: css.panel,
              style: position,
              'aria-labelledby': `${panelId}-title`,
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  close()
                }
              },
            },
            h(
              'header',
              { className: css.header },
              h(
                'strong',
                { id: `${panelId}-title` },
                config ? `${config.name} · ${t('accountTitle')}` : t('accountTitle'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  ref: closeButton,
                  onClick: close,
                  className: css.close,
                  'aria-label': t('accountClose'),
                },
                h(IconCloseOutlineMedium, { size: 16 }),
              ),
            ),
            target && config && id
              ? h(AccountUsageRow, {
                  key: `${id}:${acpProbeConfigKey(config)}`,
                  id,
                  read: queries ? read : undefined,
                  links,
                  expanded: true,
                  t,
                })
              : h('span', { role: 'status' }, t('accountNotProvided')),
          ),
          document.body,
        )
      : null,
  )
}
