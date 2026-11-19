import { createElement as h, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentControlTranslate } from './agent-session-controls.ts'
import css from './AcpAgentControl.module.css'

/** Both supported locales use comma-grouped integers for token counts. */
const tokenCount = new Intl.NumberFormat('en')

type CapacityRisk = { readonly lastUsed: number; readonly targetSize: number }

export function managedModelCapacityText(risk: CapacityRisk, t: AgentControlTranslate): string {
  return t('managedModelWindowDetail', {
    used: tokenCount.format(risk.lastUsed),
    size: tokenCount.format(risk.targetSize),
  })
}

export function ManagedModelCapacityDialog({
  model,
  risk,
  t,
  cancel,
  confirm,
}: {
  model: string
  risk: CapacityRisk
  t: AgentControlTranslate
  cancel: () => void
  confirm: () => void
}): ReactNode {
  return h(Modal, {
    open: true,
    title: t('managedModelSmallWindow', { model }),
    description: managedModelCapacityText(risk, t),
    closeLabel: t('cancel'),
    onClose: cancel,
    backdropBlur: false,
    footer: h(
      'div',
      { className: css.confirmActions },
      h(Button, { variant: 'outline', onClick: cancel }, t('cancel')),
      h(Button, { variant: 'primary', onClick: confirm }, t('managedModelSwitchAnyway')),
    ),
  })
}
