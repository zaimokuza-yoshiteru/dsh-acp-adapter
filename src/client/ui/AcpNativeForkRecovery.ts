import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpNativeForkCoordinator } from '../coordinator/native-fork.ts'
import css from './CrossBackendModal.module.css'

/** Closing this recovery view never retries an uncertain creation. */
export function AcpNativeForkRecovery({
  coordinator,
  t,
}: PropsLocale<'acpActivity'> & { readonly coordinator: AcpNativeForkCoordinator }): ReactNode {
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot)
  if (state === null) return null
  const cleanup = state.kind === 'cleanup'
  const abandoned = state.kind === 'abandoned'
  return h(
    Modal,
    {
      open: true,
      onClose: coordinator.dismissRecovery,
      title: t(cleanup ? 'nativeForkCleanupTitle' : abandoned ? 'nativeForkAbandonedTitle' : 'nativeForkUnknownTitle'),
      description: t(
        cleanup
          ? 'nativeForkCleanupDescription'
          : abandoned
            ? 'nativeForkAbandonedDescription'
            : 'nativeForkUnknownDescription',
      ),
      closeLabel: t('recoveryClose'),
      backdropBlur: false,
      ...(css.dialog === undefined ? {} : { className: css.dialog }),
      ...(css.content === undefined ? {} : { contentClassName: css.content }),
      footer: h(
        'div',
        { className: css.footer },
        h(
          Button,
          { variant: cleanup ? 'outline' : 'primary', onClick: coordinator.dismissRecovery },
          t('recoveryClose'),
        ),
        h(
          Button,
          {
            variant: cleanup ? 'primary' : 'outline',
            onClick: () => {
              if (cleanup) coordinator.retryCleanup(state)
              else if (abandoned) void coordinator.restart(state)
              else coordinator.abandon(state)
            },
          },
          t(cleanup ? 'nativeForkRetryCleanup' : abandoned ? 'nativeForkConfirmNew' : 'nativeForkConfirmAbandon'),
        ),
      ),
    },
    state.storageFailed === true
      ? h('p', { className: css.error, role: 'alert' }, t('nativeForkRecoveryStorageFailed'))
      : null,
  )
}
