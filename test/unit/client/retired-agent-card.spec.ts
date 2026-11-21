import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  Input: 'Input',
  Menu: 'Menu',
  Tag: 'Tag',
  Switch: 'Switch',
  Tooltip: 'Tooltip',
  IconPlusOutlineMedium: 'Plus',
  IconChevronDownOutlineMedium: 'Chevron',
  IconRefreshOutlineMedium: 'Refresh',
}))
import { AcpSection, type AcpSectionWire } from '../../../src/client/ui/AcpSection.ts'
import { zh, en } from '../../../src/client/ui/locales.ts'
import type { AcpPanelSnapshot } from '../../../src/client/data/stores/panel-store.ts'

type Node = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> }
function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && 'type' in value && 'props' in value
}
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (!isNode(value)) return value
  if (typeof value.type === 'function') return expand(value.type(value.props))
  return { ...value, props: { ...value.props, children: expand(value.props.children) } }
}
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!isNode(value)) return []
  return [value, ...nodes(value.props.children)]
}
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).join(' ')
  return isNode(value) ? text(value.props.children) : ''
}
function renderPanel(snapshot: AcpPanelSnapshot, locale = en) {
  const panel: AcpSectionWire = {
    accountUsage: vi.fn(),
    refreshHealth: vi.fn(),
    refreshAgentHealth: vi.fn(),
    saveAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setAiApproval: vi.fn(),
    setOpenCodeReviewModel: vi.fn(),
    setDevinReviewModel: vi.fn(),
    countBoundSessions: vi.fn(),
  }
  const tree = expand(
    AcpSection({
      t: (key, params) => locale[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? '')),
      useStore: (selector) => selector(snapshot),
      panel,
    }),
  )
  return { panel, tree }
}

it.each([zh, en])(
  'shows one global switch for multiple Agents and keeps per-profile review model choices',
  (locale) => {
    const config = {
      name: 'Team Devin',
      command: '/opt/tools/devin',
      args: ['acp'],
      env: {},
      runtime: 'devin' as const,
    }
    const row = {
      id: 'company',
      ...config,
      loginHint: null,
      executable: true,
      version: null,
      state: 'saved-unverified' as const,
      probe: { status: 'never' as const, at: null },
      devinReviewModels: [{ id: 'review-2', name: 'Reviewer Two' }],
    }
    const work = { name: 'Work', command: 'opencode', args: ['acp'], env: {} }
    const openCode = { ...row, ...work, id: 'work', openCodeReviewModels: [{ id: 'work/fast', name: 'Fast' }] }
    const snapshot: AcpPanelSnapshot = {
      settings: {
        status: 'ready',
        writable: true,
        agents: { company: config, work, home: { ...work, name: 'Home', openCodeReviewModel: 'old/custom' } },
        aiApproval: false,
        devinReviewModel: 'review-2',
        revision: 3,
      },
      health: {
        status: 'ready',
        rows: [row, openCode, { ...openCode, id: 'home', openCodeReviewModels: [] }],
        fetchedAt: 1,
        message: undefined,
        checkingAgentIds: [],
        agentErrors: {},
      },
    }
    const off = renderPanel(snapshot, locale)
    const switches = nodes(off.tree).filter((node) => node.type === 'Switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]!.props).toMatchObject({ checked: false, label: locale.aiApproval })
    expect(text(off.tree)).toContain(locale.aiApprovalHelp)
    expect(nodes(off.tree).filter((node) => node.type === 'Menu' && node.props.selectedId !== undefined)).toHaveLength(
      0,
    )
    ;(switches[0]!.props.onChange as (next: boolean) => void)(true)
    expect(off.panel.setAiApproval).toHaveBeenCalledExactlyOnceWith(true)
    const on = renderPanel({ ...snapshot, settings: { ...snapshot.settings, aiApproval: true } }, locale)
    const menus = nodes(on.tree).filter((node) => node.type === 'Menu' && node.props.selectedId !== undefined)
    expect(menus).toHaveLength(3)
    const sessionModel = menus.find((node) => node.props.selectedId === '')!
    expect(sessionModel.props.items).toEqual([
      { id: '', label: locale.reviewSessionModel },
      { id: 'work/fast', label: 'Fast' },
    ])
    ;(sessionModel.props.onSelect as (value: string) => void)('work/fast')
    expect(on.panel.setOpenCodeReviewModel).toHaveBeenCalledExactlyOnceWith('work', 'work/fast')
    expect(on.panel.setDevinReviewModel).not.toHaveBeenCalled()
    expect(text(on.tree)).toContain(locale.reviewModelMissing)
    const noCatalog = locale.reviewModelsEmpty.replace('{name}', config.name)
    expect(text(on.tree)).not.toContain(noCatalog)
    const emptyDevin = renderPanel(
      {
        ...snapshot,
        settings: { ...snapshot.settings, aiApproval: true },
        health: { ...snapshot.health, rows: [{ ...row, devinReviewModels: [] }] },
      },
      locale,
    )
    expect(text(emptyDevin.tree)).toContain(noCatalog)
    expect(nodes(emptyDevin.tree).some((node) => node.type === 'Menu' && node.props.selectedId !== undefined)).toBe(
      false,
    )
    const missing = renderPanel(
      { ...snapshot, settings: { ...snapshot.settings, aiApproval: true }, health: { ...snapshot.health, rows: [] } },
      locale,
    )
    expect(nodes(missing.tree).filter((node) => node.type === 'Switch')).toHaveLength(1)
    expect(text(missing.tree)).toContain(locale.aiApprovalHelp)
    expect(text(missing.tree)).not.toContain(noCatalog)
    const mismatch: AcpPanelSnapshot['health'] = {
      ...snapshot.health,
      rows: [
        {
          ...row,
          reviewVersionUnsupported: true,
          probe: {
            status: 'ok',
            at: 1,
            modelCount: 1,
            authMethods: [],
            agentInfo: { name: 'affogato', version: '3000.14.30822' },
            capabilities: null,
            cleanup: null,
            capabilityHash: null,
            protocolVersion: 1,
            versionCompatibility: null,
            matrix: [],
          },
        },
      ],
    }
    const notice = locale.reviewVersionUnsupported.replace('{name}', config.name).replace('{version}', '3000.14.30822')
    expect(text(renderPanel({ ...snapshot, health: mismatch }, locale).tree)).not.toContain(notice)
    expect(
      text(renderPanel({ settings: { ...snapshot.settings, aiApproval: true }, health: mismatch }, locale).tree),
    ).toContain(notice)
    expect(text(missing.tree)).not.toContain(notice)
    const unsupported = { ...snapshot.health, rows: [], localReviewUnavailable: true as const }
    expect(text(renderPanel({ ...snapshot, health: unsupported }, locale).tree)).not.toContain(
      locale.aiApprovalUnavailable,
    )
    expect(
      text(renderPanel({ health: unsupported, settings: { ...snapshot.settings, aiApproval: true } }, locale).tree),
    ).toContain(locale.aiApprovalUnavailable)
  },
)

it.each([zh, en])('shows a localized retired configuration and keeps explicit deletion available', (locale) => {
  const config = { name: 'Old saved profile', command: 'old-cli', args: [], env: {}, runtime: 'kimi' as const }
  const snapshot: AcpPanelSnapshot = {
    settings: {
      status: 'ready',
      writable: true,
      agents: { old: config },
      aiApproval: false,
      devinReviewModel: 'swe-2-high',
      revision: 1,
    },
    health: {
      status: 'ready',
      rows: [
        {
          id: 'old',
          name: config.name,
          command: config.command,
          args: [],
          loginHint: null,
          executable: false,
          version: null,
          state: 'unavailable',
          unavailableReason: 'agent-retired',
          probe: { status: 'never', at: null },
        },
      ],
      fetchedAt: 1,
      message: undefined,
      checkingAgentIds: [],
      agentErrors: {},
    },
  }
  const { tree } = renderPanel(snapshot, locale)
  expect(text(tree)).toContain(locale.agentConfiguration)
  expect(text(tree)).not.toContain(locale === en ? zh.agentConfiguration : en.agentConfiguration)
  expect(text(tree)).toContain(locale.agentRetired)
  expect(text(tree)).toContain(locale.stateAgentRetired)
  const row = nodes(tree).find((node) => node.props['data-dsh-acp-agent'] === 'old')
  const buttons = nodes(row).filter((node) => node.type === 'Button')
  expect(buttons.find((node) => text(node) === locale.refresh)?.props.disabled).toBe(true)
  const remove = buttons.find((node) => text(node) === locale.remove)
  expect(remove).toBeDefined()
  expect(remove?.props.disabled).toBe(false)
})

it('recovers a failed Host health read even when the user has no configured Agent', () => {
  const { tree, panel } = renderPanel({
    settings: {
      status: 'ready',
      writable: true,
      agents: {},
      aiApproval: false,
      devinReviewModel: 'swe-2-high',
      revision: 1,
    },
    health: {
      status: 'unreachable',
      rows: [],
      fetchedAt: undefined,
      message: 'offline',
      checkingAgentIds: [],
      agentErrors: {},
    },
  })
  const retry = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === en['activity.detailRetry'])
  expect(retry?.props.disabled).toBe(false)
  ;(retry!.props.onClick as () => void)()
  expect(panel.refreshHealth).toHaveBeenCalledExactlyOnceWith(false)
})
