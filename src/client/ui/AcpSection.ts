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
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ACP_BUILTIN_AGENT_TEMPLATES,
  commandLineOf,
  draftFromAgent,
  draftFromTemplate,
  dropMaskedEnvKey,
  emptyDraft,
  errorMessageOf,
  healthLayersOf,
  healthRowOf,
  loginStateOf,
  showsLoginHint,
  sortedAgentIds,
  validateAgentDraft,
} from '../data/logic.ts'
import type { AcpAgentConfig, AcpCapabilityMatrixRow, AcpProviderHealth, AgentDraft, DraftError, HealthLayerView } from '../data/logic.ts'
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
    // 产品边界说明 边界说明：常驻、不可折叠，任何状态下都渲染。
    h('p', { key: 'boundary', className: css.boundary, role: 'note' }, t('boundary')),
    // 常驻披露只说明实际复用边界。正式 ACP 会话使用 Native Agent Access，
    // health probe 的临时沙箱事实不是会话能力，因此不在这里展示。
    h('div', { key: 'disclosure', className: css.disclosure, role: 'note' },
      h('p', { className: css.disclosureTitle }, t('discTitle')),
      h('p', { className: css.disclosureLine }, t('discReusable')),
      h('p', { className: css.disclosureLine }, t('discNotReusable')),
    ),
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

/** One configured agent (可折叠的精简 Agent 卡片): head row = 名称 + 重新检查/编辑/删除 + 展开 chevron, plus a one-line status summary; identity detail rows, command line, delete flow and health card render once expanded, plus its editor when open. */
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
 // Agent 卡片折叠交互：卡片默认折叠——头行 + 一行状态摘要常驻；命令行与健康卡详情点击
 // 展开后渲染。编辑动作自动展开（编辑器在卡内）。精简卡片头部：头行精简为「仅
  // 名称 + 重新检查/编辑/删除 + 展开 chevron」——身份 tag 移出头行
  // （「ACP」tag 删除，面板本身就是 ACP 语境；id/runtime 收进
  // 展开详情顶部的堆叠行，信息不丢），「重新检查」从详情底部上提到头行。
  const [expanded, setExpanded] = useState(false)

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

 // 折叠态的一行状态摘要：复用 五态行展示词；健康端点未覆盖该 agent
  // 时如实标注（不可达 / 已保存未探测）。
  const healthRow = healthRowOf(props.health.rows, id)
  const statusSummary: ReactNode = healthRow === undefined
    ? h('span', { className: css.healthMuted },
      t(props.health.status === 'unreachable' ? 'healthUnavailableCard' : 'stateSavedUnverified'))
    : stateValue(t, healthRow.state)

  const children: ReactNode[] = [
    h('div', { key: 'head', className: css.rowHead },
      h('button', {
        type: 'button',
        className: css.expandButton,
        'aria-expanded': expanded,
        'aria-label': t(expanded ? 'collapseDetails' : 'expandDetails'),
        title: t(expanded ? 'collapseDetails' : 'expandDetails'),
        onClick: () => { setExpanded((previous) => !previous) },
      }, h(IconChevronRightOutline14, {
        size: 14,
        className: expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron,
      })),
      h('span', { className: css.rowIdentity },
        h('span', { className: css.rowName }, config.name),
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
          onClick: () => {
            setExpanded(true)
            props.onEdit()
          },
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
    h('div', { key: 'summary', className: css.statusLine },
      h('span', { className: css.healthLabel }, t('stateLabel')),
      statusSummary,
    ),
  ]

  if (checkError !== undefined) {
    children.push(h('p', { key: 'check-error', className: css.error, role: 'alert' },
      t('healthCheckFailed', { message: checkError })))
  }

  if (expanded) {
    children.push(h('p', { key: 'cmd', className: css.commandLine }, `$ ${commandLineOf(config)}`))
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

  if (expanded) {
 // 精简卡片头部：头行移除的身份信息收进详情顶部堆叠行（缺席不渲染，不冒充
    // 「未知」；编辑器不暴露这两个高级字段的纪律不变——卡片只读展示）。
    children.push(h(HealthCard, {
      key: 'health',
      t,
      id,
      loginHint: config.loginHint,
      health: props.health,
      identityRows: [
        healthField(t('fieldId'), id, 'detail-id'),
        config.runtime === undefined
          ? null
          : healthField(t('detailRuntime'), config.runtime, 'detail-runtime'),
      ],
    }))
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
 * The per-agent health card（四层：executable / initialize / session /
 * prompt-auth，healthLayersOf 驱动）。分层语义见 logic.ts：probe 到达 session
 * 阶段即证明 initialize 已通过；prompt-auth 无零消耗探测手段，通过也只标
 * 「未验证」。顶部五态 `state` 行由 host 侧派生；认证行只展示
 * 登录态事实与 loginHint——登录动作在 agent 自家 CLI 完成（external-login-only，
 * 面板不再有 authenticate 按钮）。
 */
function HealthCard(props: {
  t: AcpTranslate
  id: string
  loginHint: string | undefined
  health: HealthState
 /** 精简卡片头部：头行精简后收进详情顶部的身份堆叠行（ID/runtime）。 */
  identityRows: readonly ReactNode[]
}): ReactNode {
  const { t, id, health } = props
  const row = healthRowOf(health.rows, id)

  const rows: ReactNode[] = [...props.identityRows]
  if (row === undefined) {
    // No row: the endpoint never covered this agent (just added) or is down.
    rows.push(h('div', { key: 'none', className: css.healthRow },
      h('span', { className: css.healthMuted },
        t(health.status === 'unreachable' ? 'healthUnavailableCard' : 'healthNoRow')),
    ))
  } else {
    const layers = healthLayersOf(row)
 // ── 五态行（host 侧 deriveAcpAgentState 的派生事实）
    rows.push(healthField(t('stateLabel'), stateValue(t, row.state), 'state', row.state === 'saved-unverified'))
    // ── executable 层（既有可执行/版本行）
    rows.push(healthField(t('healthExecutable'), row.executable
      ? h('span', { className: css.healthOk }, t('healthFound'))
      : h('span', { className: css.healthBad }, t('healthMissing')), 'exe'))
    rows.push(healthField(t('healthVersion'), row.version ?? t('healthUnknown'), 'ver', row.version === null))
    // ── initialize 层
    rows.push(layerRow(t, t('layerInitialize'), layers.initialize, 'init', () => {
      const info = row.probe.status === 'ok' ? row.probe.agentInfo : null
      return info === null
        ? t('healthInitOk')
        : t('healthInitOkInfo', { name: info.name, version: info.version })
    }))
 // 端到端能力矩阵（端到端能力）：不再直译 initialize 广告布尔——host 侧已把
    // 广告 × adapter path × host seam 折成三值交集（matrix 是 probe-ok 必填键）。
    if (row.probe.status === 'ok') {
      rows.push(...capabilityMatrixRows(t, row.probe.matrix))
    }
    // ── session 层（ok 值带模型选项数；probe 失败 message 与上次探测行归此层）
    rows.push(layerRow(t, t('layerSession'), layers.session, 'sess', (layer) =>
      t('healthSessionOk', { count: layer.modelCount ?? 0 })))
    if (row.probe.status === 'error') {
      rows.push(h('div', { key: 'probeError', className: css.healthRow },
        h('span', { className: css.healthBad }, row.probe.message),
      ))
    }
    rows.push(healthField(
      t('healthProbeAt'),
      row.probe.at === null ? t('healthProbeNever') : new Date(row.probe.at).toLocaleString(),
      'at',
      row.probe.at === null,
    ))
 // ──：probe 会话清理事实（probe 清理）+ 能力指纹。delete 未广告/失败是明确降级，
    // 如实展示；cleanup/capabilityHash 为 null（旧条目）时该子行不渲染。
    if (row.probe.status === 'ok' && row.probe.cleanup !== null) {
      const cleanup = row.probe.cleanup
      const degraded = cleanup.delete !== 'done'
      const text = cleanup.delete === 'done'
        ? t('cleanupDone')
        : cleanup.delete === 'not-advertised'
          ? t('cleanupDeleteNotAdvertised')
          : t('cleanupDeleteFailed', { message: cleanup.message ?? '' })
      rows.push(healthField(
        t('cleanupLabel'),
        degraded ? h('span', { className: css.healthBad }, text) : text,
        'cleanup',
      ))
    }
    if (row.probe.status === 'ok' && row.probe.capabilityHash !== null) {
      rows.push(healthField(t('capabilityHashLabel'), row.probe.capabilityHash, 'capabilityHash', true))
    }
 // ── readiness：协议版本行恒渲染（probe-ok 时）；兼容状态行只在可判定
    // 时渲染（无 descriptor/握手无版本 = 诚实不渲染，不冒充「兼容」）。drifted
    // 高亮——钉版是验收事实，漂移不阻断但要可见。
    if (row.probe.status === 'ok') {
      rows.push(healthField(
        t('healthProtocolVersion'),
        row.probe.protocolVersion === null ? t('healthUnknown') : `v${String(row.probe.protocolVersion)}`,
        'protocolVersion',
        row.probe.protocolVersion === null,
      ))
      if (row.probe.versionCompatibility !== null) {
        const compat = row.probe.versionCompatibility
        const pin = row.probe.versionPolicy?.adapter ?? row.probe.versionPolicy?.wrappedCli ?? ''
        const text = compat === 'pinned'
          ? t('versionCompatPinned', { version: pin })
          : compat === 'drifted'
            ? t('versionCompatDrifted', { pin, current: row.probe.agentInfo?.version ?? '' })
            : t('versionCompatUnpinned')
        rows.push(healthField(
          t('versionCompatLabel'),
          compat === 'drifted' ? h('span', { className: css.healthBad }, text) : text,
          'versionCompat',
        ))
      }
    }
    // ── prompt-auth 层（状态行 + 认证事实行 + 登录指引行）
    rows.push(layerRow(t, t('layerPromptAuth'), layers.promptAuth, 'promptAuth'))
    rows.push(h('div', { key: 'auth', className: css.healthRow },
      h('span', { className: css.healthLabel }, t('authLabel')),
      h('span', { className: css.healthValue }, authText(t, row)),
    ))
    if (showsLoginHint(row) && props.loginHint !== undefined) {
      rows.push(h('div', { key: 'hint', className: css.healthRow },
        h('span', { className: css.healthLabel }, t('loginHintLabel')),
        h('span', { className: css.healthMuted }, props.loginHint),
      ))
    }
  }

 // 精简卡片头部：详情底部原「重新检查」actions 行移除——按钮已上提到卡片头行右侧。
  return h('div', { className: css.health }, rows)
}

/** 五态行的展示词（各态如实标注）。 */
function stateValue(t: AcpTranslate, state: AcpProviderHealth['state']): ReactNode {
  switch (state) {
    case 'ready':
      return h('span', { className: css.healthOk }, t('stateReady'))
    case 'auth-required':
      return h('span', { className: css.healthBad }, t('stateAuthRequired'))
    case 'unavailable':
      return h('span', { className: css.healthBad }, t('stateUnavailable'))
    case 'incompatible':
      return h('span', { className: css.healthBad }, t('stateIncompatible'))
    case 'saved-unverified':
      return t('stateSavedUnverified')
  }
}

/**
 * The auth cell: plain login-state text（external-login-only：不再渲染登录
 * 按钮——登录动作在 agent 自家 CLI 完成，面板只展示事实与指引）。
 */
function authText(t: AcpTranslate, row: AcpProviderHealth): ReactNode {
  const login = loginStateOf(row)
  if (login.kind === 'none') return t('authNone')
  if (login.kind === 'unknown') {
    return h('span', { className: css.healthMuted }, t('authUnknown'))
  }
  return t('authMethodsCount', { count: login.methods.length })
}

/**
 * 一层健康的 label/value 行：ok 用层自定义文案（okText），其余状态落状态词——
 * failed 带 kind 分流、needsLogin 可行动、blocked/unverified/unknown 各如实标注。
 */
function layerRow(
  t: AcpTranslate,
  label: string,
  layer: HealthLayerView,
  key: string,
  okText?: (layer: HealthLayerView) => string,
): ReactNode {
  let value: string
  // css.* 索引在 noUncheckedIndexedAccess 下是 string | undefined；className 同样接受 undefined。
  let cls: string | undefined = css.healthValue
  if (layer.state === 'ok') {
    value = okText?.(layer) ?? ''
    cls = css.healthOk
  } else if (layer.state === 'failed') {
    value = t('probeError', { kind: layer.failureKind ?? 'unknown' })
    cls = css.healthBad
  } else if (layer.state === 'needsLogin') {
    value = t('healthNeedsLogin')
    cls = css.healthBad
  } else if (layer.state === 'blocked') {
    value = t('healthBlocked')
    cls = css.healthMuted
  } else if (layer.state === 'unverified') {
    value = t('healthUnverified')
    cls = css.healthMuted
  } else {
    value = t('healthProbeNever')
    cls = css.healthMuted
  }
  return h('div', { key, className: css.healthRow },
    h('span', { className: css.healthLabel }, label),
    h('span', { className: cls }, value),
  )
}

/** One label/value line of the health card. */
function healthField(label: string, value: ReactNode, key: string, muted = false): ReactNode {
  return h('div', { key, className: css.healthRow },
    h('span', { className: css.healthLabel }, label),
    h('span', { className: muted ? css.healthMuted : css.healthValue }, value),
  )
}

/** 矩阵行 id → 行标签 locale 键（词表外 id 用原始 id 作标签，向前兼容 host 新增行）。 */
const MATRIX_LABEL_KEYS: Record<string, AcpLocaleKey> = {
  loadSession: 'capLoadSession',
  sessionList: 'capSessionList',
  sessionClose: 'capSessionClose',
  sessionDelete: 'capSessionDelete',
  promptImage: 'capPromptImage',
  promptAudio: 'capPromptAudio',
  promptEmbeddedContext: 'capPromptEmbeddedContext',
  mcpHttp: 'capMcpHttp',
  mcpSse: 'capMcpSse',
}

/**
 * 端到端能力矩阵的渲染：每行 = 标签 + 三值状态词（supported/degraded/
 * unsupported 分色），note 在位时追加一条 muted 次级说明（host 事实原文）。
 */
function capabilityMatrixRows(t: AcpTranslate, matrix: readonly AcpCapabilityMatrixRow[]): ReactNode[] {
  const rows: ReactNode[] = [h('div', { key: 'cap-matrix-title', className: css.healthRow },
    h('span', { className: css.healthLabel }, t('capMatrixTitle')))]
  for (const entry of matrix) {
    const labelKey = MATRIX_LABEL_KEYS[entry.id]
    const statusCls = entry.status === 'supported'
      ? css.healthOk
      : entry.status === 'degraded'
        ? css.healthBad
        : css.healthMuted
    const statusWord = t(entry.status === 'supported'
      ? 'capStatusSupported'
      : entry.status === 'degraded'
        ? 'capStatusDegraded'
        : 'capStatusUnsupported')
    rows.push(h('div', { key: `cap-${entry.id}`, className: css.healthRow },
      h('span', { className: css.healthLabel }, labelKey === undefined ? entry.id : t(labelKey)),
      h('span', { className: statusCls }, statusWord),
    ))
    if (entry.note !== undefined) {
      rows.push(h('div', { key: `cap-${entry.id}-note`, className: css.healthRow },
        h('span', { className: css.healthMuted }, entry.note),
      ))
    }
  }
  return rows
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
    textField({
      t,
      id: `dsh-acp-${scope}-mcp`,
      label: t('fieldMcp'),
      hint: t('fieldMcpHint'),
      error: validation.mcp,
      value: draft.mcpText ?? '',
      disabled,
      multiline: true,
      placeholder: '[{"type":"stdio","name":"my-server","command":"/absolute/path/mcp","args":[],"env":{}}]',
      onChange: (value) => { edit({ mcpText: value }) },
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
