import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
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
import { toolApprovalPolicyStream, type ToolApprovalPolicySnapshot } from '../data/tool-approval-policy-stream.ts'
import { toolApprovalPolicyGroup } from './agent-session-controls.ts'

type AgentControlProps = PropsRuntime<'conversation.input.left'> &
  PropsLocale<'acpActivity'> & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly ownsRoute: OwnsAcpRoute
    readonly getDefaultProvider: () => Promise<string | undefined>
    readonly watchDefaultProvider: (changed: () => void) => () => void
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
  t,
  remote,
  streamFactory,
  ownsRoute,
  getDefaultProvider,
  watchDefaultProvider,
}: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const running = useSession((state) => state.running)
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
  const isAcp = snapshotIsAcp(projection, ownsRoute, defaultProvider)
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [policySnapshot, setPolicySnapshot] = useState<ToolApprovalPolicySnapshot | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [policyStale, setPolicyStale] = useState(false)
  const [policyReadFailed, setPolicyReadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const current = ++epoch.current
    setOpen(false)
    setBusy(false)
    setError(null)
    setSnapshot(null)
    setPolicySnapshot(null)
    setPolicyError(null)
    setPolicyStale(false)
    setPolicyReadFailed(false)
    if (!isAcp || sessionId === undefined) return
    const stream = agentSessionStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (current !== epoch.current) return
        setSnapshot(value)
        setError(null)
      },
      () => {
        if (current !== epoch.current) return
        setSnapshot((value) => (value === null ? null : { ...value, editable: false, freshness: 'stale' }))
        setError(t('agentControlUnavailable'))
      },
    )
    stream.start()
    return () => {
      ++epoch.current
      void stream.dispose()
    }
  }, [epoch, isAcp, remote, streamFactory, sessionId, t, retry])

  const policyEpoch = useRef(0)
  useEffect(() => {
    const current = ++policyEpoch.current
    if (!isAcp || sessionId === undefined) {
      setPolicySnapshot(null)
      setPolicyError(null)
      setPolicyStale(false)
      setPolicyReadFailed(false)
      return
    }
    setPolicySnapshot(null)
    setPolicyError(null)
    setPolicyStale(false)
    setPolicyReadFailed(false)
    const stream = toolApprovalPolicyStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (current !== policyEpoch.current || value.sessionId !== sessionId) return
        setPolicySnapshot(value)
        setPolicyError(null)
        setPolicyStale(false)
        setPolicyReadFailed(false)
      },
      () => {
        if (current !== policyEpoch.current) return
        setPolicyError(t('toolApprovalUnavailable'))
        setPolicyStale(true)
        setPolicyReadFailed(true)
      },
    )
    stream.start()
    return () => {
      ++policyEpoch.current
      void stream.dispose()
    }
  }, [isAcp, remote, streamFactory, sessionId, t, retry])

  if (
    !isAcp ||
    (snapshot !== null && snapshot.sessionId !== sessionId) ||
    (policySnapshot !== null && policySnapshot.sessionId !== sessionId)
  )
    return null
  if (snapshot === null && policySnapshot === null) {
    if (policyError === null && error === null) return null
    return h(
      'button',
      {
        type: 'button',
        className: `${css.trigger} ${css.retryTrigger}`,
        onClick: () => setRetry((value) => value + 1),
        title: t(policyError !== null ? 'toolApprovalRetry' : 'agentControlRetry'),
      },
      policyError ?? error,
    )
  }
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot = snapshot === null ? null : running ? { ...snapshot, editable: false } : snapshot
  const label = snapshot === null ? t('toolApprovalSession') : agentControlLabel(snapshot, t)
  const groups = [
    ...(policySnapshot === null || policyStale ? [] : [toolApprovalPolicyGroup(policySnapshot, t)]),
    ...(visibleSnapshot === null ? [] : agentControlMenuGroups(visibleSnapshot, t)),
  ]
  const footer = [...(snapshot === null ? [] : agentControlFooter(snapshot, t))]
  // A read-only explanation must not create an empty menu before controls arrive.
  if (groups.length === 0 && footer.length === 0 && snapshot?.note == null && error === null && policyError === null)
    return null
  if (snapshot !== null && (running || (!snapshot.editable && snapshot.freshness === 'live')))
    footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: error })
  if (policyError !== null) footer.push({ type: 'label', id: 'policy-error', text: policyError })
  const select = (item: AgentControlChoice): void => {
    if (sessionId === undefined) return
    const current = epoch.current
    setOpen(false)
    setBusy(true)
    if (item.write.kind === 'tool-approval-policy') {
      if (policySnapshot === null || policyStale || !policySnapshot.editable) {
        setBusy(false)
        return
      }
      setPolicyError(null)
      void remote
        .setToolApprovalPolicy(sessionId, { policy: item.write.policy })
        .then((result) => {
          if (current === epoch.current && !result.ok) setPolicyError(t('toolApprovalChangeFailed'))
        })
        .catch(() => {
          if (current === epoch.current) setPolicyError(t('toolApprovalChangeFailed'))
        })
        .finally(() => {
          if (current === epoch.current) setBusy(false)
        })
      return
    }
    if (snapshot === null || visibleSnapshot === null || !visibleSnapshot.editable || snapshot.freshness !== 'live') {
      setBusy(false)
      return
    }
    setError(null)
    void remote
      .setAgentSessionOption(sessionId, item.write)
      .then((result) => {
        if (current === epoch.current && !result.ok) setError(result.error.message)
      })
      .catch((reason) => {
        if (current === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
      })
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
      if (value && (error !== null || policyReadFailed)) setRetry((current) => current + 1)
      setOpen(value)
    },
    onSelect: select,
  })
}
