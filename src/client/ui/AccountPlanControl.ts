import {
  createElement as h,
  useId,
  useLayoutEffect,
  useRef,
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
  const instanceId = useId()
  const panelId = `dsh-acp-plan-${sessionId}-${instanceId}`
  const anchorStyle: CSSProperties & Record<'--acp-plan-anchor', string> = {
    '--acp-plan-anchor': `--acp-plan-${instanceId.replaceAll(':', '')}`,
  }
  useLayoutEffect(() => {
    if (!permitted && open) setOpen(false)
    if (permitted && open && keyboardOpen.current) {
      closeButton.current?.focus({ preventScroll: true })
      keyboardOpen.current = false
    }
  }, [permitted, open, setOpen])
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
        style: anchorStyle,
        className: css.trigger,
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        'aria-label': t('accountCheck'),
        onClick: (event: MouseEvent<HTMLButtonElement>) => {
          if (open) return close()
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
    open
      ? createPortal(
          h(
            MenuSurface,
            {
              id: panelId,
              role: 'region',
              className: css.panel,
              style: anchorStyle,
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
