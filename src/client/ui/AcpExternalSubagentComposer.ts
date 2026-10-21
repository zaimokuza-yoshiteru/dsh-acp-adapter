import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../../contract/external-subagent.ts'
import css from './AcpExternalSubagentComposer.module.css'

export function selectExternalSubagentRecord(owner: ComposerChainProps, records: ReadonlySet<SessionId>): true | null {
  return owner.sessionId !== undefined &&
    owner.session?.subagent?.address.mode === 'one-shot' &&
    records.has(owner.sessionId)
    ? true
    : null
}

/** Refresh only the narrow claim when native, Host-pushed ownership facts change. */
export function followExternalSubagentRecords(
  source: HostObservable<ReturnType<ISessions['list']['getSnapshot']>>,
  mount: (records: ReadonlySet<SessionId>) => () => void,
): () => void {
  let key = ''
  let stopped = false
  let unmount: (() => void) | undefined
  const reconcile = (): void => {
    if (stopped) return
    const ids = Object.entries(source.getSnapshot().projectionsBySession)
      .filter(([, projection]) => projection.values.acpExecution?.externalSubagent === true)
      .map(([id]) => id as SessionId)
      .sort()
    const next = JSON.stringify(ids)
    if (next === key) return
    key = next
    const previous = unmount
    unmount = undefined
    previous?.()
    unmount = ids.length === 0 ? undefined : mount(new Set(ids))
  }
  const unsubscribe = source.subscribe(reconcile)
  try {
    reconcile()
  } catch (error) {
    stopped = true
    unsubscribe()
    throw error
  }
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    unmount?.()
    unmount = undefined
  }
}

/** The external Agent owns its private history; this local record cannot accept input. */
export function AcpExternalSubagentComposer({ t }: PropsLocale<'acpActivity'>): ReactNode {
  return h(
    'div',
    { className: css.frame, role: 'status', 'data-acp-external-record-notice': '' },
    h('strong', null, t('subagent.readOnlyTitle')),
    h('span', null, t('subagent.readOnlyBody')),
  )
}
