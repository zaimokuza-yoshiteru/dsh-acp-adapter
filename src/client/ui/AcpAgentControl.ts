import { createElement as h, useEffect, useRef, useState } from 'react'
import { ManagedModelCapacityDialog } from './ManagedModelCapacityDialog.ts'
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
import { toolApprovalPolicyStream, type ToolApprovalPolicySnapshot } from '../data/tool-approval-policy-stream.ts'
import { toolApprovalPolicyGroup } from './agent-session-controls.ts'
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
  const modelWriteAllowed = useAccess('session/selectModel')
  const policyWriteAllowed = useAccess('dshAcp/setToolApprovalPolicy')
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
  const [policySnapshot, setPolicySnapshot] = useState<ToolApprovalPolicySnapshot | null>(null)
  const [policyError, setPolicyError] = useState<'toolApprovalUnavailable' | 'toolApprovalChangeFailed' | null>(null)
  const [policyStale, setPolicyStale] = useState(false)
  const [policyReadFailed, setPolicyReadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: 'agentControlUnavailable' | 'actionSaveFailed'; detail?: string } | null>(
    null,
  )
  const [readFailed, setReadFailed] = useState(false)
  const epoch = useRef(0)
  const [retry, setRetry] = useState(0)
  const [riskChoice, setRiskChoice] = useState<string | null>(null)
  useEffect(() => {
    if (running || readFailed || !optionWriteAllowed || !modelWriteAllowed) setRiskChoice(null)
  }, [running, readFailed, optionWriteAllowed, modelWriteAllowed])

  useEffect(() => {
    const current = ++epoch.current
    setOpen(false)
    setBusy(false)
    setRiskChoice(null)
    setError(null)
    setReadFailed(false)
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
        setPolicyError('toolApprovalUnavailable')
        setPolicyStale(true)
        setPolicyReadFailed(true)
      },
    )
    stream.start()
    return () => {
      ++policyEpoch.current
      void stream.dispose()
    }
  }, [isAcp, remote, streamFactory, sessionId, retry])

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
      policyError !== null ? t(policyError) : localizedDiagnostic(t, error!.key, error!.detail),
    )
  }
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot =
    snapshot === null ? null : { ...snapshot, editable: snapshot.editable && !running && optionWriteAllowed }
  const settings =
    visibleSnapshot === null
      ? []
      : agentControlMenuGroups(visibleSnapshot, t, modelWriteAllowed && optionWriteAllowed && !running && !readFailed)
  const label = snapshot === null ? t('toolApprovalSession') : agentControlLabel(snapshot, t, settings)
  const groups = [
    ...settings.filter((group) => group.kind === 'model'),
    ...(policySnapshot === null || policyStale
      ? []
      : [toolApprovalPolicyGroup({ ...policySnapshot, editable: policySnapshot.editable && policyWriteAllowed }, t)]),
    ...settings.filter((group) => group.kind !== 'model'),
  ]
  const footer = [...(snapshot === null ? [] : agentControlFooter(snapshot, t))]
  // A read-only explanation must not create an empty menu before controls arrive.
  if (groups.length === 0 && footer.length === 0 && error === null && policyError === null) return null
  if (snapshot !== null && (running || (!visibleSnapshot?.editable && snapshot.freshness === 'live')))
    footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: localizedDiagnostic(t, error.key, error.detail) })
  if (policyError !== null) footer.push({ type: 'label', id: 'policy-error', text: t(policyError) })
  const select = (item: AgentControlChoice): void => {
    if (sessionId === undefined) return
    const current = epoch.current
    // Submitted operations outlive this view; only their local error state is generation-scoped.
    const sourceSession = { id: sessionId, title: sessionTitle ?? null }
    setOpen(false)
    setBusy(true)
    if (item.write.kind === 'tool-approval-policy') {
      if (
        policySnapshot === null ||
        policyStale ||
        !policySnapshot.editable ||
        !policyWriteAllowed ||
        sessionAccessSource(sessionId, 'dshAcp/setToolApprovalPolicy')?.getSnapshot() !== true
      ) {
        setBusy(false)
        return
      }
      setPolicyError(null)
      void remote
        .setToolApprovalPolicy(sessionId, { policy: item.write.policy })
        .then((result) => {
          if (result.ok) return
          feedback.report('tool-approval-failed', current === epoch.current ? undefined : sourceSession)
          if (current === epoch.current) setPolicyError('toolApprovalChangeFailed')
        })
        .catch(() => {
          feedback.report('tool-approval-failed', current === epoch.current ? undefined : sourceSession)
          if (current === epoch.current) setPolicyError('toolApprovalChangeFailed')
        })
        .finally(() => {
          if (current === epoch.current) setBusy(false)
        })
      return
    }
    const managedModel = item.write.kind === 'config' && snapshot?.managedModel?.optionId === item.write.id
    const dormantModel = snapshot?.freshness === 'stale' && managedModel && !readFailed && !running
    if (
      snapshot === null ||
      visibleSnapshot === null ||
      ((!visibleSnapshot.editable || snapshot.freshness !== 'live') && !dormantModel) ||
      !optionWriteAllowed ||
      (item.requiresModelAccess && sessionAccessSource(sessionId, 'session/selectModel')?.getSnapshot() !== true) ||
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
      .then(async (result) => {
        if (result.ok) return
        if (managedModel && current === epoch.current) {
          // The recovery dock already explains this switch and offers the next action.
          const state = await remote.agentSessionSnapshot(sessionId).catch(() => null)
          if (
            current === epoch.current &&
            state?.ok &&
            state.value.sessionId === sessionId &&
            state.value.managedModel?.recovery
          )
            return
        }
        reportFailure(result.error.message)
      })
      .catch((reason: unknown) => reportFailure(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        if (current === epoch.current) setBusy(false)
      })
  }
  const risk =
    riskChoice === null
      ? undefined
      : groups.flatMap((group) => group.choices).find((choice) => choice.id === riskChoice)
  const confirmation =
    risk?.capacityRisk && !risk.disabled && !busy
      ? h(ManagedModelCapacityDialog, {
          model: risk.label,
          risk: risk.capacityRisk,
          t,
          cancel: () => setRiskChoice(null),
          confirm: () => {
            setRiskChoice(null)
            select(risk)
          },
        })
      : null
  return h(AgentSessionMenu, {
    confirmation,
    groups,
    footer,
    label,
    t,
    open,
    disabled: busy,
    side: 'top',
    onOpenChange: (value) => {
      if (value && (readFailed || policyReadFailed)) setRetry((current) => current + 1)
      setOpen(value)
    },
    onSelect: (choice) => {
      if (choice.capacityRisk && !choice.current) setRiskChoice(choice.id)
      else select(choice)
    },
  })
}
