import { selectedAgentProvider, useComposerDefault, type ComposerDefaultProvider } from './composer-provider.ts'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import { includesRoute, type UseRouteOwnership } from '../data/managed-routes.ts'
import css from './AcpAgentControl.module.css'
import { AgentSessionMenu } from './AgentSessionMenu.ts'
import {
  agentControlMenuGroups,
  agentControlLabel,
  agentControlFooter,
  primaryAgentControlGroup,
  type AgentControlChoice,
  firstTurnIntentKey,
} from './agent-session-controls.ts'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import type { AcpUiFeedback } from '../data/feedback.ts'
import type { SessionAccessSource } from './session-action-access.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'
import {
  beginFirstTurnIntent,
  confirmsFirstTurnIntent,
  finishFirstTurnIntent,
  firstTurnWriteTimeoutMs,
  guardFirstTurnSend,
  readFirstTurnIntent,
  subscribeFirstTurnIntent,
} from '../data/first-turn-intent.ts'

type AgentControlProps = PropsRuntime<'conversation.input.left'> &
  PropsLocale<'acpActivity'> &
  ComposerDefaultProvider & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly useRouteOwnership: UseRouteOwnership
    readonly useNativePermissionSeat: (select: (native: boolean) => boolean) => boolean
    readonly openToolPermissions: (sessionId: string, signal: AbortSignal) => Promise<boolean>
    readonly nativeStopLabel: () => string
    readonly feedback: Pick<AcpUiFeedback, 'report'>
    readonly sessionAccessSource: SessionAccessSource
  }

/** RC.5's permission package inherits its Loader fiber's name. Match the stock
 * export and its uncontested native priority as well as that diagnostic stamp. */
export function isNativePermissionSeat(
  winner: StoredEntry | undefined,
  candidates: readonly StoredEntry[],
  owner: string | undefined,
): boolean {
  return (
    !!winner &&
    owner !== undefined &&
    winner.registrant === owner &&
    winner.locale === 'permission.access' &&
    (winner.options.priority ?? 0) === 0 &&
    typeof winner.component === 'function' &&
    winner.component.name === 'PermissionSelect' &&
    !candidates.some((other) => other !== winner && (other.options.priority ?? 0) === 0)
  )
}

/** Small ACP-only control in DSH's native input-left extension point. */
export function AcpAgentControl({
  sessionId,
  useProjection,
  useSession,
  useAccess,
  t,
  remote,
  streamFactory,
  useRouteOwnership,
  useNativePermissionSeat,
  openToolPermissions,
  nativeStopLabel,
  getDefaultProvider,
  watchDefaultProvider,
  feedback,
  sessionAccessSource,
}: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const dedicated = useProjection('agentPreset') === 'acp-adapter'
  const nativePermissions = useProjection('permissions')
  const nativePermissionSeat = useNativePermissionSeat((native) => native)
  const sessionTitle = useProjection('title')
  const running = useSession((state) => state.running)
  const optionWriteAllowed = useAccess('dshAcp/setAgentSessionOption')
  const clearAllowed = useAccess('dshAcp/clearAgentPreselection')
  const provider = selectedAgentProvider(projection, useComposerDefault(getDefaultProvider, watchDefaultProvider))
  const isAcp = useRouteOwnership((routes) => includesRoute(routes.providers, provider))
  const selectedProvider = isAcp ? provider : undefined
  const intentKey =
    dedicated && sessionId && selectedProvider ? firstTurnIntentKey(sessionId, selectedProvider) : undefined
  const intent = useSyncExternalStore(subscribeFirstTurnIntent, () => readFirstTurnIntent(intentKey))
  useEffect(() => {
    if (intentKey && sessionId) return guardFirstTurnSend(sessionId, intentKey, nativeStopLabel)
  }, [sessionId, intentKey, nativeStopLabel])
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: 'agentControlUnavailable' | 'actionSaveFailed'; detail?: string } | null>(
    null,
  )
  const [readFailed, setReadFailed] = useState(false)
  const epoch = useRef(0)
  const viewSignal = useRef<AbortController | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const current = ++epoch.current
    setOpen(false)
    setBusy(false)
    setError(null)
    setReadFailed(false)
    setSnapshot(null)
    if (selectedProvider === undefined || sessionId === undefined) return
    const abort = new AbortController()
    viewSignal.current = abort
    const stream = agentSessionStream(
      remote,
      streamFactory,
      dedicated ? { sessionId, provider: selectedProvider } : sessionId,
      (value) => {
        if (current !== epoch.current) return
        const pending = readFirstTurnIntent(intentKey)
        if (
          intentKey &&
          pending &&
          value?.sessionId === sessionId &&
          `acp-${value.profileId}` === selectedProvider &&
          confirmsFirstTurnIntent(value, pending)
        )
          finishFirstTurnIntent(intentKey, pending)
        setSnapshot(value)
        setError(null)
        setReadFailed(false)
      },
      () => {
        if (current !== epoch.current) return
        setSnapshot((value) => (value === null ? null : { ...value, editable: false, freshness: 'stale' }))
        setError({ key: 'agentControlUnavailable' })
        setReadFailed(true)
      },
    )
    stream.start()
    return () => {
      ++epoch.current
      abort.abort()
      void stream.dispose()
    }
  }, [selectedProvider, dedicated, remote, streamFactory, sessionId, retry, intentKey])

  if (
    selectedProvider === undefined ||
    sessionId === undefined ||
    (snapshot !== null &&
      (snapshot.sessionId !== sessionId ||
        `acp-${snapshot.profileId}` !== selectedProvider ||
        (snapshot.preselection === true && !dedicated)))
  )
    return null
  if (snapshot === null) {
    if (error === null && !intent) return null
    return h(
      'button',
      {
        type: 'button',
        className: `${css.trigger} ${css.retryTrigger}`,
        onClick: () => setRetry((value) => value + 1),
        title: t('agentControlRetry'),
      },
      error ? localizedDiagnostic(t, error.key, error.detail) : t('agentControlChooseSetting'),
    )
  }
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot = {
    ...snapshot,
    editable:
      snapshot.editable &&
      !running &&
      optionWriteAllowed &&
      (!snapshot.preselection || snapshot.preselectionRevision !== undefined),
  }
  const groups = agentControlMenuGroups(visibleSnapshot, t)
  const primary = dedicated ? primaryAgentControlGroup(groups) : undefined
  const replacePermission = primary !== undefined && nativePermissionSeat && nativePermissions !== undefined
  const label = primary
    ? (primary.choices.find((choice) => choice.current)?.label ?? primary.name)
    : agentControlLabel(snapshot, t)
  const footer = [...agentControlFooter(snapshot, t)]
  if (groups.length === 0 && footer.length === 0 && error === null && !snapshot.preselected?.length && !intent)
    return null
  if (running || (!visibleSnapshot.editable && snapshot.freshness === 'live'))
    footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: localizedDiagnostic(t, error.key, error.detail) })
  if (intent && !busy) footer.push({ type: 'label', id: 'unconfirmed', text: t('agentControlUnconfirmed') })
  const submit = async (
    action: (signal?: AbortSignal) => Promise<{ ok: true } | { ok: false; error: { message: string } }>,
    preselection?: AgentControlChoice['write'] | null,
  ): Promise<void> => {
    const current = epoch.current
    // Submitted operations outlive this view; only their local error state is generation-scoped.
    const sourceSession = { id: sessionId, title: sessionTitle ?? null }
    setOpen(false)
    setBusy(true)
    const token =
      preselection !== undefined && intentKey && snapshot.preselectionRevision !== undefined
        ? beginFirstTurnIntent(intentKey, snapshot.preselectionRevision, preselection)
        : undefined
    const abort = new AbortController()
    const timer = token ? setTimeout(() => abort.abort(), firstTurnWriteTimeoutMs) : undefined
    const stop = () => abort.abort()
    const view = viewSignal.current?.signal
    if (token) view?.addEventListener('abort', stop, { once: true })
    setError(null)
    const reportFailure = (detail: string): void => {
      feedback.report('session-option-failed', current === epoch.current ? undefined : sourceSession)
      if (current === epoch.current) setError({ key: 'actionSaveFailed', detail })
    }
    try {
      // The actual gateway honors AbortSignal. Also bound the view if an
      // interrupted transport never settles the underlying Promise.
      const result = token
        ? await Promise.race([
            action(abort.signal),
            new Promise<never>((_, reject) =>
              abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }),
            ),
          ])
        : await action()
      if (!result.ok) {
        if (!token || !view?.aborted) reportFailure(result.error.message)
      } else if (intentKey && token) finishFirstTurnIntent(intentKey, token)
    } catch (reason) {
      if (!token || !view?.aborted) reportFailure(reason instanceof Error ? reason.message : String(reason))
    } finally {
      clearTimeout(timer)
      if (token) view?.removeEventListener('abort', stop)
      if (current === epoch.current) setBusy(false)
    }
  }
  const target = {
    sessionId,
    provider: selectedProvider,
    ...(snapshot.preselectionRevision !== undefined ? { preselectionRevision: snapshot.preselectionRevision } : {}),
  }
  const select = (item: AgentControlChoice): void => {
    if (
      !visibleSnapshot.editable ||
      (snapshot.freshness !== 'live' && !snapshot.preselection) ||
      sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() !== true
    )
      return
    void submit(
      (signal) => remote.setAgentSessionOption(snapshot.preselection ? target : sessionId, item.write, signal),
      snapshot.preselection ? item.write : undefined,
    )
  }
  const actions = []
  if (dedicated && (snapshot.preselected?.length || intent) && !running && optionWriteAllowed && clearAllowed) {
    actions.push({
      id: 'agent-defaults',
      label: t('agentControlClearPreselection'),
      run: () => {
        if (
          sessionAccessSource(sessionId, 'dshAcp/clearAgentPreselection')?.getSnapshot() === true &&
          sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() === true
        )
          void submit((signal) => remote.clearAgentPreselection(target, signal), null)
      },
    })
  }
  if (replacePermission) {
    actions.push({
      id: 'dsh-permissions',
      label: t('agentControlDshPermissions'),
      run: () => {
        const signal = viewSignal.current?.signal
        if (signal)
          void openToolPermissions(sessionId, signal)
            .then((opened) => {
              if (!opened && !signal.aborted) setError({ key: 'agentControlUnavailable' })
            })
            .catch(() => {
              if (!signal.aborted) setError({ key: 'agentControlUnavailable' })
            })
      },
    })
  }
  return h(AgentSessionMenu, {
    groups,
    primaryGroup: primary,
    replacesPermission: replacePermission,
    pendingIntent: intent !== null,
    actions,
    footer,
    label: intent && !busy ? t('agentControlChooseSetting') : label,
    t,
    open,
    disabled: busy,
    side: 'top',
    onOpenChange: (value) => {
      if (value && readFailed) setRetry((current) => current + 1)
      setOpen(value)
    },
    onSelect: select,
  })
}
