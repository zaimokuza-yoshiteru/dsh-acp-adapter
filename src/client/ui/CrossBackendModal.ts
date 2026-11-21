import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Button, DisclosureRow, IconInfoOutlineMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrossBackendPhase } from '../data/cross-backend-controller.ts'
import type { CrossBackendModelSelection } from '../data/cross-backend-controller.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { isAcpAgentManagedModel, isAcpCurrentConfigModel } from '../../contract/model-selection.ts'
import type { CrossBackendCoordinator } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import { useSessionActionAccess, type SessionAccessSource } from './session-action-access.ts'
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
    : isAcpAgentManagedModel(selection.model)
      ? t('agentManagedModel')
      : (group?.models.find((candidate) => candidate.id === selection.model)?.name ?? selection.model)
  return `${provider} · ${model}`
}

function HandoffButton({
  sessionId,
  accessSource,
  hint,
  label,
  disabled,
  begin,
}: {
  sessionId: string
  accessSource: SessionAccessSource
  hint: string
  label: string
  disabled: boolean
  begin(): void
}): ReactNode {
  const access = useSessionActionAccess(accessSource, [sessionId], 'dshAcp/handoff')
  if (!access.allows(sessionId)) return null
  return h(Tooltip, {
    side: 'top',
    portal: true,
    label: hint,
    children: h<HTMLAttributes<HTMLSpanElement>>(
      'span',
      {},
      h(
        Button,
        {
          variant: 'outline',
          disabled,
          'aria-description': hint,
          onClick: () => {
            if (access.allows(sessionId)) begin()
          },
        },
        label,
      ),
    ),
  })
}

export function CrossBackendModal({
  coordinator,
  loadModelCatalog,
  profileName,
  sessionAccessSource,
  language,
  t,
}: {
  coordinator: CrossBackendCoordinator
  language: () => 'zh' | 'en'
  sessionAccessSource: SessionAccessSource
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
  const canHandoff = pending.canHandoff === true && pending.failure === null
  const targetName = crossBackendSelectionLabel(target, catalog, profileName(target.provider), t)
  const description = modelSwitch
    ? t('crossBackendModelSwitchDescription', {
        target: targetName,
      })
    : pending.ticket.sourceUnavailable
      ? t('crossBackendSourceUnavailable')
      : source === undefined
        ? t('crossBackendExistingHistory')
        : `${t('crossBackendFromTo', {
            source: crossBackendSelectionLabel(source, catalog, profileName(source.provider), t),
            target: targetName,
          })} ${t(canHandoff ? 'handoffSwitchDescription' : 'crossBackendDescription')}`
  const phaseKey: Record<CrossBackendPhase, AcpLocaleKey> = {
    'create-unknown': 'independentCreationUnknown',
    'preset-unavailable': 'independentPresetUnavailable',
    'restore-source': 'crossBackendFailureRestore',
    'create-destination': 'crossBackendFailureCreate',
    'ungrouped-destination': 'unroutedHistoryUngrouped',
    'select-destination': 'crossBackendFailureSelect',
    'open-destination': 'crossBackendFailureOpen',
  }
  const hasDestination =
    pending.failure?.phase === 'ungrouped-destination' ||
    pending.failure?.phase === 'select-destination' ||
    pending.failure?.phase === 'open-destination'
  const error =
    pending.failure !== null
      ? t(phaseKey[pending.failure.phase])
      : pending.blockingReason === 'no-location'
        ? t('crossBackendNoLocation')
        : pending.handoffError
          ? t(pending.handoffError)
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
        ...(canHandoff
          ? [
              h(HandoffButton, {
                key: 'handoff',
                sessionId: pending.ticket.sourceSessionId,
                accessSource: sessionAccessSource,
                label: t('handoffStart'),
                hint: t('handoffHint', { target: targetName }),
                disabled: pending.busy || !pending.confirmable,
                begin: () => {
                  void coordinator.beginHandoff(pending.ticket.key, language())
                },
              }),
            ]
          : []),
        h(
          Button,
          {
            variant: 'primary',
            disabled: pending.busy || !pending.confirmable,
            onClick: () => {
              void coordinator.confirm(pending.ticket.key, pending.failure?.phase === 'preset-unavailable')
            },
          },
          pending.busy
            ? t('crossBackendWorking')
            : t(
                pending.failure?.phase === 'create-unknown'
                  ? 'independentCheckCreated'
                  : pending.failure?.phase === 'preset-unavailable'
                    ? 'independentUseDefault'
                    : hasDestination
                      ? 'unroutedHistoryOpen'
                      : modelSwitch
                        ? 'crossBackendNewModelSession'
                        : canHandoff
                          ? 'handoffBlank'
                          : 'crossBackendContinue',
              ),
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
