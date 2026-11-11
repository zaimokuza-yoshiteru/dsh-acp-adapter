import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, DisclosureRow, IconInfoOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrossBackendPhase } from '../data/cross-backend-controller.ts'
import type { CrossBackendModelSelection } from '../data/cross-backend-controller.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { isAcpCurrentConfigModel } from '../../contract/model-selection.ts'
import type { CrossBackendCoordinator } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './CrossBackendModal.module.css'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

export function crossBackendSelectionLabel(
  selection: CrossBackendModelSelection,
  catalog: ModelCatalog | null,
  profileName: string | undefined,
  t: Translate,
): string {
  const group = catalog?.groups.find((candidate) => candidate.id === selection.provider)
  const provider = profileName ?? group?.name ?? t('crossBackendAgent')
  const model = isAcpCurrentConfigModel(selection.model)
    ? t('agentCurrentConfiguration')
    : (group?.models.find((candidate) => candidate.id === selection.model)?.name ?? selection.model)
  return `${provider} · ${model}`
}

export function CrossBackendModal({
  coordinator,
  loadModelCatalog,
  profileName,
  t,
}: {
  coordinator: CrossBackendCoordinator
  loadModelCatalog: () => Promise<ModelCatalog | null>
  profileName: (provider: string) => string | undefined
  t: Translate
}): ReactNode {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const snapshot = useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.getSnapshot(),
    () => coordinator.getSnapshot(),
  )
  const pending = snapshot.pending
  useEffect(() => {
    setDiagnosticsOpen(false)
  }, [pending?.ticket.key])
  useEffect(() => {
    if (pending === null) return
    let active = true
    void loadModelCatalog()
      .then((value) => {
        if (active) setCatalog(value)
      })
      .catch(() => {
        if (active) setCatalog(null)
      })
    return () => {
      active = false
    }
  }, [loadModelCatalog, pending?.ticket.key])
  if (pending === null) return null
  const source = pending.ticket.sourceSelection
  const target = pending.ticket.targetSelection
  const modelSwitch = pending.reason === 'model-switch'
  const description = modelSwitch
    ? t('crossBackendModelSwitchDescription', {
        target: crossBackendSelectionLabel(target, catalog, profileName(target.provider), t),
      })
    : source === undefined
      ? t('crossBackendExistingHistory')
      : `${t('crossBackendFromTo', {
          source: crossBackendSelectionLabel(source, catalog, profileName(source.provider), t),
          target: crossBackendSelectionLabel(target, catalog, profileName(target.provider), t),
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
      title: t(modelSwitch ? 'crossBackendModelSwitchTitle' : 'crossBackendTitle'),
      description,
      closeLabel: t(modelSwitch ? 'crossBackendKeepModel' : 'crossBackendCancel'),
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
          t(modelSwitch ? 'crossBackendKeepModel' : 'crossBackendCancel'),
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
          pending.busy
            ? t('crossBackendWorking')
            : t(modelSwitch ? 'crossBackendNewModelSession' : 'crossBackendContinue'),
        ),
      ),
    },
    error === null
      ? null
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
