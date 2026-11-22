import { createElement as h, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpCreatedAgentSession } from '../../contract/created-agent-session.ts'
import { useSessionActionAccess, type SessionAccessSource } from './session-action-access.ts'

type Props = PropsRuntime<'conversation.session.header.utilities'> &
  PropsLocale<'acpActivity'> & {
    readonly access: SessionAccessSource
    readonly load: (source: string) => Promise<readonly AcpCreatedAgentSession[]>
    readonly navigate: (id: SessionId) => void
  }

/** Keep a direct, workspace-native link beside the conversation that requested the independent chat. */
export function CreatedAgentSessions({ sessionId, useSession, useSessions, t, access, load, navigate }: Props) {
  const active = useSession((s) => s.openState === 'open' && !s.blank && !s.removed && s.subagent === null)
  const running = useSession((s) => s.running)
  const read = useSessionActionAccess(access, [sessionId], 'dshAcp/createdAgentSessions')
  const canRead = active && read.allows(sessionId)
  const [loaded, setLoaded] = useState<{ source: string; rows: readonly AcpCreatedAgentSession[] }>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let current = true
    if (canRead)
      void load(sessionId).then(
        (rows) => {
          if (current) setLoaded({ source: sessionId, rows })
        },
        () => {
          if (current) setLoaded(undefined)
        },
      )
    else setLoaded(undefined)
    return () => {
      current = false
    }
  }, [sessionId, load, canRead, running])
  useEffect(() => setOpen(false), [sessionId, canRead])
  const rows = canRead && loaded?.source === sessionId ? loaded.rows : []
  const targets = useSessionActionAccess(
    access,
    rows.map((row) => row.sessionId),
    'session/follow',
  )
  const listed = useSessions((state) => state.byId)
  const visible = rows.filter((row) => targets.allows(row.sessionId) && listed[row.sessionId as SessionId])
  if (!visible.length) return null
  const go = (id: string) => {
    setOpen(false)
    if (read.allows(sessionId) && targets.allows(id)) navigate(id as SessionId)
  }
  if (visible.length === 1) {
    const row = visible[0]!
    return h(
      Button,
      { variant: 'ghost', size: 'sm', onClick: () => go(row.sessionId) },
      t('createdAgentSessionOpen', { agent: row.agent }),
    )
  }
  return h(Menu, {
    open,
    align: 'end',
    portal: true,
    autoFocus: true,
    onClose: () => setOpen(false),
    onSelect: go,
    anchor: h(
      Button,
      { variant: 'ghost', size: 'sm', onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': 'menu' },
      t('createdAgentSessions'),
    ),
    items: visible.map((row) => ({
      id: row.sessionId,
      label: listed[row.sessionId as SessionId]?.title || row.agent + ' · ' + row.model,
    })),
  })
}
