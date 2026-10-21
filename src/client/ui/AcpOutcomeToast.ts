import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpUiFeedback, AcpUiOutcome } from '../data/feedback.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpOutcomeToast.module.css'

const copy: Record<AcpUiOutcome, AcpLocaleKey> = {
  saved: 'toastProfileSaved',
  'save-failed': 'toastProfileSaveFailed',
  deleted: 'toastProfileDeleted',
  'delete-failed': 'toastProfileDeleteFailed',
  'session-option-failed': 'actionSaveFailed',
  'tool-approval-failed': 'toolApprovalChangeFailed',
}

export function AcpOutcomeToast({
  feedback,
  t,
}: PropsLocale<'acpActivity'> & { readonly feedback: AcpUiFeedback }): ReactNode {
  const snapshot = useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getSnapshot)
  if (snapshot === null) return null
  const success = snapshot.outcome === 'saved' || snapshot.outcome === 'deleted'
  const message =
    snapshot.outcome === 'delegated-question-unavailable'
      ? snapshot.message
      : t(copy[snapshot.outcome], snapshot.outcome === 'session-option-failed' ? { reference: '' } : undefined)
  const source = snapshot.sourceSession
  const sourceLabel = source?.title ?? source?.id
  const sessionLabel =
    snapshot.outcome === 'delegated-question-unavailable' && source?.title != null && source.title !== source.id
      ? `${source.title} (${source.id})`
      : sourceLabel
  return h(Toast, {
    key: `acp-outcome-${snapshot.sequence}`,
    text:
      snapshot.sourceSession === undefined
        ? message
        : t('toastSessionOutcome', {
            message,
            session: sessionLabel!,
          }),
    ...(success
      ? { tone: 'success' as const }
      : {
          icon: h(IconWarningOutlineRegular, {
            className: snapshot.sourceSession === undefined ? undefined : css.sourceSessionToast,
          }),
        }),
    onDone: () => feedback.dismiss(snapshot.sequence),
  })
}
