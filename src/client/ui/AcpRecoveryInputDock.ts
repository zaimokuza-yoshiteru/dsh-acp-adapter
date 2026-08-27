/** Independent ACP recovery surface.  It lives in the public input dock so
 * recovery is not hidden inside the model picker and remains visible after a
 * refresh when only durable state is available. */
import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpRecoveryInputDock.module.css'

export interface AcpRecoveryInputDockProps {
  session?: { sessionId?: string | undefined } | undefined
  sessionId?: string | undefined
  remote?: AcpRemoteLike | undefined
  /** Host picker supplies the normal DSH session creation flow. */
  newSession?: ((sessionId: string) => Promise<void>) | undefined
  t?: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined
}

export interface RecoverySnapshot {
  readonly recovery: {
    readonly kind: string
    readonly cause: string | null
    readonly detail: string | null
    readonly acpSessionId: string | null
    readonly generation: number | null
  }
  readonly modelSwitch: { readonly status: string; readonly operationId?: string; readonly previousModel?: string; readonly targetModel?: string }
}

export interface RecoveryActionAvailability {
  readonly reconnect: boolean
  readonly rebind: boolean
  readonly rollback: boolean
  readonly newSession: boolean
}

export function recoveryDockVisible(snapshot: RecoverySnapshot): boolean {
  return snapshot.recovery.kind !== 'healthy' || snapshot.modelSwitch.status !== 'idle'
}

/** A healthy session cannot be reconnected; pending model-switch recovery only
 * exposes the actions that can actually resolve or abandon that transaction. */
export function recoveryActionAvailability(
  snapshot: RecoverySnapshot,
  capabilities: { readonly reconnect: boolean; readonly newSession: boolean },
): RecoveryActionAvailability {
  const recoveryRequired = snapshot.recovery.kind !== 'healthy'
  return {
    reconnect: recoveryRequired && capabilities.reconnect,
    rebind: recoveryRequired || snapshot.modelSwitch.status !== 'idle',
    rollback: snapshot.modelSwitch.status !== 'idle' && snapshot.modelSwitch.operationId !== undefined,
    newSession: capabilities.newSession && (recoveryRequired || snapshot.modelSwitch.status !== 'idle'),
  }
}

function sessionOf(props: AcpRecoveryInputDockProps): string | undefined {
  return props.sessionId ?? props.session?.sessionId
}

function textOf(t: AcpRecoveryInputDockProps['t'], key: AcpLocaleKey, fallback: string, params?: Record<string, string | number>): string {
  const value = t?.(key, params)
  return value === undefined || value.trim() === '' ? fallback : value
}

function summary(snapshot: RecoverySnapshot, t: AcpRecoveryInputDockProps['t']): string {
  switch (snapshot.recovery.kind) {
    case 'outcome-unknown': return textOf(t, 'recoveryOutcomeUnknown', 'The previous Agent outcome is unknown. Reconnect or explicitly abandon the context before continuing.')
    case 'reconnect-required': return textOf(t, 'recoveryReconnectRequired', 'The Agent session needs to be reconnected.')
    case 'session-lost': return textOf(t, 'recoverySessionLost', 'The original Agent session is unavailable.')
    case 'local-history-damaged': return textOf(t, 'recoveryHistoryDamaged', 'Local ACP recovery data is damaged; execution is blocked.')
    default: return snapshot.recovery.detail ?? textOf(t, 'recoveryGeneric', 'The ACP session requires recovery.')
  }
}

export function AcpRecoveryInputDock(props: AcpRecoveryInputDockProps): ReactNode {
  const sessionId = sessionOf(props)
  const remote = props.remote
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    setSnapshot(null)
    setBusy(null)
    setError(null)
    setDetailsOpen(false)
    if (sessionId === undefined || remote === undefined) return
    const refresh = (): void => {
      void remote.options(sessionId).then((result) => {
        if (!disposed && result.ok) setSnapshot(result.value)
      }).catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [sessionId, remote])

  if (sessionId === undefined || remote === undefined || snapshot === null || !recoveryDockVisible(snapshot)) return null

  const run = (action: string, operation: (() => Promise<unknown>) | undefined): void => {
    if (operation === undefined) return
    setError(null)
    setBusy(action)
    void operation().then((result: unknown) => {
      if (typeof result === 'object' && result !== null && 'ok' in result && (result as { ok?: boolean }).ok === false) {
        const message = String((result as { error?: { message?: string } }).error?.message ?? '')
        setError(textOf(props.t, 'recoveryError', 'Recovery action failed: {message}', { message }))
      } else if (typeof result === 'object' && result !== null && 'ok' in result && (result as { ok?: boolean; value?: RecoverySnapshot }).ok === true && (result as { value?: RecoverySnapshot }).value !== undefined) {
        setSnapshot((result as unknown as { value: RecoverySnapshot }).value)
      } else if (action === 'new') {
        setSnapshot(null)
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(null))
  }

  const switchView = snapshot.modelSwitch
  const switchPending = switchView.status !== 'idle'
  const actions = recoveryActionAvailability(snapshot, {
    reconnect: remote.reconnectOriginal !== undefined,
    newSession: props.newSession !== undefined,
  })
  const title = textOf(props.t, 'recoveryTitle', 'ACP session recovery required')
  const message = switchPending && snapshot.recovery.kind === 'healthy'
      ? textOf(props.t, 'recoveryModelSwitch', 'The model switch needs to be resolved', { previous: switchView.previousModel === undefined ? '' : ` (${switchView.previousModel})` })
      : summary(snapshot, props.t)
  const actionButtons = h('div', { className: css.actions },
      actions.reconnect
        ? h(Button, { type: 'button', variant: 'primary', disabled: busy !== null, onClick: () => run('reconnect', () => remote.reconnectOriginal!(sessionId)) }, busy === 'reconnect' ? textOf(props.t, 'recoveryBusy', 'Working…') : textOf(props.t, 'recoveryReconnect', 'Reconnect original Agent session'))
        : null,
      actions.rebind
        ? h(Button, { type: 'button', variant: 'outline', disabled: busy !== null, onClick: () => run('rebind', () => remote.rebindBlank(sessionId)) }, busy === 'rebind' ? textOf(props.t, 'recoveryBusy', 'Working…') : textOf(props.t, 'recoveryRebind', 'Abandon context and continue'))
        : null,
      actions.rollback && switchPending && switchView.operationId !== undefined && remote.rollbackModelSwitch !== undefined
        ? h(Button, { type: 'button', variant: 'outline', disabled: busy !== null, onClick: () => run('rollback', () => remote.rollbackModelSwitch!(sessionId, { operationId: switchView.operationId! })) }, busy === 'rollback' ? textOf(props.t, 'recoveryBusy', 'Working…') : textOf(props.t, 'recoveryRollback', 'Roll back model switch'))
        : null,
      actions.newSession
        ? h(Button, { type: 'button', variant: 'ghost', disabled: busy !== null, onClick: () => run('new', () => props.newSession!(sessionId)) }, busy === 'new' ? textOf(props.t, 'recoveryBusy', 'Working…') : textOf(props.t, 'recoveryNew', 'New session'))
        : null,
    )
  return h('div', { className: css.root, role: 'region', 'aria-label': title },
    h('div', { className: css.banner },
      h('span', { className: css.summary }, message),
      h(Button, { type: 'button', variant: 'outline', disabled: busy !== null, onClick: () => setDetailsOpen(true) }, textOf(props.t, 'recoveryDetails', 'View recovery details')),
    ),
    error === null ? null : h('div', { className: css.error, role: 'alert' }, error),
    h(Modal, {
      open: detailsOpen,
      onClose: () => setDetailsOpen(false),
      title,
      description: message,
      closeLabel: textOf(props.t, 'recoveryClose', 'Close'),
      contentClassName: css.modalContent ?? '',
      footer: actionButtons,
    },
      h('dl', { className: css.diagnostics },
        h('dt', null, 'State'), h('dd', null, snapshot.recovery.kind),
        h('dt', null, 'Agent session'), h('dd', null, snapshot.recovery.acpSessionId ?? '—'),
        snapshot.recovery.detail === null ? null : h('dt', null, 'Details'),
        snapshot.recovery.detail === null ? null : h('dd', null, snapshot.recovery.detail),
      ),
    ),
  )
}

export function createAcpRecoveryInputDock(remote: AcpRemoteLike, newSession?: (sessionId: string) => Promise<void>): (props: AcpRecoveryInputDockProps) => ReactNode {
  return (props) => h(AcpRecoveryInputDock, { ...props, remote, newSession })
}
