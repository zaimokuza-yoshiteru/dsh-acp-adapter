import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { crossBackendSelectionLabel } from './CrossBackendModal.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useSessionActionAccess, type SessionAccessSource } from './session-action-access.ts'
import type { AcpHandoffView } from '../../contract/handoff.ts'
import type { HandoffFields, SessionHandoffClient } from '../coordinator/session-handoff.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './SessionHandoff.module.css'

type HandoffProps = PropsLocale<'acpActivity'> & {
  client: SessionHandoffClient
  sessionId: string
}

function useRecord(client: SessionHandoffClient, sessionId: string) {
  return useSyncExternalStore(client.subscribe, () => client.get(sessionId))
}

function errorKey(error: unknown): AcpLocaleKey {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (code === 'session/model-unavailable') return 'handoffTargetUnavailable'
  if (code === 'session/agent-busy') {
    const details = error instanceof Error && 'details' in error ? error.details : undefined
    return details && typeof details === 'object' && 'reason' in details && details.reason === 'HANDOFF_STALE_DRAFT'
      ? 'handoffDraftChanged'
      : 'handoffSessionChanged'
  }
  if (code === 'dsh-acp/user-rejected' || code === 'remote-access/denied') return 'handoffForbidden'
  return 'handoffCheckStatus'
}

export function HandoffDock({
  client,
  sessionId,
  useAccess,
  useSessionRetainInfo,
  useSessions,
  access,
  t,
}: HandoffProps & PropsRuntime<'conversation.input.dock'> & { access: SessionAccessSource }): ReactNode {
  const main = useSessionRetainInfo((info) => (info?.retainedBy.mainView ?? 0) > 0)
  const canRead = useAccess('dshAcp/handoff')
  const record = useRecord(client, sessionId)
  const endpoints = record?.destinationSessionId ? [record.sourceSessionId, record.destinationSessionId] : [sessionId]
  const readable = useSessionActionAccess(access, endpoints, 'session/events')
  const allowed = canRead && endpoints.every((id) => readable.allows(id))
  const connection = useSyncExternalStore(client.subscribe, client.connectionVersion)
  const related = record?.sourceSessionId === sessionId ? record.destinationSessionId : record?.sourceSessionId
  const relatedListed = useSessions((state) => !!related && Boolean(state.byId[related as SessionId]))
  const [error, setError] = useState<AcpLocaleKey>()
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState<string>()
  const phase = record?.phase
  const polling = phase === 'queued' || (record?.phase === 'summarizing' && !client.followsSummary(record.id))
  useEffect(() => {
    if (!allowed) {
      client.forget(client.get(sessionId))
      return
    }
    if (!main) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        await client.refresh(sessionId)
        if (current) setError(undefined)
      } catch (err) {
        if (current && client.get(sessionId)) setError(errorKey(err))
      } finally {
        if (current && polling)
          timer = setTimeout(() => {
            void refresh()
          }, 1200)
      }
    }
    const refocus = () => {
      if (document.visibilityState !== 'hidden') void client.refresh(sessionId).catch(() => {})
    }
    window.addEventListener('focus', refocus)
    void refresh()
    return () => {
      window.removeEventListener('focus', refocus)
      current = false
      clearTimeout(timer)
    }
  }, [client, sessionId, allowed, main, polling, connection, relatedListed])

  if (!main || !allowed || !record || phase === 'cancelled' || (phase === 'interrupted' && dismissed === record.id))
    return null
  const source = record.sourceSessionId === sessionId
  const act = async (action: () => Promise<void> | void) => {
    setBusy(true)
    try {
      await action()
      setError(undefined)
    } catch (err) {
      const key = errorKey(err)
      setError(key === 'handoffDraftChanged' && source ? 'handoffSourceDraftChanged' : key)
    } finally {
      setBusy(false)
    }
  }
  if (phase === 'completed') return null
  if (!source && phase === 'draft') return null
  const status =
    phase === 'summarizing'
      ? 'handoffSummarizing'
      : phase === 'interrupted'
        ? 'handoffInterrupted'
        : phase === 'queued'
          ? 'handoffQueued'
          : source && phase === 'draft'
            ? 'handoffReady'
            : null
  return h(
    'div',
    { className: css.dock, 'data-acp-handoff': phase },
    status ? h('span', { role: 'status' }, t(status)) : null,
    source && phase === 'interrupted' && record.document
      ? h(
          'details',
          { className: css.retainedDocument },
          h('summary', null, t('handoffDocument')),
          h('textarea', {
            className: css.document,
            rows: 4,
            'aria-label': t('handoffDocument'),
            value: record.document,
            readOnly: true,
          }),
        )
      : null,
    phase === 'summarizing' || phase === 'interrupted' || (source && phase === 'draft')
      ? h(
          Button,
          {
            variant: phase === 'draft' ? 'ghost' : 'outline',
            size: 'sm',
            disabled: busy,
            onClick: () => {
              if (phase === 'interrupted') setDismissed(record.id)
              else
                void act(async () => {
                  try {
                    await client.change(sessionId, {
                      kind: 'cancel',
                      id: record.id,
                      ...(phase === 'draft' ? { revision: record.revision } : {}),
                    })
                  } catch (err) {
                    await client.refresh(sessionId).catch(() => {})
                    throw err
                  }
                })
            },
          },
          t(
            phase === 'interrupted'
              ? 'crossBackendDismiss'
              : phase === 'draft'
                ? 'handoffDiscard'
                : 'crossBackendCancel',
          ),
        )
      : null,
    error && h('span', { role: 'alert', className: css.error }, t(error)),
  )
}

type EditorProps = HandoffProps & {
  loadModelCatalog(): Promise<ModelCatalog | null>
  profileName(provider: string): string | undefined
}

export function HandoffComposer(props: EditorProps): ReactNode {
  const record = useRecord(props.client, props.sessionId)
  if (!record || record.phase !== 'draft' || record.destinationSessionId !== props.sessionId) return null
  return h(Draft, { ...props, record, key: record.id })
}

function Draft({
  client,
  sessionId,
  record,
  t,
  loadModelCatalog,
  profileName,
}: EditorProps & { record: AcpHandoffView }): ReactNode {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  useEffect(() => {
    let current = true
    void loadModelCatalog().then(
      (value) => {
        if (current) setCatalog(value)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [loadModelCatalog])
  const targetName = crossBackendSelectionLabel(record.target, catalog, profileName(record.target.provider), t)
  const [fields, setFields] = useState<HandoffFields>(() => ({
    document: record.document,
    instruction: record.instruction,
    allowHistory: record.allowHistory,
  }))
  const pending = useRef<HandoffFields | null>(null)
  const revision = useRef(record.revision)
  const alive = useRef(true)
  const saving = useRef(0)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<AcpLocaleKey>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const save = async () => {
    clearTimeout(timer.current)
    const edits = pending.current
    if (!edits) return true
    if (submitting.current) return false
    const number = ++saving.current
    if (alive.current) setError(undefined)
    try {
      await client.change(sessionId, { kind: 'save', id: record.id, revision: revision.current, ...edits }, revision)
      if (pending.current === edits) pending.current = null
      return true
    } catch (err) {
      if (alive.current && saving.current === number)
        setError(errorKey(err) === 'handoffDraftChanged' ? 'handoffDraftChanged' : 'handoffSaveFailed')
      return false
    }
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const saved = client.get(sessionId)
      if (saved?.id === record.id && saved.phase === 'draft') void save()
      else clearTimeout(timer.current)
    }
  }, [client, sessionId, record.id])
  function edit(changes: Partial<HandoffFields>) {
    const next = { ...fields, ...changes }
    pending.current = next
    setFields(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(save, 350)
  }
  const finish = async (kind: 'send' | 'cancel') => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    clearTimeout(timer.current)
    try {
      if (kind === 'send')
        await client.change(sessionId, { kind, id: record.id, revision: revision.current, ...fields }, revision)
      else await client.change(sessionId, { kind, id: record.id, revision: revision.current }, revision)
      pending.current = null
    } catch (err) {
      // An interrupted reply can follow an accepted prompt. Read its durable state before offering Send again.
      await client.refresh(sessionId).catch(() => {})
      if (alive.current) setError(errorKey(err))
    } finally {
      submitting.current = false
      if (alive.current) setBusy(false)
    }
  }
  const reload = async () => {
    setBusy(true)
    try {
      await client.refresh(sessionId)
      const saved = client.get(sessionId)
      if (!alive.current || !saved || saved.id !== record.id || saved.phase !== 'draft') return
      pending.current = null
      revision.current = saved.revision
      setFields({ document: saved.document, instruction: saved.instruction, allowHistory: saved.allowHistory })
      setError(undefined)
    } catch (err) {
      if (alive.current) setError(errorKey(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return h(
    'form',
    {
      className: css.editor,
      'data-acp-handoff-editor': '',
      onSubmit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (fields.document.trim()) void finish('send')
      },
    },
    h('div', { className: css.header }, h('strong', null, t('handoffRecipient', { target: targetName }))),
    h('textarea', {
      'aria-label': t('handoffDocument'),
      className: css.document,
      rows: 5,
      maxLength: 65536,
      value: fields.document,
      disabled: busy,
      onChange: (e: ChangeEvent<HTMLTextAreaElement>) => edit({ document: e.target.value }),
    }),
    h(
      'label',
      { className: css.task },
      t('handoffTask'),
      h('textarea', {
        className: css.instruction,
        rows: 2,
        maxLength: 32768,
        value: fields.instruction,
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => edit({ instruction: e.target.value }),
      }),
    ),
    h(
      'label',
      { className: css.history },
      h('input', {
        type: 'checkbox',
        checked: fields.allowHistory,
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => edit({ allowHistory: e.target.checked }),
      }),
      t('handoffAllowHistory'),
    ),

    error &&
      h(
        'p',
        { role: 'alert', className: css.error },
        t(error),
        error === 'handoffDraftChanged'
          ? h(
              Button,
              {
                size: 'sm',
                disabled: busy,
                onClick: () => {
                  void reload()
                },
              },
              t('handoffReload'),
            )
          : error === 'handoffSaveFailed'
            ? h(Button, { size: 'sm', disabled: busy, onClick: () => void save() }, t('handoffRetrySave'))
            : null,
      ),
    h(
      'div',
      { className: css.actions },
      h(
        Button,
        {
          variant: 'ghost',
          disabled: busy,
          onClick: () => {
            void finish('cancel')
          },
        },
        t('handoffDiscard'),
      ),
      h(Button, { variant: 'primary', type: 'submit', disabled: busy || !fields.document.trim() }, t('handoffSend')),
    ),
  )
}
