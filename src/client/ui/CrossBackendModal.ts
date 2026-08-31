import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrossBackendCoordinator } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './CrossBackendModal.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

export function CrossBackendModal({ coordinator, t }: { coordinator: CrossBackendCoordinator; t: Translate }): ReactNode {
  const snapshot = useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.getSnapshot(),
    () => coordinator.getSnapshot(),
  )
  const pending = snapshot.pending
  if (pending === null) return null
  const source = pending.ticket.sourceSelection
  const target = pending.ticket.targetSelection
  const description = source === undefined
    ? t('crossBackendExistingHistory')
    : t('crossBackendFromTo', {
      source: `${source.provider} · ${source.model}`,
      target: `${target.provider} · ${target.model}`,
    })
  const error = pending.blockingReason === 'no-location'
    ? t('crossBackendNoLocation')
    : pending.error
  return h(Modal, {
    open: true,
    onClose: () => { void coordinator.cancel() },
    title: t('crossBackendTitle'),
    description: `${description} ${t('crossBackendDescription')}`,
    closeLabel: t('crossBackendCancel'),
    ...(css.dialog === undefined ? {} : { className: css.dialog }),
    ...(css.content === undefined ? {} : { contentClassName: css.content }),
    footer: h('div', { className: css.footer },
      h(Button, {
        variant: 'outline',
        disabled: pending.busy,
        onClick: () => { void coordinator.cancel() },
      }, t('crossBackendCancel')),
      h(Button, {
        variant: 'primary',
        disabled: pending.busy || !pending.confirmable,
        onClick: () => { void coordinator.confirm() },
      }, pending.busy ? t('crossBackendWorking') : t('crossBackendContinue')),
    ),
  }, error === null
    ? h('p', { className: css.note }, t('crossBackendHistory'))
    : h('p', { className: css.error, role: 'alert' }, error))
}
