import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpRecoveryView, AcpRemoteLike } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpRecoveryDock.module.css'

type RecoveryDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'acpActivity'> & {
  readonly remote: AcpRemoteLike
  readonly createNewSession: (sourceSessionId: string) => Promise<void>
  readonly ownsRoute: OwnsAcpRoute
}

type Translate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type Selection = { readonly provider?: unknown } | null | undefined

function providerOf(selection: Selection): string | undefined {
  return typeof selection?.provider === 'string' ? selection.provider : undefined
}

/** The stock modelSelection projection is deliberately read-only here. */
export function projectionIsAcp(value: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { readonly lastUsed?: Selection; readonly next?: Selection }
  return ownsRoute(providerOf(record.lastUsed)) || ownsRoute(providerOf(record.next))
}

function recoveryText(t: Translate, recovery: AcpRecoveryView): string {
  const key: Record<AcpRecoveryView['kind'], AcpLocaleKey> = {
    healthy: 'recoveryGeneric',
    'reconnect-required': 'recoveryReconnectRequired',
    'outcome-unknown': 'recoveryOutcomeUnknown',
    'reconciliation-required': 'recoveryHistoryMismatch',
    'session-lost': 'recoverySessionLost',
    'local-history-damaged': 'recoveryHistoryDamaged',
    'resumed-unverified': 'recoveryReconnectRequired',
  }
  return t(key[recovery.kind])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AcpRecoveryDock({ sessionId, useSession, useProjection, t, remote, createNewSession, ownsRoute }: RecoveryDockProps): ReactNode {
  const lifecycleKey = useSession((snapshot) => [snapshot.openState, snapshot.running, snapshot.promptAttempted, snapshot.lastAgentError ?? ''].join('|'))
  const projection = useProjection('modelSelection')
  const [recovery, setRecovery] = useState<AcpRecoveryView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setOpen(false)
    setError(null)
    setRecovery(null)
    if (!projectionIsAcp(projection, ownsRoute) || remote.recoverySnapshot === undefined) return () => { cancelled = true }
    void remote.recoverySnapshot(sessionId).then((result) => {
      if (!cancelled && result.ok) setRecovery(result.value.kind === 'healthy' ? null : result.value)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(errorText(reason))
    })
    return () => { cancelled = true }
  }, [lifecycleKey, ownsRoute, projection, remote, sessionId])

  if (recovery === null || !projectionIsAcp(projection, ownsRoute)) return null

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      const result = remote.recoverySnapshot === undefined ? undefined : await remote.recoverySnapshot(sessionId)
      if (result?.ok === true) setRecovery(result.value.kind === 'healthy' ? null : result.value)
    } catch (reason: unknown) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const detail = recovery.detail ?? recovery.cause ?? ''
  return h('div', { className: css.dock, role: 'status' },
    h('div', { className: css.summary },
      h('span', { className: css.summaryText }, recoveryText(t, recovery)),
      h(Button, { variant: 'outline', disabled: busy, onClick: () => { setOpen(true) } }, t('recoveryDetails')),
    ),
    h(Modal, {
      open,
      onClose: () => { if (!busy) setOpen(false) },
      title: t('recoveryTitle'),
      description: t('recoveryChoiceHelp'),
      closeLabel: t('recoveryClose'),
      ...(css.details === undefined ? {} : { contentClassName: css.details }),
      footer: h('div', { className: css.actions },
        h(Button, { variant: 'outline', disabled: busy, onClick: () => { void run(async () => {
          if (remote.retryOriginal === undefined) throw new Error('Recovery retry is unavailable on this host')
          const result = await remote.retryOriginal(sessionId)
          if (!result.ok) throw new Error(result.error.message)
        }) } }, busy ? t('recoveryBusy') : t('recoveryReconnect')),
        h(Button, { variant: 'outline', disabled: busy, onClick: () => { void run(async () => {
          if (remote.rebindRecoveryBlank === undefined) throw new Error('Recovery blank rebind is unavailable on this host')
          const result = await remote.rebindRecoveryBlank(sessionId)
          if (!result.ok) throw new Error(result.error.message)
        }) } }, t('recoveryRebind')),
        h(Button, { variant: 'primary', disabled: busy, onClick: () => { void run(() => createNewSession(sessionId)) } }, t('recoveryNew')),
      ),
    },
      h('p', null, recoveryText(t, recovery)),
      h('p', null, t('recoveryHistoryPreserved')),
      h('p', null, `${t('recoveryIssueCode')}: ${recovery.kind}`),
      detail === '' ? null : h('pre', { className: css.raw }, detail),
      error === null ? null : h('p', { className: css.error, role: 'alert' }, error),
    ),
  )
}
