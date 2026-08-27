/**
 * The ACP settings section component tree.
 *
 * Thin presentation only: every decision (validation, parsing, health/login
 * derivation, CRUD semantics) lives in logic.ts, and every side effect
 * (settings writes, dshAcp Remote calls) in controller.ts. Components
 * receive the `t`/`useStore`/`panel` inject face and keep only interactive
 * state (open editor, staged draft text, delete confirmation, busy flags) —
 * the ModelsSection/CustomProviderCard precedent. : state rides the
 * entry's store seat (`useStore` over AcpPanelSnapshot; the PropsStore
 * `actions` share is the glue-only write set, unused here); the wire
 * callbacks arrive as the `panel` member so the reserved PropsStore `actions`
 * seat is never shadowed. Written with createElement because the frozen
 * tsconfig has no `jsx` option (see react.d.ts); classes come from
 * AcpSection.module.css ( CSS Modules).
 * @module @zaimokuza/dsh-acp-adapter/client/AcpSection
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ACP_BUILTIN_AGENT_TEMPLATES,
  draftFromAgent,
  draftFromTemplate,
  dropMaskedEnvKey,
  emptyDraft,
  errorMessageOf,
  healthRowOf,
  sortedAgentIds,
  validateAgentDraft,
} from '../data/logic.ts'
import type { AcpAgentConfig, AcpProviderHealth, AgentDraft, DraftError } from '../data/logic.ts'
import type { AcpLocaleKey } from './locales.ts'
import type { AcpPanelSnapshot, HealthState } from '../data/stores/panel-store.ts'
import css from './AcpSection.module.css'

/** The section's translate seat (slot renderer binds it from the entry's `locale` declaration). */
export type AcpTranslate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

/** The framework-synthesized selector hook over the entry's store (PropsStore share). */
export type UsePanelStore = <S>(selector: (snapshot: AcpPanelSnapshot) => S, equal?: (a: S, b: S) => boolean) => S

/** The controller wire handed to the section (bound in apply; plain callbacks). */
export interface AcpSectionWire {
 /** recheck = true 即「重新检查」（收尾：丢弃 probe 缓存并重探）；省略 = 只读缓存视图。 */
  refreshHealth(recheck?: boolean): void
  refreshAgentHealth(agentId: string): void
  saveAgent(editingId: string | undefined, draft: AgentDraft): Promise<string | undefined>
  deleteAgent(id: string): Promise<string | undefined>
  /**
 * 删除确认提示：该 profile 的既有会话 binding 计数；undefined = 计数不可
   * 得（RPC 失败/畸形），确认块退回无计数的基础文案（不冒充 0）。
   */
  countBoundSessions(id: string): Promise<number | undefined>
}

/** Injected props of the section; Partial because the renderer erases the share boundary. */
export interface AcpSectionProps {
  t?: AcpTranslate | undefined
  useStore?: UsePanelStore | undefined
  panel?: AcpSectionWire | undefined
}

/** Which editor card is open; the add flow carries its seed draft (empty or a one-click template). */
type EditorState =
  | { mode: 'add'; seed: AgentDraft }
  | { mode: 'edit'; id: string }

/** The change events our inputs care about (the attribute bag types handlers loosely; see react.d.ts). */
interface InputEvent {
  target: { value: string }
}

interface KeyboardEventLike {
  key: string
  preventDefault(): void
}

/**
 * Render the ACP section content column.
 * @param props - slot-delivered inject face.
 * @returns the section, or null while the shell has not injected yet (ModelsSection precedent).
 */
export function AcpSection(props: AcpSectionProps): ReactNode {
  const { t, useStore, panel } = props
  if (t === undefined || useStore === undefined || panel === undefined) return null
  return h(Loaded, { t, useStore, panel })
}

function Loaded({ t, useStore, panel }: {
  t: AcpTranslate
  useStore: UsePanelStore
  panel: AcpSectionWire
}): ReactNode {
  const snapshot = useStore((value) => value)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [notice, setNotice] = useState<'saved' | 'deleted' | null>(null)
 // Agent 卡片折叠交互：「添加 agent」下拉的开合状态（触发钮 + 菜单；外部点击关闭）。
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  // Health data loads when the panel first opens, never in the background:
  // each fetch runs `<command> --version` probes on the host.
  useEffect(() => {
    panel.refreshHealth()
  }, [panel])

  useEffect(() => {
    if (!addMenuOpen) return
    const closeOutside = (event: MouseEvent): void => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [addMenuOpen])

  const closeEditor = (changed: boolean): void => {
    setEditor(null)
    if (changed) setNotice('saved')
  }
  const openAdd = (seed: AgentDraft): void => {
    setNotice(null)
    setEditor({ mode: 'add', seed })
  }
  const openEdit = (id: string): void => {
    setNotice(null)
    setEditor((previous) => previous?.mode === 'edit' && previous.id === id ? null : { mode: 'edit', id })
  }
  const onDeleted = (id: string): void => {
    // Only the deleted row's own editor closes; an unrelated add/edit draft survives.
    setEditor((previous) => previous?.mode === 'edit' && previous.id === id ? null : previous)
    setNotice('deleted')
  }
 // singleton 冲突的「打开已有配置」出口：关掉当前草稿，改开已有 profile 的编辑器
  const openExisting = (id: string): void => {
    setNotice(null)
    setEditor({ mode: 'edit', id })
  }

  const settings = snapshot.settings
  const children: ReactNode[] = [
    h('h2', { key: 'title', className: css.title }, t('title')),
    h('p', { key: 'intro', className: css.intro }, t('intro')),
  ]

  if (settings.status !== 'ready') {
    const key = settings.status === 'loading'
      ? 'settingsLoading'
      : settings.status === 'unavailable'
        ? 'settingsUnavailable'
        : 'settingsInvalid'
    const cls = settings.status === 'invalid' ? css.error : css.hint
    children.push(h('p', { key: 'status', className: cls }, t(key)))
    return h('div', { className: css.section }, children)
  }

  const readOnly = !settings.writable
  const agents = settings.agents
  const ids = sortedAgentIds(agents)

  if (readOnly) children.push(h('p', { key: 'ro', className: css.notice }, t('readOnly')))
  if (notice !== null) {
    children.push(h('p', {
      key: 'notice', className: css.saved, role: 'status', 'aria-live': 'polite',
    }, t(notice === 'saved' ? 'savedNotice' : 'deletedNotice')))
  }
  if (snapshot.health.status === 'unreachable') {
    children.push(h('p', { key: 'unreachable', className: css.notice }, t('healthUnreachable')))
    if (snapshot.health.message !== undefined) {
      children.push(h('p', { key: 'unreachable-detail', className: css.hint }, snapshot.health.message))
    }
  }
  const refreshing = snapshot.health.status === 'loading'
  const checkingAnyAgent = snapshot.health.checkingAgentIds.length > 0
  children.push(h('div', { key: 'toolbar', className: css.toolbar },
 // Agent 卡片折叠交互：one-click 模板从平铺枚举改为「添加 agent」下拉（宿主「模型」
    // 配置页「添加提供方」同款形态：一个触发钮 + 下拉列出全部内置模板与
    // 手动添加）。draftFromTemplate 对列表内 id 恒有定义。
    h('div', {
      className: css.addMenu,
      ref: addMenuRef,
      onKeyDown: (event: KeyboardEventLike) => {
        if (event.key === 'Escape' && addMenuOpen) {
          event.preventDefault()
          setAddMenuOpen(false)
        }
      },
    },
      h('button', {
        type: 'button',
        className: css.secondaryButton,
        disabled: readOnly,
        'aria-haspopup': 'menu',
        'aria-expanded': addMenuOpen,
        onClick: () => { setAddMenuOpen((previous) => !previous) },
      },
        t('addAgent'),
        h(IconChevronDownOutline14, {
          size: 14,
          className: addMenuOpen ? `${css.chevron} ${css.chevronFlip}` : css.chevron,
        }),
      ),
      addMenuOpen
        ? h('div', { className: css.addMenuList, role: 'menu', 'aria-label': t('addAgent') },
          ...ACP_BUILTIN_AGENT_TEMPLATES.map((template) => h('button', {
            key: `template-${template.id}`,
            type: 'button',
            role: 'menuitem',
            className: css.addMenuItem,
            onClick: () => {
              setAddMenuOpen(false)
              const seed = draftFromTemplate(template.id)
              if (seed !== undefined) openAdd(seed)
            },
          }, t('addTemplate', { name: template.name }))),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: css.addMenuItem,
            onClick: () => {
              setAddMenuOpen(false)
              openAdd(emptyDraft())
            },
          }, t('addCustom')),
        )
        : null,
    ),
    h('button', {
      type: 'button',
      className: css.secondaryButton,
      disabled: refreshing || checkingAnyAgent,
      onClick: () => { panel.refreshHealth(true) },
    }, t(refreshing ? 'refreshing' : 'refresh')),
  ))

  if (ids.length === 0 && editor?.mode !== 'add') {
    children.push(h('p', { key: 'empty', className: css.hint }, t('emptyAgents')))
  }

  if (ids.length > 0) {
    children.push(h('ul', { key: 'rows', className: css.rows },
      ids.map((id) => {
        const config = agents[id] as AcpAgentConfig
        const editing = editor?.mode === 'edit' && editor.id === id
        return h(AgentCard, {
          key: id,
          t,
          id,
          config,
          health: snapshot.health,
          readOnly,
          editing,
          agents,
          panel,
          onEdit: () => { openEdit(id) },
          onDeleted,
          onCloseEditor: closeEditor,
          onOpenAgent: openExisting,
        })
      }),
    ))
  }

  if (editor?.mode === 'add') {
    children.push(h('div', { key: 'add', className: css.rowCard },
      h(AgentForm, {
        key: 'add-form',
        t,
        initial: editor.seed,
        editingId: undefined,
        agents,
        readOnly,
        panel,
        onClose: closeEditor,
        onOpenAgent: openExisting,
      }),
    ))
  }

  return h('div', { className: css.section }, children)
}

/** 一个已配置 Agent：默认只展示名称、可操作状态和管理动作。 */
function AgentCard(props: {
  t: AcpTranslate
  id: string
  config: AcpAgentConfig
  health: HealthState
  readOnly: boolean
  editing: boolean
  agents: Record<string, AcpAgentConfig>
  panel: AcpSectionWire
  onEdit(): void
  onDeleted(id: string): void
  onCloseEditor(changed: boolean): void
  onOpenAgent(id: string): void
}): ReactNode {
  const { t, id, config, panel } = props
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
 // 删除确认的绑定计数（确认块打开时现取；undefined = 不可得，不冒充 0）
  const [boundCount, setBoundCount] = useState<number | undefined>(undefined)
  const checking = props.health.status === 'loading' || props.health.checkingAgentIds.includes(id)
  const checkError = props.health.agentErrors[id]
  const confirmDelete = (): void => {
    setDeleting(true)
    setFailure(undefined)
    void panel.deleteAgent(id)
      .then((message) => {
        if (message !== undefined) {
          setFailure(message)
          return
        }
        props.onDeleted(id)
      })
      .catch((error: unknown) => { setFailure(errorMessageOf(error)) })
      .finally(() => { setDeleting(false) })
  }

  const healthRow = healthRowOf(props.health.rows, id)
  const state = healthRow?.state
  const statusText = state === undefined
    ? t('stateSavedUnverified')
    : stateText(t, state)
  const statusTone = state === 'ready'
    ? css.statusReady
    : css.statusMuted
  const probeError = healthRow?.probe.status === 'error' ? healthRow.probe.message : undefined
  const diagnostic = checkError ?? probeError

  const children: ReactNode[] = [
    h('div', { key: 'head', className: css.rowHead },
      h('span', { className: css.rowIdentity },
        h('span', { className: css.rowName }, config.name),
        h('span', { className: `${css.statusBadge} ${statusTone}` },
          h('span', { className: css.statusDot, 'aria-hidden': true }),
          statusText,
        ),
      ),
      h('span', { className: css.rowActions },
        h('button', {
          type: 'button',
          className: `${css.secondaryButton} ${css.compact}`,
          disabled: checking,
          onClick: () => { panel.refreshAgentHealth(id) },
        }, t(checking ? 'refreshing' : 'refresh')),
        h('button', {
          type: 'button',
          className: `${css.secondaryButton} ${css.compact}`,
          onClick: props.onEdit,
        }, t('edit')),
        h('button', {
          type: 'button',
          className: `${css.dangerButton} ${css.compact}`,
          disabled: props.readOnly || deleting,
          onClick: () => {
            setFailure(undefined)
            setBoundCount(undefined)
            setConfirming(true)
 // 进入确认块时现取绑定计数（点击时刻的新鲜事实，不用缓存健康视图）
            void panel.countBoundSessions(id).then(setBoundCount)
          },
        }, t('remove')),
      ),
    ),
  ]

  if (diagnostic !== undefined) {
    children.push(h('p', { key: 'diagnostic', className: css.error, role: 'alert' },
      t('healthCheckFailed', { message: diagnostic })))
  }
  if (state === 'auth-required' && config.loginHint !== undefined) {
    children.push(h('p', { key: 'login-hint', className: css.hint },
      t('loginInstruction', { hint: config.loginHint })))
  }
  if (state === 'incompatible') {
    children.push(h('p', { key: 'incompatible-hint', className: css.hint },
      t('incompatibleInstruction')))
  }

  if (confirming) {
    children.push(h('div', { key: 'delete', className: css.deleteBlock },
      h('p', { className: css.deleteText }, t('removeConfirm', { name: config.name })),
 // 预告：计数 > 0 时明示后果——这些会话将显示 backend-unavailable，
      // 不会静默改用其他 profile（countBoundSessions 不可得不渲染本行，不冒充 0）
      boundCount === undefined || boundCount === 0
        ? null
        : h('p', { className: css.deleteText }, t('removeConfirmBound', { count: boundCount })),
      failure === undefined ? null : h('p', { className: css.error }, failure),
      h('button', {
        type: 'button',
        className: css.dangerButton,
        disabled: deleting,
        onClick: confirmDelete,
      }, t(deleting ? 'removing' : 'remove')),
      h('button', {
        type: 'button',
        className: css.secondaryButton,
        disabled: deleting,
        onClick: () => { setConfirming(false) },
      }, t('cancel')),
    ))
  }

  if (props.editing) {
    children.push(h(AgentForm, {
      key: `edit-${id}`,
      t,
      initial: draftFromAgent(id, config),
      editingId: id,
      agents: props.agents,
      readOnly: props.readOnly,
      panel,
      onClose: props.onCloseEditor,
      onOpenAgent: props.onOpenAgent,
    }))
  }

  return h('li', { className: css.rowCard }, children)
}

/**
 * 产品状态只承诺“未探测 / 协议可用”。失败类别仍通过下方诊断和登录
 * 指引展示，但不会伪装成可持续跟踪的外部登录状态。
 */
function stateText(t: AcpTranslate, state: AcpProviderHealth['state']): string {
  return t(state === 'ready' ? 'stateReady' : 'stateSavedUnverified')
}

/** The add/edit editor card: staged text fields validated live, saved through the controller. */
function AgentForm(props: {
  t: AcpTranslate
  initial: AgentDraft
  editingId: string | undefined
  agents: Record<string, AcpAgentConfig>
  readOnly: boolean
  panel: AcpSectionWire
  onClose(changed: boolean): void
 /** singleton 冲突的出口：打开占用该 runtime 的已有 profile 的编辑器。 */
  onOpenAgent(id: string): void
}): ReactNode {
  const { t } = props
  const [draft, setDraft] = useState<AgentDraft>(() => props.initial)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const disabled = props.readOnly || busy
  const validation = validateAgentDraft(draft, props.agents, props.editingId)
  const scope = props.editingId ?? 'new'

  const edit = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setFailure(undefined)
  }
  const save = (): void => {
    setAttempted(true)
    if (validation.config === undefined) return
    setBusy(true)
    setFailure(undefined)
    void props.panel.saveAgent(props.editingId, draft)
      .then((message) => {
        if (message !== undefined) {
          setFailure(message)
          return
        }
        props.onClose(true)
      })
      .catch((error: unknown) => { setFailure(errorMessageOf(error)) })
      .finally(() => { setBusy(false) })
  }

  // Required-field errors stay quiet over a pristine empty field until the
  // first save attempt; format/uniqueness errors answer actual input at once
  // (the CustomProviderCard route-field precedent).
  const shown = (error: DraftError | undefined, value: string): DraftError | undefined =>
    error !== undefined && (attempted || value.trim() !== '') ? error : undefined

  return h('div', { className: css.editor },
    h('div', { className: css.editorHeader },
      h('span', { className: css.editorTitle }, t(props.editingId === undefined ? 'editorTitleAdd' : 'editorTitleEdit')),
    ),
    textField({
      t,
      id: `dsh-acp-${scope}-id`,
      label: t('fieldId'),
      hint: t('fieldIdHint'),
      error: shown(validation.id, draft.id),
      value: draft.id,
      disabled,
      placeholder: 'devin',
      onChange: (value) => { edit({ id: value }) },
    }),
    textField({
      t,
      id: `dsh-acp-${scope}-name`,
      label: t('fieldName'),
      hint: t('fieldNameHint'),
      error: shown(validation.name, draft.name),
      value: draft.name,
      disabled,
      placeholder: 'Devin',
      onChange: (value) => { edit({ name: value }) },
    }),
    textField({
      t,
      id: `dsh-acp-${scope}-command`,
      label: t('fieldCommand'),
      hint: t('fieldCommandHint'),
      error: shown(validation.command, draft.command),
      value: draft.command,
      disabled,
      placeholder: 'devin',
      onChange: (value) => { edit({ command: value }) },
    }),
    textField({
      t,
      id: `dsh-acp-${scope}-args`,
      label: t('fieldArgs'),
      hint: t('fieldArgsHint'),
      value: draft.argsText,
      disabled,
      multiline: true,
      placeholder: 'acp',
      onChange: (value) => { edit({ argsText: value }) },
    }),
    textField({
      t,
      id: `dsh-acp-${scope}-env`,
      label: t('fieldEnv'),
      hint: t('fieldEnvHint'),
      error: validation.env,
      value: draft.envText,
      disabled,
      multiline: true,
      placeholder: 'NO_COLOR=1',
      onChange: (value) => { edit({ envText: value }) },
    }),
 // 疑似 secret 的存量 env 键只展示键名 + 已配置状态，值永不进文本框；
    // 「移除」从草稿的 maskedEnv 删键（保存后即从 settings 抹去）。
    draft.maskedEnv === undefined ? null : h('div', { className: css.field },
      h('span', { className: css.fieldLabel }, t('fieldEnvMasked')),
      h('ul', { className: css.maskedEnvRows },
        Object.keys(draft.maskedEnv).sort().map((key) =>
          h('li', { key, className: css.maskedEnvRow },
            h('code', { className: css.maskedEnvKey }, key),
            h('span', { className: css.healthMuted }, t('envMaskedConfigured')),
            h('button', {
              type: 'button',
              className: `${css.secondaryButton} ${css.compact}`,
              disabled,
              onClick: () => {
                setDraft((previous) => dropMaskedEnvKey(previous, key))
                setFailure(undefined)
              },
            }, t('envMaskedRemove')),
          ))),
    ),
    textField({
      t,
      id: `dsh-acp-${scope}-loginHint`,
      label: t('fieldLoginHint'),
      hint: t('fieldLoginHintHint'),
      value: draft.loginHint,
      disabled,
      placeholder: 'devin auth login',
      onChange: (value) => { edit({ loginHint: value }) },
    }),
 // singleton：草稿 runtime 与存量 profile 冲突的块级错误（runtime 不是
    // 可编辑字段，错误不挂在某个输入框上）——点名已有 profile 并给「打开已有
    // 配置」出口；保存钮经 validation.config 缺席自然禁用（不自动覆盖/删除）。
    validation.runtime === undefined ? null : h('div', { className: css.field },
      h('p', { className: css.error, role: 'alert' }, t(validation.runtime.key, validation.runtime.params)),
      h('button', {
        type: 'button',
        className: css.secondaryButton,
        onClick: () => { props.onOpenAgent(String(validation.runtime?.params?.['id'] ?? '')) },
      }, t('openExisting')),
    ),
    failure === undefined ? null : h('p', { className: css.error }, failure),
    h('div', { className: css.editorActions },
      h('button', {
        type: 'button',
        className: css.secondaryButton,
        disabled: busy,
        onClick: () => { props.onClose(false) },
      }, t('cancel')),
      h('button', {
        type: 'button',
        className: css.primaryButton,
        disabled: disabled || validation.config === undefined,
        onClick: save,
      }, t(busy ? 'saving' : 'save')),
    ),
  )
}

/** One labelled text/textarea control with its hint-or-error line (fields.tsx precedent). */
function textField(props: {
  t: AcpTranslate
  id: string
  label: string
  hint: string
  value: string
  disabled: boolean
  onChange(value: string): void
  error?: DraftError | undefined
  multiline?: boolean
  placeholder?: string
}): ReactNode {
  const invalid = props.error !== undefined
  const control = props.multiline === true
    ? h('textarea', {
      id: props.id,
      className: invalid ? `${css.textarea} ${css.textareaInvalid}` : css.textarea,
      value: props.value,
      disabled: props.disabled,
      placeholder: props.placeholder ?? '',
      rows: 3,
      ...(invalid ? { 'aria-invalid': true } : {}),
      onChange: (event: InputEvent) => { props.onChange(event.target.value) },
    })
    : h('input', {
      id: props.id,
      className: invalid ? `${css.input} ${css.inputInvalid}` : css.input,
      type: 'text',
      value: props.value,
      disabled: props.disabled,
      placeholder: props.placeholder ?? '',
      ...(invalid ? { 'aria-invalid': true } : {}),
      onChange: (event: InputEvent) => { props.onChange(event.target.value) },
    })
  return h('div', { className: css.field },
    h('label', { className: css.fieldLabel, htmlFor: props.id }, props.label),
    control,
    h('p', { className: invalid ? css.error : css.hint },
      props.error !== undefined ? props.t(props.error.key, props.error.params) : props.hint),
  )
}
