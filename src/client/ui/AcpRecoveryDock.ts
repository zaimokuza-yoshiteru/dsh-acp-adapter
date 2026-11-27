import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import {
  Button,
  DisclosureRow,
  focusWithoutRing,
  IconWarningTriangleOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpRecoveryView, AcpRemoteLike } from '../data/acp-remote.ts'
import { recoveringRecoveryStream } from '../data/recovery-stream.ts'
import { includesRoute, type UseRouteOwnership } from '../data/managed-routes.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpRecoveryDock.module.css'
import type { SessionAccessSource } from './session-action-access.ts'
import type { independentSessionNavigation } from '../coordinator/native-session-navigation.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { resolveCrossBackendLocation } from '../data/cross-backend-controller.ts'
import { acpModelSelection, isAcpAgentManagedModel } from '../../contract/model-selection.ts'
import { ManagedModelRecovery } from './ManagedModelRecovery.ts'

type RecoveryDockProps = PropsRuntime<'conversation.input.dock'> &
  PropsLocale<'acpActivity'> & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly createNewSession: ReturnType<typeof independentSessionNavigation>
    readonly useRouteOwnership: UseRouteOwnership
    readonly sessionAccessSource: SessionAccessSource
  }

type Translate = (key: AcpLocaleKey, params?: Record<string, unknown>) => string
type Selection = { readonly provider?: unknown } | null | undefined
type RecoveryAction = 'reconnect' | 'rebind'
type RecoveryOperation = {
  readonly sessionId: string
  readonly action: RecoveryAction
  readonly token: symbol
}

function providerOf(selection: Selection): string | undefined {
  return typeof selection?.provider === 'string' ? selection.provider : undefined
}

/** The stock modelSelection projection is deliberately read-only here. */
export function projectionIsAcp(value: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { readonly lastUsed?: Selection; readonly next?: Selection }
  return ownsRoute(providerOf(record.lastUsed)) || ownsRoute(providerOf(record.next))
}

function reconnectsOnNextMessage(recovery: AcpRecoveryView): boolean {
  return recovery.kind === 'outcome-unknown' && recovery.cause === 'transport-disconnected'
}

export function recoveryText(t: Translate, recovery: AcpRecoveryView): string {
  if (reconnectsOnNextMessage(recovery)) return t('recoveryContinueOnSend')
  if (recovery.kind === 'reconciliation-required' && recovery.cause === 'capability-missing')
    return t('recoveryUnsupported')
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

export function AcpRecoveryDock({
  sessionId,
  useSession,
  useProjection,
  useAccess,
  useSessions,
  useWorkspaces,
  useRemoteAccess,
  useWorkspaceAccess,
  t,
  remote,
  streamFactory,
  createNewSession,
  useRouteOwnership,
  sessionAccessSource,
}: RecoveryDockProps): ReactNode {
  const reconnectAllowed = useAccess('dshAcp/retryOriginal')
  const rebindAllowed = useAccess('dshAcp/rebindRecoveryBlank')
  const modelWritable = useAccess('dshAcp/setAgentSessionOption')
  const modelSelectable = useAccess('session/selectModel')
  const running = useSession((state) => state.running)
  const workspaces = useWorkspaces((snapshot) => snapshot.items)
  const cwd = useSessions((snapshot) => snapshot.byId[sessionId]?.cwd)
  const destination = resolveCrossBackendLocation(sessionId, workspaces, cwd)
  const globalCreateAllowed = useRemoteAccess('session/create')
  const workspaceCreateAllowed = useWorkspaceAccess((destination?.workspaceId ?? '') as WorkspaceId, 'session/create')
  const createAllowed =
    destination !== undefined && (destination.workspaceId === undefined ? globalCreateAllowed : workspaceCreateAllowed)
  const lifecycleKey = useSession((snapshot) =>
    [snapshot.openState, snapshot.running, snapshot.promptAttempted, snapshot.lastAgentError ?? ''].join('|'),
  )
  const projection = useProjection('modelSelection')
  const ownership = useRouteOwnership((routes) => {
    if (projectionIsAcp(projection, (id) => includesRoute(routes.providers, id))) return 'active'
    if (projectionIsAcp(projection, (id) => includesRoute(routes.historicalProviders, id))) return 'historical'
    return null
  })
  const projectionRecord =
    typeof projection === 'object' && projection !== null
      ? (projection as { readonly lastUsed?: Selection; readonly next?: Selection })
      : undefined
  // Model/reasoning updates within one provider do not discard the open recovery choice.
  const projectionProviderKey = `${providerOf(projectionRecord?.lastUsed) ?? ''}|${providerOf(projectionRecord?.next) ?? ''}`
  const [recovery, setRecovery] = useState<AcpRecoveryView | null>(null)
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<RecoveryAction | null>(null)
  const [actionError, setActionError] = useState<{ action: RecoveryAction; detail: string } | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [recoveryRefreshReady, setRecoveryRefreshReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const [confirmRebind, setConfirmRebind] = useState(false)
  const epoch = useRef(0)
  const inFlight = useRef<RecoveryOperation | null>(null)
  const activeSession = useRef(sessionId)
  activeSession.current = sessionId

  const previousStep = useRef({ sessionId, confirmRebind })
  const cancelResetButton = useRef<HTMLButtonElement>(null)
  const resetButton = useRef<HTMLButtonElement>(null)
  // Keep one native modal layer for both steps, and move focus to the safe control in the new step.
  useLayoutEffect(() => {
    const previous = previousStep.current
    previousStep.current = { sessionId, confirmRebind }
    if (!open || previous.sessionId !== sessionId || previous.confirmRebind === confirmRebind) return
    const target = confirmRebind ? cancelResetButton.current : resetButton.current
    if (target?.isConnected && !target.disabled) focusWithoutRing(target, { preventScroll: true })
  }, [sessionId, open, confirmRebind])

  useEffect(() => {
    const currentEpoch = ++epoch.current
    let cancelled = false
    setOpen(false)
    setConfirmRebind(false)
    if (inFlight.current?.sessionId === sessionId) setBusyAction(inFlight.current.action)
    else setBusyAction(null)
    setActionError(null)
    setDiagnosticsOpen(false)
    setUnavailable(false)
    setReconnecting(false)
    setRecoveryRefreshReady(false)
    setRecovery(null)
    if (ownership === null)
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
        if (snapshot.kind === 'healthy') {
          setOpen(false)
          setConfirmRebind(false)
        }
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
  }, [lifecycleKey, ownership, projectionProviderKey, remote, sessionId, streamFactory, retry])

  // A retired name can belong to another plugin now. Only the session's
  // own recovery record warrants a surface there; a carrier error is no proof.
  if (
    ownership === null ||
    (recovery !== null && recovery.dshSessionId !== sessionId) ||
    (ownership === 'historical' && (unavailable || reconnecting))
  )
    return null
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
  if (recovery === null) {
    const route = projection?.lastUsed
    const next = projection?.next
    const selection =
      route && next && route.provider === next.provider && route.model !== next.model
        ? acpModelSelection(next.model)
        : undefined
    const target = selection?.kind === 'declared-model' ? selection.value : undefined
    return ownership === 'active' && route && (target !== undefined || isAcpAgentManagedModel(route.model))
      ? h(ManagedModelRecovery, {
          key: sessionId,
          target,
          sessionId,
          remote,
          streamFactory,
          t,
          running,
          writable: modelWritable && modelSelectable,
          mayCreate: createAllowed,
          createNewSession,
          sessionAccessSource,
        })
      : null
  }

  const notice = reconnectsOnNextMessage(recovery) ? t('recoveryContinueOnSend') : localSettlementText(t, recovery)
  if (notice !== null) {
    return h(
      'div',
      { className: css.dock, role: 'status' },
      h('div', { className: `${css.surface} ${css.localStatus}` }, notice),
    )
  }

  const busy = busyAction !== null
  const run = async (actionName: RecoveryAction): Promise<void> => {
    if (inFlight.current?.sessionId === sessionId || activeSession.current !== sessionId) return
    const endpoint = actionName === 'reconnect' ? 'dshAcp/retryOriginal' : 'dshAcp/rebindRecoveryBlank'
    if (sessionAccessSource(sessionId, endpoint)?.getSnapshot() !== true) return
    const operation: RecoveryOperation = { sessionId, action: actionName, token: Symbol(actionName) }
    const actionEpoch = epoch.current
    inFlight.current = operation
    setBusyAction(actionName)
    setActionError(null)
    const isCurrent = () =>
      inFlight.current?.token === operation.token &&
      activeSession.current === sessionId &&
      actionEpoch === epoch.current
    try {
      const result = await (actionName === 'reconnect'
        ? remote.retryOriginal(sessionId)
        : remote.rebindRecoveryBlank(sessionId))
      if (!result.ok) throw new Error(result.error.message)
      publishRecoveryActionResult(result.value, isCurrent, (snapshot) => {
        setUnavailable(false)
        setRecovery(visibleRecovery(snapshot))
        if (snapshot.kind === 'healthy') setOpen(false)
      })
    } catch (error) {
      if (isCurrent())
        setActionError({ action: actionName, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      if (inFlight.current?.token === operation.token) {
        inFlight.current = null
        if (activeSession.current === sessionId) setBusyAction(null)
      }
    }
  }

  const detail = [recovery.kind, recovery.cause, recovery.detail, actionError?.detail]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n\n')
  const suggestReconnect =
    recovery.kind === 'reconnect-required' ||
    recovery.kind === 'resumed-unverified' ||
    (recovery.kind === 'session-lost' && recovery.cause === 'id-not-found')
  const reconnectButton = h(
    Button,
    {
      variant: suggestReconnect ? 'primary' : 'outline',
      disabled: busy || !reconnectAllowed,
      ...(suggestReconnect && reconnectAllowed && !busy ? { 'data-modal-autofocus': '' } : {}),
      onClick: () => run('reconnect'),
    },
    t(busyAction === 'reconnect' ? 'recoveryBusy' : 'recoveryReconnect'),
  )
  const reason = recoveryText(t, recovery)
  const actionFailure =
    actionError === null
      ? null
      : t(actionError.action === 'reconnect' ? 'recoveryReconnectFailed' : 'recoveryActionFailed')
  return h(
    'div',
    { key: sessionId, className: css.dock, role: 'status' },
    h(
      'div',
      { className: css.surface },
      h('span', { className: css.summaryIcon, 'aria-hidden': true }, h(IconWarningTriangleOutlineRegular)),
      actionFailure !== null && !open
        ? h('span', { className: `${css.summaryText} ${css.error}`, role: 'alert' }, actionFailure)
        : h('span', { className: css.summaryText }, reason),
      h(
        'div',
        { className: css.dockActions },
        suggestReconnect ? reconnectButton : null,
        h(
          Button,
          {
            variant: suggestReconnect ? 'ghost' : 'outline',
            onClick: () => {
              setDiagnosticsOpen(false)
              setOpen(true)
            },
          },
          t('recoveryDetails'),
        ),
      ),
    ),
    confirmRebind
      ? h(Modal, {
          open,
          title: t('recoveryRebindConfirmTitle'),
          description: t('recoveryRebindConfirmDescription'),
          closeLabel: t('recoveryRebindCancel'),
          onClose: () => {
            if (!busy && inFlight.current?.sessionId !== sessionId) setConfirmRebind(false)
          },
          backdropBlur: false,
          ...(css.dialog === undefined ? {} : { className: css.dialog }),
          ...(css.content === undefined ? {} : { contentClassName: css.content }),
          footer: h(
            'div',
            { className: css.confirmActions },
            h(
              Button,
              {
                variant: 'outline',
                disabled: busy,
                ref: cancelResetButton,
                onClick: () => {
                  if (inFlight.current?.sessionId !== sessionId) setConfirmRebind(false)
                },
              },
              t('recoveryRebindCancel'),
            ),
            h(
              Button,
              {
                variant: 'primary',
                disabled: busy || !rebindAllowed,
                onClick: () => {
                  void run('rebind').finally(() => {
                    if (activeSession.current === sessionId) setConfirmRebind(false)
                  })
                },
              },
              busy ? t('recoveryBusy') : t('recoveryRebindConfirm'),
            ),
          ),
        })
      : h(
          Modal,
          {
            open,
            onClose: () => {
              setOpen(false)
              setDiagnosticsOpen(false)
            },
            title: t('recoveryTitle'),
            ...(actionFailure === null ? { description: reason } : {}),
            closeLabel: t('recoveryClose'),
            backdropBlur: false,
            ...(css.dialog === undefined ? {} : { className: css.dialog }),
            ...(css.content === undefined ? {} : { contentClassName: css.content }),
          },
          actionFailure === null ? null : h('p', { className: css.error, role: 'alert' }, actionFailure),
          h(
            'div',
            { className: css.choices },
            reconnectButton,
            h(
              Button,
              {
                variant: 'outline',
                disabled: busy || !rebindAllowed,
                ref: resetButton,
                onClick: () => {
                  if (!busy && sessionAccessSource(sessionId, 'dshAcp/rebindRecoveryBlank')?.getSnapshot() === true)
                    setConfirmRebind(true)
                },
              },
              t('recoveryRebind'),
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
        ),
  )
}
