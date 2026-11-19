import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import {
  nextIndependentAction,
  type independentSessionNavigation,
  type IndependentSessionOutcome,
} from '../coordinator/native-session-navigation.ts'
import { agentControlMenuGroups, type AgentControlTranslate } from './agent-session-controls.ts'
import type { SessionAccessSource } from './session-action-access.ts'
import { ManagedModelCapacityDialog } from './ManagedModelCapacityDialog.ts'
import css from './AcpRecoveryDock.module.css'

type Props = {
  sessionId: SessionId
  remote: AcpRemoteLike
  streamFactory: RemoteStreamFactory
  t: AgentControlTranslate
  writable: boolean
  mayCreate: boolean
  running: boolean
  sessionAccessSource: SessionAccessSource
  createNewSession: ReturnType<typeof independentSessionNavigation>
}

/** A possibly delivered message stays in its original chat. Neither action replays it. */
export function ManagedModelRecovery({
  sessionId,
  remote,
  streamFactory,
  t,
  writable,
  mayCreate,
  running,
  sessionAccessSource,
  createNewSession,
}: Props): ReactNode {
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [navigation, setNavigation] = useState<IndependentSessionOutcome>('idle')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [riskTarget, setRiskTarget] = useState<string | null>(null)
  const pending = useRef<symbol | undefined>()
  const mayCreateNow = useRef(mayCreate)
  mayCreateNow.current = mayCreate
  useEffect(() => {
    let live = true
    const stream = agentSessionStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (live) setSnapshot(value)
      },
      () => {
        if (live) setSnapshot(null)
      },
    )
    stream.start()
    return () => {
      live = false
      pending.current = undefined
      void stream.dispose()
    }
  }, [remote, streamFactory, sessionId])
  const model = snapshot?.managedModel
  if (!snapshot || snapshot.sessionId !== sessionId || !model?.recovery) return null
  const previous = agentControlMenuGroups(snapshot, t)
    .find((group) => group.kind === 'model')
    ?.choices.find(({ write }) => write.kind === 'config' && write.value === model.lastSuccessfulModel)
  const restore = previous && !previous.disabled && (!previous.current || model.recovery === 'unconfirmed') && writable
  const run = async (operation: (current: () => boolean) => Promise<void>): Promise<void> => {
    if (pending.current || running) return
    const token = Symbol()
    pending.current = token
    const current = () => pending.current === token
    setBusy(true)
    setFailed(false)
    try {
      await operation(current)
    } catch {
      if (current()) setFailed(true)
    } finally {
      if (current()) {
        pending.current = undefined
        setBusy(false)
      }
    }
  }
  const nextAction = nextIndependentAction(navigation)
  const switchBack = (): void => {
    if (
      !previous ||
      !restore ||
      previous.write.kind !== 'config' ||
      sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() !== true ||
      sessionAccessSource(sessionId, 'session/selectModel')?.getSnapshot() !== true
    )
      return
    const request = previous.write
    void run(async () => {
      const result = await remote.setAgentSessionOption(sessionId, request)
      if (!result.ok) throw new Error(result.error.message)
    })
  }
  if (restore && previous.capacityRisk && riskTarget === previous.id && !busy && !running)
    return h(ManagedModelCapacityDialog, {
      model: previous.label,
      risk: previous.capacityRisk,
      t,
      cancel: () => setRiskTarget(null),
      confirm: () => {
        setRiskTarget(null)
        switchBack()
      },
    })
  return h(
    'div',
    { className: css.dock, 'data-acp-managed-model-recovery': '' },
    h(
      'div',
      { className: `${css.surface} ${css.historySurface}` },
      h(
        'span',
        { className: css.summaryText, role: 'status' },
        t(
          navigation === 'preset-unavailable'
            ? 'independentPresetUnavailable'
            : navigation === 'create-unknown'
              ? 'independentCreationUnknown'
              : navigation.startsWith('ungrouped')
                ? 'unroutedHistoryUngrouped'
                : model.recovery === 'possibly-delivered'
                  ? 'managedModelIncomplete'
                  : 'managedModelChooseAgain',
        ),
      ),
      restore
        ? h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy || running,
              onClick: () => (previous.capacityRisk ? setRiskTarget(previous.id) : switchBack()),
            },
            t('managedModelRestore', { model: previous.label }),
          )
        : null,
      mayCreate
        ? h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy || running,
              onClick: () =>
                void run(async (current) => {
                  const outcome = await createNewSession(sessionId, () => current() && mayCreateNow.current, nextAction)
                  if (current()) setNavigation(outcome)
                }),
            },
            t(
              navigation === 'preset-unavailable'
                ? 'independentUseDefault'
                : navigation === 'create-unknown'
                  ? 'independentCheckCreated'
                  : nextAction === 'open-existing'
                    ? 'unroutedHistoryOpen'
                    : 'managedModelNew',
            ),
          )
        : null,
    ),
    failed || navigation.endsWith('-failed')
      ? h(
          'p',
          { className: css.error, role: 'alert' },
          t(
            failed
              ? 'recoveryActionFailed'
              : navigation === 'create-failed'
                ? 'crossBackendFailureCreate'
                : 'crossBackendFailureOpen',
          ),
        )
      : null,
  )
}
