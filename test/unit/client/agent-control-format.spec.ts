import { describe, expect, it } from 'vitest'
import {
  agentControlFooter,
  agentControlLabel,
  agentControlMenuItems,
  formatContextTokenCount,
  shouldRefreshAgentControlAfterRun,
} from '../../../src/client/ui/AcpAgentControl.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/client/data/acp-remote.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const t = (key: string, params?: Record<string, unknown>): string => `${key}:${JSON.stringify(params ?? {})}`
const snapshot = (overrides: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: 's', profileId: 'claude', freshness: 'live', editable: true, configOptions: null,
  modes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan', contextUsage: null, note: null, ...overrides,
})

describe('ACP Agent control presentation', () => {
  it('shows Agent mode separately from DSH permissions and context/cumulative cost', () => {
    const value = snapshot({ contextUsage: { used: 12, size: 100, percent: 12, cost: { amount: 0.42, currency: 'USD' } } })
    expect(agentControlLabel(value)).toBe('Agent · Plan')
    expect(agentControlFooter(value, t).map(item => item.text)).toEqual([
      'agentContextUsage:{"used":"0.012k","size":"0.1k","percent":12}',
      'agentSessionCost:{"amount":0.42,"currency":"USD"}',
    ])
  })

  it('formats ACP context counts with k as the minimum unit and m from one million', () => {
    expect(formatContextTokenCount(0)).toBe('0k')
    expect(formatContextTokenCount(12)).toBe('0.012k')
    expect(formatContextTokenCount(999)).toBe('0.999k')
    expect(formatContextTokenCount(1_000)).toBe('1k')
    expect(formatContextTokenCount(14_259)).toBe('14.3k')
    expect(formatContextTokenCount(999_999)).toBe('1000k')
    expect(formatContextTokenCount(1_000_000)).toBe('1m')
    expect(formatContextTokenCount(1_048_576)).toBe('1m')
    expect(formatContextTokenCount(1_250_000)).toBe('1.3m')
  })

  it('marks stale last-reported state and omits cost when Agent did not report it', () => {
    const value = snapshot({ freshness: 'stale', contextUsage: { used: 1, size: 2, percent: 50, cost: null } })
    expect(agentControlFooter(value, t).map(item => item.id)).toEqual(['context-usage', 'stale'])
  })

  it('prefers configOptions.mode over the duplicate legacy modes roster', () => {
    const value = snapshot({
      modes: [{ id: 'accept-edits', name: 'Code' }, { id: 'ask', name: 'Ask' }],
      currentModeId: 'accept-edits',
      configOptions: [{
        type: 'select', id: 'mode', name: 'Session Mode', category: 'mode', currentValue: 'accept-edits',
        options: [{ value: 'accept-edits', name: 'Code' }, { value: 'ask', name: 'Ask' }],
      }],
    })
    expect(agentControlMenuItems(value, t).map(item => item.id)).toEqual([
      'config:mode:accept-edits',
      'config:mode:ask',
    ])
  })

  it('keeps legacy modes as the fallback when no mode config option exists', () => {
    const value = snapshot({
      modes: [{ id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }],
      configOptions: [],
    })
    expect(agentControlMenuItems(value, t).map(item => item.id)).toEqual(['mode:plan', 'mode:ask'])
  })

  it('uses the host run completion as a bounded post-turn refresh signal', () => {
    expect(shouldRefreshAgentControlAfterRun(false, true)).toBe(false)
    expect(shouldRefreshAgentControlAfterRun(true, true)).toBe(false)
    expect(shouldRefreshAgentControlAfterRun(true, false)).toBe(true)
    expect(shouldRefreshAgentControlAfterRun(false, false)).toBe(false)
  })

  it('states that native access is informational and does not control ACP tools', () => {
    expect(zh.agentControlTooltip).toBe('ACP 工具权限由 Agent 管理；DSH 的“原生 Agent 访问”模式仅作说明，不会控制 ACP 工具。')
    expect(en.agentControlTooltip).toBe("ACP tool permissions are managed by the Agent; DSH's Native Agent Access mode is informational and does not control ACP tools.")
  })
})
