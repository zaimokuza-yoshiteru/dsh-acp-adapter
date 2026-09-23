import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import css from './AcpAgentControl.module.css'
import { AgentSessionMenu } from './AgentSessionMenu.ts'
import { agentControlMenuGroups, agentControlLabel, agentControlFooter, type AgentControlChoice } from './agent-session-controls.ts'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { agentSessionStream } from '../data/agent-session-stream.ts'

type AgentControlProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'acpActivity'> & {
  readonly remote: AcpRemoteLike
  readonly streamFactory: RemoteStreamFactory
  readonly ownsRoute: OwnsAcpRoute
}

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { readonly provider?: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

export function snapshotIsAcp(value: unknown, ownsRoute: OwnsAcpRoute): boolean {
  if (typeof value !== 'object' || value === null) return false
  const selection = value as { readonly lastUsed?: unknown; readonly next?: unknown }
  const current = selection.next === undefined ? selection.lastUsed : selection.next
  return ownsRoute(providerOf(current))
}

/** Small ACP-only control in DSH's native input-left extension point. */
export function AcpAgentControl({ sessionId, useProjection, useSession, t, remote, streamFactory, ownsRoute }: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const running = useSession(state => state.running)
  const isAcp = snapshotIsAcp(projection, ownsRoute)
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
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
    if (!isAcp || sessionId === undefined) return
    const stream = agentSessionStream(remote, streamFactory, sessionId, value => {
      if (current !== epoch.current) return
      setSnapshot(value)
      setError(null)
    }, () => {
      if (current !== epoch.current) return
      setSnapshot(value => value === null ? null : { ...value, editable: false, freshness: 'stale' })
      setError(t('agentControlUnavailable'))
    })
    stream.start()
    return () => {
      ++epoch.current
      void stream.dispose()
    }
  }, [epoch, isAcp, remote, streamFactory, sessionId, t, retry])

  if (!isAcp || (snapshot !== null && snapshot.sessionId !== sessionId)) return null
  if (snapshot === null) return error === null ? null : h('button', {
    type: 'button', className: css.trigger,
    onClick: () => setRetry(value => value + 1),
    title: t('agentControlRetry'),
  }, error)
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot = running ? { ...snapshot, editable: false } : snapshot
  const label = agentControlLabel(snapshot, t)
  const groups = agentControlMenuGroups(visibleSnapshot, t)
  const footer = [...agentControlFooter(snapshot, t)]
  // A read-only explanation must not create an empty menu before controls arrive.
  if (groups.length === 0 && footer.length === 0 && snapshot.note === null && error === null) return null
  if (running || (!snapshot.editable && snapshot.freshness === 'live')) footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: error })
  const select = (item: AgentControlChoice): void => {
    if (!visibleSnapshot.editable || snapshot.freshness !== 'live' || sessionId === undefined) return
    const current = epoch.current
    setOpen(false)
    setBusy(true)
    setError(null)
    void remote.setAgentSessionOption(sessionId, item.write).then(result => {
      if (current !== epoch.current) return
      // The subscription owns snapshots, so a late write response cannot roll back a newer notification.
      if (!result.ok) setError(result.error.message)
    }).catch(reason => {
      if (current === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (current === epoch.current) setBusy(false) })
  }
  return h(AgentSessionMenu, {
    groups, footer, label, t, open, disabled: busy, side: 'top',
    onOpenChange: value => { if (value && error !== null) setRetry(current => current + 1); setOpen(value) },
    onSelect: select,
  })
}
