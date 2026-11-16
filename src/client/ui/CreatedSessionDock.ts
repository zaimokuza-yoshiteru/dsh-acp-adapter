import { createElement as h, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrossBackendCoordinator } from '../coordinator/cross-backend-coordinator.ts'
import { useSessionActionAccess, type SessionAccessSource } from './session-action-access.ts'
import css from './AcpRecoveryDock.module.css'

/** A withdrawn selection can leave a blank Session hidden by the native tree. */
export function CreatedSessionDock({
  sessionId,
  useSessionRetainInfo,
  useSessions,
  coordinator,
  sessionAccessSource,
  t,
}: PropsRuntime<'conversation.input.dock'> &
  PropsLocale<'acpActivity'> & {
    coordinator: CrossBackendCoordinator
    sessionAccessSource: SessionAccessSource
  }): ReactNode {
  const created = useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.getSnapshot().created,
  )
  const main = useSessionRetainInfo((info) => (info?.retainedBy.mainView ?? 0) > 0)
  const listed = useSessions((list) => list.byId)
  const candidates = created.filter((entry) => entry.source === sessionId && listed[entry.child]?.blank)
  const access = useSessionActionAccess(
    sessionAccessSource,
    candidates.map((entry) => entry.child),
    'session/follow',
  )
  const child = candidates.find((entry) => access.allows(entry.child))?.child
  const [failed, setFailed] = useState<string>()
  if (!main || child === undefined) return null
  return h(
    'div',
    { className: css.dock, 'data-acp-created-session': '' },
    h(
      'div',
      { className: `${css.surface} ${css.historySurface}` },
      h('span', { className: css.summaryText }, t('crossBackendTargetWithdrawn')),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          onClick: () => {
            try {
              coordinator.openCreated(sessionId, child, () => access.allows(child))
            } catch {
              setFailed(child)
            }
          },
        },
        t('unroutedHistoryOpen'),
      ),
      h(
        Button,
        { variant: 'ghost', size: 'sm', onClick: () => coordinator.dismissCreated(sessionId, child) },
        t('crossBackendDismiss'),
      ),
    ),
    failed === child ? h('p', { role: 'alert', className: css.error }, t('crossBackendFailureOpen')) : null,
  )
}
