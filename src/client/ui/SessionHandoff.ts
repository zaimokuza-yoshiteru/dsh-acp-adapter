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
import type { AcpHandoffView } from '../../contract/handoff.ts'
import type { HandoffFields, SessionHandoffClient } from '../coordinator/session-handoff.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './SessionHandoff.module.css'

type HandoffProps = PropsLocale<'acpActivity'> & {
  client: SessionHandoffClient
  sessionId: string
  openSession(id: string): void
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
  openSession,
  sessionId,
  useAccess,
  useSessionRetainInfo,
  t,
}: HandoffProps & PropsRuntime<'conversation.input.dock'>): ReactNode {
  const main = useSessionRetainInfo((info) => (info?.retainedBy.mainView ?? 0) > 0)
  const canRead = useAccess('dshAcp/handoff')
  const record = useRecord(client, sessionId)
  const [error, setError] = useState<AcpLocaleKey>()
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState<string>()
  const phase = record?.phase
  const polling = phase === 'summarizing' || phase === 'queued'
  useEffect(() => {
    if (!main || !canRead) return
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
    void refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [client, sessionId, canRead, main, polling])

  if (!main || !canRead || !record || phase === 'cancelled' || (phase === 'interrupted' && dismissed === record.id))
    return null
  const source = record.sourceSessionId === sessionId
  const other = source ? record.destinationSessionId : record.sourceSessionId
  const act = async (action: () => Promise<void> | void) => {
    setBusy(true)
    try {
      await action()
      setError(undefined)
    } catch (err) {
      setError(errorKey(err))
    } finally {
      setBusy(false)
    }
  }
  // Completed sources keep their ordinary chat. The destination retains a link to its origin.
  if (source && phase === 'completed') return null
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
    other &&
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          disabled: busy,
          onClick: () => {
            void act(() => openSession(other))
          },
        },
        t(source ? 'handoffOpenDraft' : 'handoffOpenSource'),
      ),
    phase === 'summarizing' || phase === 'interrupted'
      ? h(
          Button,
          {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: () => {
              if (phase === 'interrupted') setDismissed(record.id)
              else void act(() => client.change(sessionId, { kind: 'cancel', id: record.id }))
            },
          },
          t(phase === 'interrupted' ? 'crossBackendDismiss' : 'crossBackendCancel'),
        )
      : null,
    error && h('span', { role: 'alert', className: css.error }, t(error)),
  )
}

export function HandoffComposer(props: HandoffProps): ReactNode {
  const record = useRecord(props.client, props.sessionId)
  if (!record || record.phase !== 'draft' || record.destinationSessionId !== props.sessionId) return null
  return h(Draft, { ...props, record, key: record.id })
}

function Draft({ client, sessionId, openSession, record, t }: HandoffProps & { record: AcpHandoffView }): ReactNode {
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
  const save = () => {
    clearTimeout(timer.current)
    const edits = pending.current
    if (!edits || submitting.current) return
    const number = ++saving.current
    void client
      .change(sessionId, { kind: 'save', id: record.id, revision: revision.current, ...edits }, revision)
      .then(() => {
        if (pending.current === edits) pending.current = null
        if (alive.current && saving.current === number) setError(undefined)
      })
      .catch((err) => {
        if (alive.current && saving.current === number)
          setError(errorKey(err) === 'handoffDraftChanged' ? 'handoffDraftChanged' : 'handoffSaveFailed')
      })
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      save()
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
      else await client.change(sessionId, { kind, id: record.id })
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
    h(
      'div',
      { className: css.header },
      h('strong', null, t('handoffDocument')),
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            try {
              openSession(record.sourceSessionId)
            } catch {
              setError('crossBackendFailureOpen')
            }
          },
        },
        t('handoffOpenSource'),
      ),
    ),
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
      { className: css.history },
      h('input', {
        type: 'checkbox',
        checked: fields.allowHistory,
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => edit({ allowHistory: e.target.checked }),
      }),
      t('handoffAllowHistory'),
    ),
    h('textarea', {
      'aria-label': t('handoffTask'),
      placeholder: t('handoffTask'),
      className: css.instruction,
      rows: 2,
      maxLength: 32768,
      disabled: busy,
      value: fields.instruction,
      onChange: (e: ChangeEvent<HTMLTextAreaElement>) => edit({ instruction: e.target.value }),
    }),
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
