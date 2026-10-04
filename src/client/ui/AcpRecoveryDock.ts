import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { Button, DisclosureRow, IconWarningTriangleOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpRecoveryView, AcpRemoteLike } from '../data/acp-remote.ts'
import { recoveringRecoveryStream } from '../data/recovery-stream.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpRecoveryDock.module.css'

type RecoveryDockProps = PropsRuntime<'conversation.input.dock'> &
  PropsLocale<'acpActivity'> & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly createNewSession: (sourceSessionId: string) => Promise<void>
    readonly ownsRoute: OwnsAcpRoute
  }

type Translate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type Selection = { readonly provider?: unknown } | null | undefined
type RecoveryAction = 'reconnect' | 'rebind' | 'new-session'
type RecoveryOperation = {
  readonly sessionId: string
  readonly action: RecoveryAction
  readonly token: symbol
}
type ButtonVariant = 'outline' | 'primary'

function providerOf(selection: Selection): string | undefined {
  return typeof selection?.provider === 'string' ? selection.provider : undefined
}

/** The stock modelSelection projection is deliberately read-only here. */
export function projectionIsAcp(value: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { readonly lastUsed?: Selection; readonly next?: Selection }
  return ownsRoute(providerOf(record.lastUsed)) || ownsRoute(providerOf(record.next))
}

export function recoveryText(t: Translate, recovery: AcpRecoveryView): string {
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

/** Temporary settlement is shown only while the durable recovery outcome is healthy. */
export function localSettlementText(t: Translate, recovery: AcpRecoveryView): string | null {
  if (recovery.kind !== 'healthy' || recovery.localStatus === undefined) return null
  const key: Record<NonNullable<AcpRecoveryView['localStatus']>, AcpLocaleKey> = {
    'finishing-tools': 'recoveryFinishingTools',
    'saving-results': 'recoverySavingResults',
    'storage-error': 'recoveryStorageError',
  }
  return t(key[recovery.localStatus])
}

function visibleRecovery(view: AcpRecoveryView): AcpRecoveryView | null {
  return view.kind === 'healthy' && view.localStatus === undefined ? null : view
}

/** Publish the recovery view returned by the completed action without a second snapshot read. */
export function publishRecoveryActionResult(
  result: AcpRecoveryView | void,
  isCurrent: () => boolean,
  publish: (snapshot: AcpRecoveryView) => void,
): boolean {
  if (result === undefined || !isCurrent()) return false
  publish(result)
  return true
}

function recoveryChoice(
  action: RecoveryAction,
  variant: ButtonVariant,
  label: string,
  explanation: string,
  busyLabel: string,
  busy: boolean,
  busyAction: RecoveryAction | null,
  run: () => void,
): ReactNode {
  return h(
    'div',
    { className: css.choice },
    h(
      'div',
      { className: css.choiceCopy },
      h('p', { className: css.choiceLabel }, label),
      h('p', { className: css.choiceExplanation }, explanation),
    ),
    h(Button, { variant, disabled: busy, onClick: run }, busyAction === action ? busyLabel : label),
  )
}

export function AcpRecoveryDock({
  sessionId,
  useSession,
  useProjection,
  t,
  remote,
  streamFactory,
  createNewSession,
  ownsRoute,
}: RecoveryDockProps): ReactNode {
  const lifecycleKey = useSession((snapshot) =>
    [snapshot.openState, snapshot.running, snapshot.promptAttempted, snapshot.lastAgentError ?? ''].join('|'),
  )
  const projection = useProjection('modelSelection')
  const projectionRecord =
    typeof projection === 'object' && projection !== null
      ? (projection as { readonly lastUsed?: Selection; readonly next?: Selection })
      : undefined
  // Model/reasoning updates within one provider do not discard the open recovery choice.
  const projectionProviderKey = `${providerOf(projectionRecord?.lastUsed) ?? ''}|${providerOf(projectionRecord?.next) ?? ''}`
  const [recovery, setRecovery] = useState<AcpRecoveryView | null>(null)
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<RecoveryAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [recoveryRefreshReady, setRecoveryRefreshReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const epoch = useRef(0)
  const inFlight = useRef<RecoveryOperation | null>(null)
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId

  useEffect(() => {
    const currentEpoch = ++epoch.current
    let cancelled = false
    setOpen(false)
    if (inFlight.current?.sessionId === sessionId) setBusyAction(inFlight.current.action)
    else setBusyAction(null)
    setActionError(null)
    setDiagnosticsOpen(false)
    setUnavailable(false)
    setReconnecting(false)
    setRecoveryRefreshReady(false)
    setRecovery(null)
    if (!projectionIsAcp(projection, ownsRoute))
      return () => {
        cancelled = true
      }
    const isCurrent = (): boolean => !cancelled && activeSession.current === sessionId && currentEpoch === epoch.current
    const stream = recoveringRecoveryStream(
      remote,
      streamFactory,
      sessionId,
      (snapshot) => {
        if (!isCurrent()) return
        setRecovery(visibleRecovery(snapshot))
      },
      (state, _error, refreshReady) => {
        if (!isCurrent()) return
        setReconnecting(state === 'reconnecting')
        setUnavailable(state === 'unavailable')
        setRecoveryRefreshReady(refreshReady === true)
        if (state !== 'connected') setRecovery(null)
      },
    )
    stream.start()
    return () => {
      cancelled = true
      ++epoch.current
      void stream.dispose()
    }
  }, [lifecycleKey, ownsRoute, projectionProviderKey, remote, sessionId, streamFactory, retry])

  if (!projectionIsAcp(projection, ownsRoute)) return null
  if (unavailable)
    return h(
      'div',
      { className: css.dock, role: 'status' },
      h(
        'div',
        { className: css.surface },
        h('span', { className: css.summaryIcon, 'aria-hidden': true }, h(IconWarningTriangleOutlineRegular)),
        h('span', { className: css.summaryText }, t('recoveryUnavailable')),
        h(
          Button,
          {
            variant: 'outline',
            disabled: !recoveryRefreshReady,
            onClick: () => setRetry((value) => value + 1),
          },
          t('activity.detailRetry'),
        ),
      ),
    )
  if (reconnecting)
    return h(
      'div',
      { className: css.dock, role: 'status' },
      h(
        'div',
        { className: css.surface },
        h('span', { className: css.summaryIcon, 'aria-hidden': true }, h(IconWarningTriangleOutlineRegular)),
        h('span', { className: css.summaryText }, t('recoveryReconnecting')),
      ),
    )
  if (recovery === null) return null

  const localStatus = localSettlementText(t, recovery)
  if (localStatus !== null) {
    return h(
      'div',
      { className: css.dock, role: 'status' },
      h('div', { className: `${css.surface} ${css.localStatus}` }, localStatus),
    )
  }

  const busy = busyAction !== null
  const run = async (actionName: RecoveryAction, action: () => Promise<AcpRecoveryView | void>): Promise<void> => {
    if (inFlight.current?.sessionId === sessionId || activeSession.current !== sessionId) return
    const operation: RecoveryOperation = { sessionId, action: actionName, token: Symbol(actionName) }
    const actionEpoch = epoch.current
    inFlight.current = operation
    setBusyAction(actionName)
    setActionError(null)
    try {
      const result = await action()
      publishRecoveryActionResult(
        result,
        () =>
          inFlight.current?.token === operation.token &&
          activeSession.current === sessionId &&
          actionEpoch === epoch.current,
        (snapshot) => {
          setUnavailable(false)
          setRecovery(visibleRecovery(snapshot))
        },
      )
    } catch (error) {
      if (inFlight.current?.token === operation.token && activeSession.current === sessionId)
        setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (inFlight.current?.token === operation.token) {
        inFlight.current = null
        if (activeSession.current === sessionId) setBusyAction(null)
      }
    }
  }

  const detail = [recovery.kind, recovery.cause, recovery.detail, actionError]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n\n')
  return h(
    'div',
    { className: css.dock, role: 'status' },
    h(
      'div',
      { className: css.surface },
      h('span', { className: css.summaryIcon, 'aria-hidden': true }, h(IconWarningTriangleOutlineRegular)),
      h('span', { className: css.summaryText }, recoveryText(t, recovery)),
      h(
        Button,
        {
          variant: 'outline',
          disabled: busy,
          onClick: () => {
            setDiagnosticsOpen(false)
            setOpen(true)
          },
        },
        t('recoveryDetails'),
      ),
    ),
    h(
      Modal,
      {
        open,
        onClose: () => {
          if (!busy && inFlight.current?.sessionId !== sessionId) {
            setOpen(false)
            setDiagnosticsOpen(false)
          }
        },
        title: t('recoveryTitle'),
        description: t('recoveryChoiceHelp'),
        closeLabel: t('recoveryClose'),
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
              disabled: busy,
              onClick: () => {
                if (inFlight.current?.sessionId === sessionId) return
                setOpen(false)
                setDiagnosticsOpen(false)
              },
            },
            t('recoveryClose'),
          ),
        ),
      },
      h('p', { className: css.reason }, recoveryText(t, recovery)),
      h('p', { className: css.preserved }, t('recoveryHistoryPreserved')),
      h(
        'div',
        { className: css.choices },
        recoveryChoice(
          'reconnect',
          'outline',
          t('recoveryReconnect'),
          t('recoveryReconnectExplanation'),
          t('recoveryBusy'),
          busy,
          busyAction,
          () => {
            void run('reconnect', async () => {
              const result = await remote.retryOriginal(sessionId)
              if (!result.ok) throw new Error(result.error.message)
              return result.value
            })
          },
        ),
        recoveryChoice(
          'rebind',
          'outline',
          t('recoveryRebind'),
          t('recoveryRebindExplanation'),
          t('recoveryBusy'),
          busy,
          busyAction,
          () => {
            void run('rebind', async () => {
              const result = await remote.rebindRecoveryBlank(sessionId)
              if (!result.ok) throw new Error(result.error.message)
              return result.value
            })
          },
        ),
        recoveryChoice(
          'new-session',
          'primary',
          t('recoveryNew'),
          t('recoveryNewExplanation'),
          t('recoveryBusy'),
          busy,
          busyAction,
          () => {
            void run('new-session', () => createNewSession(sessionId))
          },
        ),
      ),
      h(
        'div',
        { className: css.diagnostics },
        h(
          DisclosureRow,
          {
            icon: h(IconWarningTriangleOutlineRegular),
            title: t('recoveryDiagnostics'),
            open: diagnosticsOpen,
            expandable: detail !== '',
            onToggle: () => setDiagnosticsOpen((value) => !value),
          },
          detail === '' ? null : h('pre', { className: css.raw }, detail),
        ),
      ),
      actionError === null ? null : h('p', { className: css.error, role: 'alert' }, t('recoveryActionFailed')),
    ),
  )
}
