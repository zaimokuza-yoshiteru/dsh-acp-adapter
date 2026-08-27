/** 会话级 ACP v1 表单与 URL 补充信息请求界面。 */
import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpElicitationAnswerRequest, AcpPendingElicitationView } from '../data/acp-remote.ts'
import type { AcpRemoteLike } from '../data/acp-remote.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpElicitationInputDock.module.css'

export interface AcpElicitationInputDockProps {
  session?: { sessionId?: string | undefined } | undefined
  sessionId?: string | undefined
  remote?: AcpRemoteLike | undefined
  t?: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined
}

type Value = string | number | boolean | readonly string[]

export interface ElicitationViewState {
  readonly sessionId: string | undefined
  readonly pending: readonly AcpPendingElicitationView[]
}

/** 切换会话的渲染过程中，不展示上一个会话的请求。 */
export function pendingElicitationsForSession(viewState: ElicitationViewState, sessionId: string | undefined): readonly AcpPendingElicitationView[] {
  return viewState.sessionId === sessionId ? viewState.pending : []
}

function toValues(values: Record<string, Value>): readonly { readonly name: string; readonly value: Value }[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }))
}

function textOf(t: AcpElicitationInputDockProps['t'], key: AcpLocaleKey, fallback: string, params?: Record<string, string | number>): string {
  const localized = t?.(key, params)
  return localized === undefined || localized.trim() === '' ? fallback : localized
}

function Card({ sessionId, item, remote, t, onDone }: { sessionId: string; item: AcpPendingElicitationView; remote: AcpRemoteLike; t: AcpElicitationInputDockProps['t']; onDone: () => void }): ReactNode {
  const [values, setValues] = useState<Record<string, Value>>(() => Object.fromEntries(item.fields.flatMap((field) => {
    if (field.defaultValue !== undefined) return [[field.name, field.defaultValue as Value]]
    if (field.type === 'boolean') return [[field.name, false]]
    return []
  })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setValue = (name: string, value: Value): void => setValues((current) => ({ ...current, [name]: value }))
  const answer = (action: AcpElicitationAnswerRequest['action']): void => {
    setBusy(true); setError(null)
    const request: AcpElicitationAnswerRequest = action === 'accept'
      ? { requestId: item.requestId, action, values: toValues(values) }
      : { requestId: item.requestId, action }
    void remote.answerElicitation?.(sessionId, request).then((result) => {
      if (result === undefined || result.ok) onDone()
      else setError(t === undefined
        ? result.error.message
        : localizedDiagnostic(t, 'elicitationRequestFailed', result.error.message))
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(t === undefined ? message : localizedDiagnostic(t, 'elicitationRequestFailed', message))
    }).finally(() => setBusy(false))
  }
  const openUrl = (): void => {
    if (item.url === undefined) return
    // 只响应用户明确点击，不使用可能预取的链接，也不自动弹出窗口。
    window.open(item.url, '_blank', 'noopener,noreferrer')
    answer('accept')
  }
  return h('section', { className: css.card, role: 'region', 'aria-label': textOf(t, 'elicitationTitle', 'Agent input request') },
    h('div', { className: css.title }, item.mode === 'form'
      ? textOf(t, 'elicitationFormTitle', 'Agent asks for information')
      : textOf(t, 'elicitationUrlTitle', 'Agent asks you to continue in a browser')),
    h('div', { className: css.message }, item.message),
    item.mode === 'url' ? h('div', { className: css.urlRow },
      h('code', { className: css.url }, item.url),
      h(Button, { type: 'button', variant: 'primary', disabled: busy, onClick: openUrl }, textOf(t, 'elicitationOpenUrl', 'Open URL')),
    ) : h('form', {
      onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); answer('accept') },
    }, h('div', { className: css.fields }, item.fields.map((field) => h('label', { key: field.name, className: css.field },
      h('span', { className: css.label }, `${field.title ?? field.name}${field.required ? ' *' : ''}`),
      field.description === undefined ? null : h('span', { className: css.description }, field.description),
      field.options === undefined ? h('input', {
        className: css.input,
        type: field.type === 'boolean' ? 'checkbox'
          : field.type === 'number' || field.type === 'integer' ? 'number'
            : field.format === 'email' ? 'email'
              : field.format === 'uri' ? 'url'
                : field.format === 'date' ? 'date'
                  : 'text',
        step: field.type === 'integer' ? 1 : undefined,
        required: field.required,
        defaultValue: typeof field.defaultValue === 'string' || typeof field.defaultValue === 'number' ? field.defaultValue : undefined,
        defaultChecked: typeof field.defaultValue === 'boolean' ? field.defaultValue : undefined,
        min: field.minimum,
        max: field.maximum,
        onChange: (event: { target: { value: string; checked: boolean } }) => setValue(field.name, field.type === 'boolean' ? event.target.checked : field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value),
      }) : h('select', { className: css.input, multiple: field.type === 'array', required: field.required, defaultValue: field.type === 'array' && Array.isArray(field.defaultValue) ? field.defaultValue : undefined, onChange: (event: { target: { value: string; selectedOptions?: { length: number; [index: number]: { value: string } } } }) => setValue(field.name, field.type === 'array' ? Array.from({ length: event.target.selectedOptions?.length ?? 0 }, (_, index) => event.target.selectedOptions?.[index]?.value ?? '') : event.target.value) },
        field.type === 'array' ? null : h('option', { value: '' }, textOf(t, 'elicitationSelect', 'Select…')), field.options.map((option) => h('option', { key: option.value, value: option.value }, option.title ?? option.value)),
      ),
    ))),
    error === null ? null : h('div', { className: css.error, role: 'alert' }, error),
    h('div', { className: css.actions },
      h(Button, { type: 'submit', variant: 'primary', disabled: busy }, textOf(t, 'elicitationSubmit', 'Submit')),
      h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => answer('decline') }, textOf(t, 'elicitationDecline', 'Decline')),
      h(Button, { type: 'button', variant: 'ghost', disabled: busy, onClick: () => answer('cancel') }, textOf(t, 'elicitationCancel', 'Cancel')),
    )),
    item.mode === 'url' && error !== null ? h('div', { className: css.error, role: 'alert' }, error) : null,
    item.mode === 'url' ? h('div', { className: css.actions },
      h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => answer('decline') }, textOf(t, 'elicitationDecline', 'Decline')),
      h(Button, { type: 'button', variant: 'ghost', disabled: busy, onClick: () => answer('cancel') }, textOf(t, 'elicitationCancel', 'Cancel')),
    ) : null,
  )
}

export function AcpElicitationInputDock({ session, sessionId: explicitSessionId, remote, t }: AcpElicitationInputDockProps): ReactNode {
  const sessionId = explicitSessionId ?? session?.sessionId
  const [viewState, setViewState] = useState<ElicitationViewState>({ sessionId, pending: [] })
  const pending = pendingElicitationsForSession(viewState, sessionId)
  useEffect(() => {
    let disposed = false
    setViewState({ sessionId, pending: [] })
    if (sessionId === undefined || remote?.pendingElicitations === undefined) return
    const refresh = (): void => { void remote.pendingElicitations?.(sessionId).then((result) => { if (!disposed && result.ok) setViewState({ sessionId, pending: result.value }) }).catch(() => undefined) }
    refresh(); const timer = setInterval(refresh, 750)
    return () => { disposed = true; clearInterval(timer) }
  }, [remote, sessionId])
  if (sessionId === undefined || remote === undefined || pending.length === 0) return null
  return h('div', { className: css.root }, pending.map((item) => h(Card, {
    key: item.requestId,
    sessionId,
    item,
    remote,
    t,
    onDone: () => setViewState((current) => current.sessionId === sessionId
      ? { sessionId, pending: current.pending.filter((candidate) => candidate.requestId !== item.requestId) }
      : current),
  })))
}

export function createAcpElicitationInputDock(remote: AcpRemoteLike): (props: AcpElicitationInputDockProps) => ReactNode {
  return (props) => h(AcpElicitationInputDock, { ...props, remote })
}
