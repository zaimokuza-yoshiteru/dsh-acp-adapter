import { describe, expect, it } from 'vitest'
import {
  agentControlFooter,
  agentControlLabel,
  agentControlMenuGroups,
  formatContextTokenCount,
} from '../../../src/client/ui/agent-session-controls.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/client/data/acp-remote.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const t = (key: string, params?: Record<string, unknown>): string => `${key}:${JSON.stringify(params ?? {})}`
const snapshot = (overrides: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: 's', profileId: 'claude', freshness: 'live', editable: true, configOptions: null,
  modes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan', contextUsage: null, note: null, ...overrides,
})

describe('ACP Agent control presentation', () => {
  it('labels config-only modes and prefers canonical config updates over a legacy mode snapshot', () => {
    const value = {
      sessionId: 's', profileId: 'kimi', freshness: 'live' as const, editable: false,
      configOptions: [{ id: 'mode', name: 'Mode', type: 'select' as const, currentValue: 'plan', options: [{ value: 'plan', name: 'Plan' }] }],
      modes: null, currentModeId: null, contextUsage: null, note: null,
    }
    expect(agentControlLabel(value, key => key)).toBe('agentControlTitle · Plan')
    expect(agentControlLabel({ ...value, modes: [{ id: 'code', name: 'Code' }], currentModeId: 'code' }, key => key)).toBe('agentControlTitle · Plan')
  })

  it('shows Agent mode separately from DSH permissions and context/cumulative cost', () => {
    const value = snapshot({ contextUsage: { used: 12, size: 100, percent: 12, cost: { amount: 0.42, currency: 'USD' } } })
    expect(agentControlLabel(value, t)).toBe('agentControlTitle:{} · Plan')
    expect(agentControlFooter(value, t).map(item => item.text)).toEqual([
      'agentContextUsage:{"used":"0.012k","size":"0.1k","percent":12}',
      'agentSessionCost:{"amount":0.42,"currency":"USD"}',
    ])
  })

  it('localizes adapter-owned boolean and fallback labels while preserving Agent names', () => {
    for (const dictionary of [zh, en]) {
      const translate = (key: keyof typeof zh) => dictionary[key]
      const value = snapshot({ modes: [], currentModeId: null, configOptions: [
        { type: 'boolean', id: 'flag', name: 'Agent supplied label', currentValue: true },
      ] })
      expect(agentControlLabel(value, translate)).toBe(`${dictionary.agentControlTitle} · ${dictionary.agentControlDefault}`)
      expect(agentControlMenuGroups(value, translate)[0]).toMatchObject({ name: 'Agent supplied label', current: dictionary.agentControlOn })
      expect(agentControlMenuGroups({ ...value, configOptions: [{ type: 'boolean', id: 'flag', name: 'Agent supplied label', currentValue: false }] }, translate)[0]).toMatchObject({ name: 'Agent supplied label', current: dictionary.agentControlOff })
    }
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
    expect(agentControlMenuGroups(value, t).flatMap(group => group.choices.map(item => item.id))).toEqual([
      'config:mode:accept-edits',
      'config:mode:ask',
    ])
  })

  it('keeps legacy modes as the fallback when no mode config option exists', () => {
    const value = snapshot({
      modes: [{ id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }],
      configOptions: [],
    })
    expect(agentControlMenuGroups(value, t).flatMap(group => group.choices.map(item => item.id))).toEqual(['mode:plan', 'mode:ask'])
  })



  it('keeps independent settings grouped, selected and read-only when stale', () => {
    const groups = agentControlMenuGroups(snapshot({ freshness: 'stale', configOptions: [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] },
      { id: 'collaboration', name: 'Collaboration mode', type: 'select', currentValue: 'plan', options: [
        { group: 'work', name: 'Work modes', options: [{ value: 'plan', name: 'Plan', description: 'Plan before acting' }] },
      ] },
      { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
    ] }), key => en[key])
    expect(groups.map(group => group.name)).toEqual(['Mode', 'Collaboration mode', 'Fast mode'])
    expect(groups[1]?.choices[0]).toMatchObject({ current: true, disabled: true, group: 'Work modes', description: 'Plan before acting' })
    expect(groups[2]?.choices).toMatchObject([
      { label: 'Off', current: true, write: { kind: 'config', id: 'fast', value: false } },
      { label: 'On', current: false, write: { kind: 'config', id: 'fast', value: true } },
    ])
  })
})
