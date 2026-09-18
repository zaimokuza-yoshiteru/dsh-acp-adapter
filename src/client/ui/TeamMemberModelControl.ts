import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpRemoteLike, AcpTeamMemberModelsView, AcpTeamMemberView } from '../data/acp-remote.ts'
import css from './AcpTeamManagement.module.css'
import agentControlCss from './AcpAgentControl.module.css'

type Copy = PropsLocale<'acpActivity'>['t']
type Model = { readonly id: string; readonly name: string }
type ModelView = AcpTeamMemberModelsView

type Props = {
  readonly lead: SessionId
  readonly member: AcpTeamMemberView
  readonly initialModel: string | null
  readonly sessionReady: boolean
  readonly remote: AcpRemoteLike
  readonly t: Copy
  readonly isCurrent: (sessionId: SessionId) => boolean
  readonly onMenuOpen: (value: boolean) => void
}
type MemberModelFacts = AcpTeamMemberView

export function reconcileMemberModelView(previous: ModelView | null, member: MemberModelFacts): ModelView | null {
  if (previous === null) return null
  return {
    ...previous,
    currentModel: member.model ?? previous.currentModel,
    pendingModel: member.pendingModel === undefined ? previous.pendingModel : member.pendingModel,
    writable: member.modelWritable ?? previous.writable,
  }
}

function modelName(models: readonly Model[], id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null
  return models.find(model => model.id === id)?.name ?? id
}

/** Resolve display names when the member card mounts, so the trigger, menu
 * and pending notice use the same catalog even before the first click. */
export function TeamMemberModelControl({ lead, member, initialModel, sessionReady, remote, t, isCurrent, onMenuOpen }: Props): ReactNode {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ModelView | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const factsRevision = useRef(0)
  const mutationSeq = useRef(0)
  const alive = useRef(true)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const writeInFlight = useRef(false)
  const latestMember = useRef(member)
  latestMember.current = member

  const memberFacts = member
  const canWrite = !saving && (member.status === 'idle' || member.status === 'inactive')
    && (memberFacts.modelWritable ?? view?.writable ?? false)
  const pendingModel = view === null ? member.pendingModel ?? null : view.pendingModel
  const currentModel = view?.currentModel ?? initialModel ?? member.model
  const selectedModel = pendingModel ?? currentModel

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; ++epoch.current }
  }, [])
  useEffect(() => {
    ++epoch.current
    setOpen(false)
    setView(null)
    setError(null)
    setLoading(false)
    setSaving(false)
    writeInFlight.current = false
    ++factsRevision.current
  }, [lead, member.sessionId])
  useEffect(() => {
    ++factsRevision.current
    setView(previous => reconcileMemberModelView(previous, memberFacts))
  }, [member.model, member.pendingModel, memberFacts.modelWritable])
  useEffect(() => { onMenuOpen(open); return () => onMenuOpen(false) }, [open, onMenuOpen])

  useEffect(() => {
    // Native team membership precedes the child's durable ACP binding. The
    // session stream tells us when ownership-checked catalog reads are ready.
    if (member.profileId === null || !sessionReady) return
    let disposed = false
    const currentEpoch = epoch.current
    const currentFactsRevision = factsRevision.current
    setLoading(true)
    setError(null)
    void remote.teamMemberModels(lead, member.sessionId).then(result => {
      if (disposed || !alive.current || currentEpoch !== epoch.current || !isCurrent(lead)) return
      if (!result.ok) { setError(result.error.message); return }
      setView(currentFactsRevision === factsRevision.current ? result.value : reconcileMemberModelView(result.value, latestMember.current))
    }).catch(reason => {
      if (!disposed && alive.current && currentEpoch === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!disposed && alive.current && currentEpoch === epoch.current) setLoading(false)
    })
    return () => { disposed = true }
  }, [lead, member.sessionId, member.profileId, sessionReady, remote, isCurrent, catalogRetry])

  const toggle = (): void => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (view === null && error !== null && !loading) setCatalogRetry(value => value + 1)
  }

  const models = view?.models ?? []
  const items = loading && view === null
    ? [{ id: '__loading__', label: t('teamModelLoading'), disabled: true }]
    : error !== null && view === null
      ? [{ id: '__error__', label: t('teamModelLoadFailed'), disabled: true }]
      : models.length === 0
        ? [{ id: '__empty__', label: t('teamModelEmpty'), disabled: true }]
        : models.map(model => ({ id: model.id, label: model.name, disabled: !canWrite }))
  const disabled = member.profileId === null || !sessionReady
  const selectedLabel = modelName(view?.models ?? [], selectedModel) ?? selectedModel ?? t('teamModelUnknown')
  const currentLabel = modelName(view?.models ?? [], currentModel) ?? currentModel ?? t('teamModelUnknown')

  const choose = (id: string): void => {
    if (id.startsWith('__') || !canWrite || writeInFlight.current || !isCurrent(lead)) return
    const chosen = (view?.models ?? []).find(model => model.id === id)
    if (chosen === undefined) return
    const currentEpoch = epoch.current
    const currentFactsRevision = factsRevision.current
    const currentMutation = ++mutationSeq.current
    const previous = pendingModel
    writeInFlight.current = true
    setSaving(true)
    setView(previousView => previousView === null ? previousView : { ...previousView, pendingModel: id })
    setError(null)
    setOpen(false)
    void remote.setTeamMemberModel(lead, member.sessionId, id).then(result => {
      if (!alive.current || currentEpoch !== epoch.current || currentFactsRevision !== factsRevision.current || currentMutation !== mutationSeq.current || !isCurrent(lead)) return
      if (!result.ok) {
        setView(previousView => previousView === null ? previousView : { ...previousView, pendingModel: previous })
        setError(result.error.message)
        return
      }
      setView(result.value)
    }).catch(reason => {
      if (alive.current && currentEpoch === epoch.current && currentFactsRevision === factsRevision.current && currentMutation === mutationSeq.current) {
        setView(previousView => previousView === null ? previousView : { ...previousView, pendingModel: previous })
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (alive.current && currentEpoch === epoch.current) {
        writeInFlight.current = false
        setSaving(false)
      }
    })
  }

  return h('div', { className: css.modelControl, 'data-acp-member-model': member.sessionId },
    h(Menu, {
      portal: true,
      autoFocus: true,
      open,
      side: 'bottom',
      align: 'end',
      onClose: () => setOpen(false),
      items,
      selectedId: selectedModel ?? undefined,
      onSelect: choose,
      anchor: h('button', {
        type: 'button',
        className: agentControlCss.trigger,
        disabled,
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-label': t('teamModelChoose', { name: member.name }),
        onClick: toggle,
      },
      h('span', { className: agentControlCss.triggerLabel }, selectedLabel),
      h(IconChevronDownOutline14, { className: `${agentControlCss.chevron}${open ? ` ${agentControlCss.chevronOpen}` : ''}` })),
    }),
    h('div', { className: css.settingNotice, 'data-member-model-notice': '', role: 'status' },
      error !== null
        ? h('span', { className: css.noticeError, title: error }, error)
        : pendingModel === null || pendingModel === currentModel ? null
          : h('span', { title: t('teamMemberModelPending', { model: currentLabel }) }, t('teamMemberModelPending', { model: currentLabel }))),
  )
}
