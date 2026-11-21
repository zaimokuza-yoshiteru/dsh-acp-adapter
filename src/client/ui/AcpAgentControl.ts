import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import { includesRoute, type UseRouteOwnership } from '../data/managed-routes.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import css from './AcpAgentControl.module.css'
import { AgentSessionMenu } from './AgentSessionMenu.ts'
import {
  agentControlMenuGroups,
  agentControlLabel,
  agentControlFooter,
  type AgentControlChoice,
} from './agent-session-controls.ts'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import type { AcpUiFeedback } from '../data/feedback.ts'
import type { SessionAccessSource } from './session-action-access.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'

type AgentControlProps = PropsRuntime<'conversation.input.left'> &
  PropsLocale<'acpActivity'> & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly useRouteOwnership: UseRouteOwnership
    readonly getDefaultProvider: () => Promise<string | undefined>
    readonly watchDefaultProvider: (changed: () => void) => () => void
    readonly feedback: Pick<AcpUiFeedback, 'report'>
    readonly sessionAccessSource: SessionAccessSource
  }

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { readonly provider?: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

export function snapshotIsAcp(value: unknown, ownsRoute: OwnsAcpRoute, fallbackProvider?: string): boolean {
  if (typeof value !== 'object' || value === null) return ownsRoute(fallbackProvider)
  const selection = value as { readonly lastUsed?: unknown; readonly next?: unknown }
  const current = selection.next === undefined ? selection.lastUsed : selection.next
  const selectedProvider =
    current === null || current === undefined
      ? selection.lastUsed == null
        ? fallbackProvider
        : undefined
      : providerOf(current)
  return ownsRoute(selectedProvider)
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
  getDefaultProvider,
  watchDefaultProvider,
  feedback,
  sessionAccessSource,
}: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const sessionTitle = useProjection('title')
  const running = useSession((state) => state.running)
  const optionWriteAllowed = useAccess('dshAcp/setAgentSessionOption')
  const [defaultProvider, setDefaultProvider] = useState<string | undefined>()
  const [defaultGeneration, setDefaultGeneration] = useState(0)
  useEffect(
    () =>
      watchDefaultProvider(() => {
        setDefaultProvider(undefined)
        setDefaultGeneration((value) => value + 1)
      }),
    [watchDefaultProvider],
  )
  useEffect(() => {
    let active = true
    void getDefaultProvider()
      .then((provider) => {
        if (active) setDefaultProvider(provider)
      })
      .catch(() => {
        if (active) setDefaultProvider(undefined)
      })
    return () => {
      active = false
    }
  }, [getDefaultProvider, defaultGeneration])
  const isAcp = useRouteOwnership((routes) =>
    snapshotIsAcp(projection, (id) => includesRoute(routes.providers, id), defaultProvider),
  )
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: 'agentControlUnavailable' | 'actionSaveFailed'; detail?: string } | null>(
    null,
  )
  const [readFailed, setReadFailed] = useState(false)
  const epoch = useRef(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const current = ++epoch.current
    setOpen(false)
    setBusy(false)
    setError(null)
    setReadFailed(false)
    setSnapshot(null)
    if (!isAcp || sessionId === undefined) return
    const stream = agentSessionStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (current !== epoch.current) return
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
      void stream.dispose()
    }
  }, [isAcp, remote, streamFactory, sessionId, retry])

  if (!isAcp || (snapshot !== null && snapshot.sessionId !== sessionId)) return null
  if (snapshot === null) {
    if (error === null) return null
    return h(
      'button',
      {
        type: 'button',
        className: `${css.trigger} ${css.retryTrigger}`,
        onClick: () => setRetry((value) => value + 1),
        title: t('agentControlRetry'),
      },
      localizedDiagnostic(t, error.key, error.detail),
    )
  }
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot = { ...snapshot, editable: snapshot.editable && !running && optionWriteAllowed }
  const groups = agentControlMenuGroups(visibleSnapshot, t)
  const label = agentControlLabel(snapshot, t)
  const footer = [...agentControlFooter(snapshot, t)]
  if (groups.length === 0 && footer.length === 0 && error === null) return null
  if (running || (!visibleSnapshot.editable && snapshot.freshness === 'live'))
    footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: localizedDiagnostic(t, error.key, error.detail) })
  const select = (item: AgentControlChoice): void => {
    if (sessionId === undefined) return
    const current = epoch.current
    // Submitted operations outlive this view; only their local error state is generation-scoped.
    const sourceSession = { id: sessionId, title: sessionTitle ?? null }
    setOpen(false)
    setBusy(true)
    if (
      !visibleSnapshot.editable ||
      visibleSnapshot.freshness !== 'live' ||
      !optionWriteAllowed ||
      sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() !== true
    ) {
      setBusy(false)
      return
    }
    setError(null)
    const reportFailure = (detail: string): void => {
      feedback.report('session-option-failed', current === epoch.current ? undefined : sourceSession)
      if (current === epoch.current) setError({ key: 'actionSaveFailed', detail })
    }
    void remote
      .setAgentSessionOption(sessionId, item.write)
      .then((result) => {
        if (!result.ok) reportFailure(result.error.message)
      })
      .catch((reason: unknown) => reportFailure(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        if (current === epoch.current) setBusy(false)
      })
  }
  return h(AgentSessionMenu, {
    groups,
    footer,
    label,
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
