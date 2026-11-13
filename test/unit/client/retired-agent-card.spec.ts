import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'Button',
  Input: 'Input',
  Menu: 'Menu',
  Tag: 'Tag',
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
it.each([zh, en])('shows a localized retired configuration and keeps explicit deletion available', (locale) => {
  const config = { name: 'Old saved profile', command: 'old-cli', args: [], env: {}, runtime: 'kimi' as const }
  const snapshot: AcpPanelSnapshot = {
    settings: { status: 'ready', writable: true, agents: { old: config }, toolApprovalDefault: 'auto', revision: 1 },
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
  const panel: AcpSectionWire = {
    refreshHealth: vi.fn(),
    refreshAgentHealth: vi.fn(),
    saveAgent: vi.fn(),
    deleteAgent: vi.fn(),
    setToolApprovalDefault: vi.fn(),
    countBoundSessions: vi.fn(),
  }
  const tree = expand(AcpSection({ t: (key) => locale[key], useStore: (selector) => selector(snapshot), panel }))
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
