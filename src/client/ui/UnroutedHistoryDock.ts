import { createElement as h, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { nextIndependentAction } from '../coordinator/native-session-navigation.ts'
import type { ReactNode } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IndependentSessionAction, IndependentSessionOutcome } from '../coordinator/native-session-navigation.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { includesRoute, type UseRouteOwnership } from '../data/managed-routes.ts'
import css from './AcpRecoveryDock.module.css'

type Props = PropsRuntime<'conversation.input.dock'> &
  PropsLocale<'acpActivity'> & {
    readonly directory: HostObservable<ModelDirectoryState>
    readonly useRouteOwnership: UseRouteOwnership
    readonly openIndependent: (
      current: () => boolean,
      action: IndependentSessionAction,
    ) => Promise<IndependentSessionOutcome>
  }

/** Show the native picker's alternative only when a completed history has no recorded model. */
export function UnroutedHistoryDock({
  sessionId,
  useProjection,
  useSession,
  useSessions,
  useSessionRetainInfo,
  useWorkspaces,
  useRemoteAccess,
  useWorkspaceAccess,
  useAccess,
  directory,
  useRouteOwnership,
  openIndependent,
  t,
}: Props): ReactNode {
  const main = useSessionRetainInfo((info) => (info?.retainedBy.mainView ?? 0) > 0)
  const idle = useSession((s) => s.openState === 'open' && !s.blank && !s.running && !s.removed && s.subagent === null)
  const history = useProjection('acpExecution', (view) => view?.completedWithoutModel === true)
  const unselected = useProjection('modelSelection', (view) => view?.next === null && view.lastUsed === null)
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot)
  const providers = useRouteOwnership((routes) => routes.providers)
  const currentDefault = snapshot.current
  const enabled =
    main &&
    idle &&
    history &&
    unselected &&
    snapshot.status === 'ready' &&
    includesRoute(providers, currentDefault?.provider)
  const workspace = useWorkspaces((s) => s.items.find((item) => item.sessionIds.includes(sessionId))?.workspaceId)
  const cwd = useSessions((s) => s.byId[sessionId]?.cwd)
  const mayCreate = useRemoteAccess('session/create')
  const mayCreateInWorkspace = useWorkspaceAccess((workspace ?? '') as WorkspaceId, 'session/create')
  const mayChoose = useAccess('session/selectModel')
  const canCreate = workspace === undefined ? Boolean(cwd) && mayCreate : mayCreateInWorkspace
  const canChoose =
    mayChoose && snapshot.groups.some((group) => group.models.length > 0 && !includesRoute(providers, group.id))
  const [action, setAction] = useState<IndependentSessionOutcome | 'busy'>('idle')
  const active = useRef<symbol | undefined>()
  useLayoutEffect(() => {
    setAction('idle')
    return () => {
      active.current = undefined
    }
  }, [sessionId, enabled, canCreate, currentDefault?.provider, currentDefault?.model])

  if (!enabled || (!canChoose && !canCreate)) return null
  const ungrouped = action === 'ungrouped' || action === 'ungrouped-open-failed'
  const nextAction = nextIndependentAction(action)
  const readyToOpen = nextAction === 'open-existing'
  const start = async (): Promise<void> => {
    if (!canCreate || active.current !== undefined) return
    const token = Symbol()
    active.current = token
    setAction('busy')
    const current = () =>
      active.current === token &&
      directory.getSnapshot().status === 'ready' &&
      directory.getSnapshot().current?.provider === currentDefault?.provider &&
      directory.getSnapshot().current?.model === currentDefault?.model
    try {
      const result = await openIndependent(current, nextAction)
      if (current()) setAction(result)
    } catch {
      if (current()) setAction(readyToOpen ? 'open-failed' : 'create-failed')
    } finally {
      if (active.current === token) active.current = undefined
    }
  }
  return h(
    'div',
    { className: css.dock, 'data-acp-unrouted-history': '' },
    h(
      'div',
      { className: `${css.surface} ${css.historySurface}` },
      h(
        'span',
        { className: css.summaryText },
        t(
          action === 'preset-unavailable'
            ? 'independentPresetUnavailable'
            : action === 'create-unknown'
              ? 'independentCreationUnknown'
              : ungrouped
                ? 'unroutedHistoryUngrouped'
                : canChoose
                  ? 'unroutedHistoryHint'
                  : 'unroutedHistoryCreateOnly',
        ),
      ),
      canCreate
        ? h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: action === 'busy',
              onClick: () => {
                void start()
              },
            },
            t(
              action === 'create-unknown'
                ? 'independentCheckCreated'
                : action === 'preset-unavailable'
                  ? 'independentUseDefault'
                  : readyToOpen
                    ? 'unroutedHistoryOpen'
                    : 'crossBackendContinue',
            ),
          )
        : null,
    ),
    action.endsWith('-failed')
      ? h(
          'p',
          { role: 'alert', className: css.error },
          t(action === 'create-failed' ? 'crossBackendFailureCreate' : 'crossBackendFailureOpen'),
        )
      : null,
  )
}
