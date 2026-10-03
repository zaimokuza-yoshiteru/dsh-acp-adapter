import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpUiFeedback, AcpUiOutcome } from '../data/feedback.ts'
import type { AcpLocaleKey } from './locales.ts'

const copy: Record<AcpUiOutcome, AcpLocaleKey> = {
  saved: 'toastProfileSaved',
  'save-failed': 'toastProfileSaveFailed',
  deleted: 'toastProfileDeleted',
  'delete-failed': 'toastProfileDeleteFailed',
}

export function AcpOutcomeToast({
  feedback,
  t,
}: PropsLocale<'acpActivity'> & { readonly feedback: AcpUiFeedback }): ReactNode {
  const snapshot = useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getSnapshot)
  if (snapshot === null) return null
  const success = snapshot.outcome === 'saved' || snapshot.outcome === 'deleted'
  return h(Toast, {
    key: `acp-outcome-${snapshot.sequence}`,
    text: t(copy[snapshot.outcome]),
    ...(success ? { tone: 'success' as const } : { icon: h(IconWarningOutlineRegular) }),
    onDone: () => feedback.dismiss(snapshot.sequence),
  })
}
