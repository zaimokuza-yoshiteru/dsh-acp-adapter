/**
 * 由插件负责的 ACP 权限请求界面。
 *
 * 权限请求需要用户交互，因此挂载在公开的 `conversation.input.dock`：
 * 每个会话在输入框上方拥有一行全宽区域。组件轮询插件自己的 Remote，
 * 同时续期 broker 的观察者租约；不接管输入框，也不依赖全局状态、模块缓存
 * 或跨会话监听器。
 */
import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpPendingPermissionView, AcpRemoteLike } from '../data/acp-remote.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'
import type { AcpLocaleKey } from './locales.ts'
import css from './AcpPermissionInputDock.module.css'

export interface AcpPermissionInputDockProps {
  /** 由会话级插槽提供的 InputZone 会话快照。 */
  session?: { sessionId?: string | undefined } | undefined
  /** 供测试或适配使用；正式环境通过会话快照取得会话 ID。 */
  sessionId?: string | undefined
  remote?: AcpRemoteLike | undefined
  t?: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined
}

export interface PermissionViewState {
  readonly sessionId: string | undefined
  readonly pending: readonly AcpPendingPermissionView[]
}

/** 切换会话的渲染过程中，不展示上一个会话的请求。 */
export function pendingForSession(
  viewState: PermissionViewState,
  sessionId: string | undefined,
): readonly AcpPendingPermissionView[] {
  return viewState.sessionId === sessionId ? viewState.pending : []
}

/** 本地乐观移除只作用于已经完成响应的请求。 */
export function removePendingPermission(
  pending: readonly AcpPendingPermissionView[],
  requestId: string,
): readonly AcpPendingPermissionView[] {
  return pending.filter((candidate) => candidate.requestId !== requestId)
}

export function optionKindLabel(
  kind: string,
  t: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined,
): string {
  const key = kind === 'allow_once'
    ? 'permissionOptionAllowOnce'
    : kind === 'allow_always'
      ? 'permissionOptionAllowAlways'
      : kind === 'reject_once'
        ? 'permissionOptionRejectOnce'
        : kind === 'reject_always'
          ? 'permissionOptionRejectAlways'
          : 'permissionOptionUnknown'
  const fallback = kind === 'allow_once'
    ? 'Allow once'
    : kind === 'allow_always'
      ? 'Always allow'
      : kind === 'reject_once'
        ? 'Reject once'
        : kind === 'reject_always'
          ? 'Always reject'
          : `Unknown option (${kind})`
  const localized = t?.(key, { kind })
  return localized === undefined || localized.trim() === '' ? fallback : localized
}

/**
 * 与 DSH 原生审批保持同一操作层级：只有可撤销的单次允许是主操作。
 * 持久授权和拒绝都不应通过黑色主按钮诱导用户选择。
 */
export function permissionOptionVariant(kind: string): 'primary' | 'outline' {
  return kind === 'allow_once' ? 'primary' : 'outline'
}

/**
 * Agent owns the option label and may advertise several options with the same
 * ACP kind but different remembered scopes. Preserve that label verbatim so
 * those choices do not collapse into one misleading localized button. The
 * localized kind is only a fallback for a malformed/empty upstream label.
 */
export function permissionOptionText(
  option: AcpPendingPermissionView['options'][number],
  t: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined,
): string {
  return option.name.trim() === '' ? optionKindLabel(option.kind, t) : option.name
}

export type PermissionActionResult =
  | { readonly ok: true; readonly pending: readonly AcpPendingPermissionView[] }
  | { readonly ok: false; readonly message: string }

/** 保留 Agent 给出的精确 optionId，并且只移除对应请求。 */
export async function submitPermissionAnswer(
  remote: AcpRemoteLike,
  sessionId: string,
  pending: readonly AcpPendingPermissionView[],
  item: AcpPendingPermissionView,
  optionId: string,
): Promise<PermissionActionResult> {
  if (remote.answerPermission === undefined) return { ok: false, message: 'permission answer is unavailable' }
  try {
    const result = await remote.answerPermission(sessionId, { requestId: item.requestId, optionId })
    return result.ok
      ? { ok: true, pending: removePendingPermission(pending, item.requestId) }
      : { ok: false, message: result.error.message }
  } catch (reason: unknown) {
    return { ok: false, message: reason instanceof Error ? reason.message : String(reason) }
  }
}

export async function submitPermissionCancel(
  remote: AcpRemoteLike,
  sessionId: string,
  pending: readonly AcpPendingPermissionView[],
  item: AcpPendingPermissionView,
): Promise<PermissionActionResult> {
  if (remote.cancelPermission === undefined) return { ok: false, message: 'permission cancel is unavailable' }
  try {
    const result = await remote.cancelPermission(sessionId, { requestId: item.requestId })
    return result.ok
      ? { ok: true, pending: removePendingPermission(pending, item.requestId) }
      : { ok: false, message: result.error.message }
  } catch (reason: unknown) {
    return { ok: false, message: reason instanceof Error ? reason.message : String(reason) }
  }
}

function sessionOf(props: AcpPermissionInputDockProps): string | undefined {
  return props.sessionId ?? props.session?.sessionId
}

function textOf(
  t: AcpPermissionInputDockProps['t'],
  key: AcpLocaleKey,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const localized = t?.(key, params)
  return localized === undefined || localized.trim() === '' ? fallback : localized
}

/** Product-owned permission explanation localized from structured ACP facts. */
export function permissionReasonText(
  item: AcpPendingPermissionView,
  t?: AcpPermissionInputDockProps['t'],
): string {
  const key: AcpLocaleKey = item.kind === 'execute'
    ? 'permissionReasonExecute'
    : item.kind === 'edit'
      ? 'permissionReasonEdit'
      : item.kind === 'delete'
        ? 'permissionReasonDelete'
        : item.kind === 'move'
          ? 'permissionReasonMove'
          : item.kind === 'read'
            ? 'permissionReasonRead'
            : item.kind === 'fetch'
              ? 'permissionReasonFetch'
              : 'permissionReasonGeneric'
  const lines = [textOf(t, key, 'The Agent requests permission to perform a restricted operation.')]
  if (!item.options.some((option) => option.kind === 'allow_once')) {
    lines.push(textOf(t, 'permissionNoAllowOnce', 'This Agent did not offer an Allow once option. DSH will not promote a one-time choice to permanent access.'))
  }
  if (!item.options.some((option) => option.kind === 'reject_once')) {
    lines.push(textOf(t, 'permissionNoRejectOnce', 'This Agent did not offer a Reject once option.'))
  }
  return lines.join('\n')
}

/** Known ACP operation kinds use product-localized labels; unknown values stay Agent-owned facts. */
export function permissionOperationText(
  kind: string,
  t?: AcpPermissionInputDockProps['t'],
): string {
  const key: AcpLocaleKey | undefined = kind === 'execute'
    ? 'permissionOperationExecute'
    : kind === 'edit'
      ? 'permissionOperationEdit'
      : kind === 'delete'
        ? 'permissionOperationDelete'
        : kind === 'move'
          ? 'permissionOperationMove'
          : kind === 'read'
            ? 'permissionOperationRead'
            : kind === 'fetch'
              ? 'permissionOperationFetch'
              : kind === 'other'
                ? 'permissionOperationOther'
                : undefined
  return key === undefined ? kind : textOf(t, key, kind)
}

/** Visible disclosure for bounded location lists; legacy payloads derive the count when possible. */
export function permissionLocationOmissionText(
  item: AcpPendingPermissionView,
  t?: AcpPermissionInputDockProps['t'],
): string | undefined {
  const shown = item.locations?.length ?? 0
  const omitted = item.omittedLocationCount
    ?? (item.locationCount === undefined ? 0 : Math.max(0, item.locationCount - shown))
  return omitted > 0
    ? textOf(t, 'permissionLocationsOmitted', '{count} more locations omitted', { count: omitted })
    : undefined
}

function PermissionCard({ sessionId, pending, remote, t, onPending }: {
  sessionId: string
  pending: readonly AcpPendingPermissionView[]
  remote: AcpRemoteLike
  t?: ((key: AcpLocaleKey, params?: Record<string, string | number>) => string) | undefined
  onPending: (next: readonly AcpPendingPermissionView[]) => void
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messageOf = (key: 'permissionRequestFailed' | 'permissionCancelFailed', message: string): string =>
    t === undefined ? message : localizedDiagnostic(t, key, message)

  const answer = (item: AcpPendingPermissionView, optionId: string): void => {
    setError(null)
    setBusy(item.requestId + '\u0000' + optionId)
    void submitPermissionAnswer(remote, sessionId, pending, item, optionId).then((result) => {
      if (result.ok) onPending(result.pending)
      else setError(messageOf('permissionRequestFailed', result.message))
    }).finally(() => setBusy(null))
  }

  const cancel = (item: AcpPendingPermissionView): void => {
    setError(null)
    setBusy(item.requestId + '\u0000cancel')
    void submitPermissionCancel(remote, sessionId, pending, item).then((result) => {
      if (result.ok) onPending(result.pending)
      else setError(messageOf('permissionCancelFailed', result.message))
    }).finally(() => setBusy(null))
  }

  return h('div', { className: css.root },
    h('section', {
      className: css.card,
      role: 'region',
      'aria-label': textOf(t, 'permissionTitle', 'Agent permission request'),
    },
      h('div', { className: css.strip }, h('span', { className: css.dot, 'aria-hidden': true }), textOf(t, 'permissionWaiting', 'Waiting for an Agent permission choice')),
      error === null ? null : h('div', { className: css.error, role: 'alert' }, error),
      pending.map((item) => h('div', { key: item.requestId, className: css.request },
        h('div', { className: css.body, tabIndex: 0, role: 'group', 'aria-label': textOf(t, 'permissionDetails', 'Permission details') },
          h('strong', { className: css.headline }, item.title),
          h('div', { className: css.reason }, permissionReasonText(item, t)),
          h('details', { className: css.details },
            h('summary', { className: css.detailsSummary }, textOf(t, 'permissionDetails', 'Details')),
            h('dl', { className: css.detailList },
              item.agentName === undefined && item.agentId === undefined ? null : h('div', null,
                h('dt', null, textOf(t, 'permissionAgent', 'Agent')),
                h('dd', null, [item.agentName, item.agentId === undefined ? undefined : ` (${item.agentId})`].filter(Boolean).join('')),
              ),
              // ACP 允许 Agent 不提供 kind。缺失时隐藏这一行，不把协议空缺
              // 包装成对用户没有帮助的技术值 "unknown"；标题、命令与位置仍保留。
              item.kind === 'unknown' ? null : h('div', null,
                h('dt', null, textOf(t, 'permissionOperation', 'Operation')),
                h('dd', null, permissionOperationText(item.kind, t)),
              ),
              h('div', null, h('dt', null, textOf(t, 'permissionToolCall', 'Tool call')), h('dd', null, item.toolCallId)),
              item.locations === undefined || (item.locations.length === 0 && permissionLocationOmissionText(item, t) === undefined) ? null : h('div', null,
                h('dt', null, textOf(t, 'permissionLocations', 'Locations')),
                h('dd', null, [
                  ...(item.locations ?? []).map((location) => h('code', {
                    key: `${location.path}:${location.line ?? ''}`,
                    title: location.path,
                  }, `${location.displayPath ?? location.path}${location.line === undefined ? '' : `:${String(location.line)}`}`)).reduce<ReactNode[]>((all, node, index) => index === 0 ? [node] : [...all, ' · ', node], []),
                  permissionLocationOmissionText(item, t) === undefined
                    ? null
                    : ` · ${permissionLocationOmissionText(item, t)}`,
                ]),
              ),
              item.inputSummary === undefined ? null : h('div', null,
                h('dt', null, textOf(t, 'permissionInputSummary', 'Input summary')), h('dd', null, item.inputSummary),
              ),
              item.command === undefined ? null : h('div', null,
                h('dt', null, textOf(t, 'permissionCommand', 'Command')),
                h('dd', null, h('pre', { className: css.command }, item.command)),
              ),
            ),
          ),
        ),
        h('div', { className: css.actionRow },
          h('div', { className: css.options }, item.options.map((option) => h(Button, {
            className: option.kind.startsWith('reject') ? `${css.option} ${css.reject}` : css.option,
            key: option.optionId,
            type: 'button',
            variant: permissionOptionVariant(option.kind),
            disabled: busy !== null,
            onClick: () => answer(item, option.optionId),
            title: option.name,
            'data-acp-option-id': option.optionId,
          }, permissionOptionText(option, t))),
          ),
          h(Button, { className: css.cancel, variant: 'ghost', type: 'button', disabled: busy !== null, onClick: () => cancel(item) }, textOf(t, 'permissionCancel', 'Cancel request')),
        ),
      )),
    ),
  )
}

/** 在会话级全宽输入区域中渲染 broker 的待处理请求。 */
export function AcpPermissionInputDock(props: AcpPermissionInputDockProps): ReactNode {
  const sessionId = sessionOf(props)
  const remote = props.remote
  const [viewState, setViewState] = useState<PermissionViewState>({ sessionId, pending: [] })
  const pending = pendingForSession(viewState, sessionId)

  useEffect(() => {
    let disposed = false
    setViewState({ sessionId, pending: [] })
    if (sessionId === undefined || remote?.pendingPermissions === undefined) return
    const refresh = (): void => {
      void remote.pendingPermissions?.(sessionId).then((result) => {
        if (!disposed && result.ok) setViewState({ sessionId, pending: result.value })
      }).catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 750)
    return () => { disposed = true; clearInterval(timer) }
  }, [remote, sessionId])

  if (sessionId === undefined || remote === undefined || pending.length === 0) return null
  return h(PermissionCard, {
    key: sessionId,
    sessionId,
    pending,
    remote,
    t: props.t,
    onPending: (next) => setViewState((current) => current.sessionId === sessionId ? { sessionId, pending: next } : current),
  })
}

export function createAcpPermissionInputDock(remote: AcpRemoteLike): (props: AcpPermissionInputDockProps) => ReactNode {
  return (props) => h(AcpPermissionInputDock, { ...props, remote })
}
