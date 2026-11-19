import { createElement as h, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import css from './AcpRecoveryDock.module.css'

type RetryProps = PropsLocale<'acpActivity'> & {
  readonly remote: Pick<AcpRemoteLike, 'retryModelSwitchInput'>
  readonly sessionId: string
  readonly failureSeq: number
  readonly running: boolean
}

function ResendButton({ t, remote, sessionId, failureSeq, running }: RetryProps): ReactNode {
  const submitted = useRef(false)
  const [status, setStatus] = useState<'idle' | 'submitting' | 'failed'>('idle')
  const retry = async (): Promise<void> => {
    if (submitted.current || running) return
    submitted.current = true
    setStatus('submitting')
    try {
      const result = await remote.retryModelSwitchInput(sessionId, failureSeq)
      if (result.ok) return // The Host retires this ticket when the retry is admitted.
    } catch {
      // A transport failure is retryable against the same Host-owned ticket.
    }
    submitted.current = false
    setStatus('failed')
  }
  return h(
    'div',
    { className: css.dock },
    h(
      Button,
      { variant: 'outline', size: 'sm', disabled: running || status === 'submitting', onClick: retry },
      t('resendUnsentMessage'),
    ),
    status === 'failed' ? h('p', { role: 'alert', className: css.error }, t('resendUnsentFailed')) : null,
  )
}

/** Resend the exact rejected input on demand without editing the current draft. */
export function UnsentModelSwitchInput({
  sessionId,
  useAccess,
  useProjection,
  useSession,
  remote,
  t,
}: PropsRuntime<'conversation.input.dock'> & PropsLocale<'acpActivity'> & Pick<RetryProps, 'remote'>): ReactNode {
  const failureSeq = useProjection('acpExecution', (view) => view?.unsentModelSwitch?.failureSeq)
  const maySend = useAccess('session/prompt')
  const mayRetry = useAccess('dshAcp/retryModelSwitchInput')
  const running = useSession((session) => session.running)
  if (failureSeq === undefined || !maySend || !mayRetry) return null
  return h(ResendButton, { key: `${sessionId}/${failureSeq}`, remote, t, sessionId, running, failureSeq })
}
