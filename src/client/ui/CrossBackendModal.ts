import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, DisclosureRow, IconInfoOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrossBackendPhase } from '../data/cross-backend-controller.ts'
import type { CrossBackendCoordinator } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './CrossBackendModal.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

export function CrossBackendModal({
  coordinator,
  t,
}: {
  coordinator: CrossBackendCoordinator
  t: Translate
}): ReactNode {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const snapshot = useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.getSnapshot(),
    () => coordinator.getSnapshot(),
  )
  const pending = snapshot.pending
  useEffect(() => {
    setDiagnosticsOpen(false)
  }, [pending?.ticket.key])
  if (pending === null) return null
  const source = pending.ticket.sourceSelection
  const target = pending.ticket.targetSelection
  const description =
    source === undefined
      ? t('crossBackendExistingHistory')
      : `${t('crossBackendFromTo', {
          source: `${source.provider} · ${source.model}`,
          target: `${target.provider} · ${target.model}`,
        })} ${t('crossBackendDescription')}`
  const phaseKey: Record<CrossBackendPhase, AcpLocaleKey> = {
    'restore-source': 'crossBackendFailureRestore',
    'create-destination': 'crossBackendFailureCreate',
    'select-destination': 'crossBackendFailureSelect',
    'open-destination': 'crossBackendFailureOpen',
    completed: 'crossBackendFailureUnknown',
  }
  const error =
    pending.failure !== null
      ? t(phaseKey[pending.failure.phase])
      : pending.blockingReason === 'no-location'
        ? t('crossBackendNoLocation')
        : null
  return h(
    Modal,
    {
      open: true,
      onClose: () => {
        void coordinator.cancel()
      },
      title: t('crossBackendTitle'),
      description,
      closeLabel: t('crossBackendCancel'),
      backdropBlur: false,
      ...(css.dialog === undefined ? {} : { className: css.dialog }),
      ...(css.content === undefined ? {} : { contentClassName: css.content }),
      footer: h(
        'div',
        { className: css.footer },
        h(
          Button,
          {
            variant: 'outline',
            disabled: pending.busy,
            onClick: () => {
              void coordinator.cancel()
            },
          },
          t('crossBackendCancel'),
        ),
        h(
          Button,
          {
            variant: 'primary',
            disabled: pending.busy || !pending.confirmable,
            onClick: () => {
              void coordinator.confirm()
            },
          },
          pending.busy ? t('crossBackendWorking') : t('crossBackendContinue'),
        ),
      ),
    },
    error === null
      ? h('p', { className: css.note }, t('crossBackendHistory'))
      : h(
          'div',
          null,
          h('p', { className: css.error, role: 'alert' }, error),
          pending.failure === null
            ? null
            : h(
                DisclosureRow,
                {
                  icon: h(IconInfoOutlineMedium),
                  title: t('crossBackendDiagnostics'),
                  open: diagnosticsOpen,
                  expandable: true,
                  onToggle: () => setDiagnosticsOpen((value) => !value),
                },
                h('pre', { className: css.diagnostic }, `${pending.failure.phase}\n${pending.failure.message}`),
              ),
        ),
  )
}
