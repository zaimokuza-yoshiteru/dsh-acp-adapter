import { describe, expect, it } from 'vitest'
import {
  agentControlFooter,
  agentControlLabel,
  agentControlMenuGroups,
  formatContextTokenCount,
  toolApprovalPolicyGroup,
} from '../../../src/client/ui/agent-session-controls.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/client/data/acp-remote.ts'
import type { ToolApprovalPolicySnapshot } from '../../../src/client/data/tool-approval-policy-stream.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const t = (key: string, params?: Record<string, unknown>): string => `${key}:${JSON.stringify(params ?? {})}`
const snapshot = (overrides: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: 's',
  profileId: 'claude',
  freshness: 'live',
  editable: true,
  configOptions: null,
  modes: [{ id: 'plan', name: 'Plan' }],
  currentModeId: 'plan',
  contextUsage: null,
  note: null,
  ...overrides,
})

describe('ACP Agent control presentation', () => {
  it('uses the bound Agent model receipt and warns only for a target with a verified capacity risk', () => {
    const value = snapshot({
      configOptions: [
        {
          type: 'select',
          id: 'engine',
          category: 'model',
          name: 'Engine',
          currentValue: 'b',
          options: [
            { value: 'a', name: 'Large' },
            { value: 'b', name: 'Small' },
          ],
        },
      ],
      managedModel: {
        optionId: 'engine',
        confirmed: 'a',
        capacityRisks: [{ model: 'b', lastUsed: 16280, targetSize: 12288 }],
      },
    })
    for (const dictionary of [en, zh]) {
      const t = (key: keyof typeof zh) => dictionary[key]
      expect(agentControlLabel(value, t)).toBe('Large')
      const group = agentControlMenuGroups(value, t).find((g) => g.kind === 'model')!
      expect(group.name).toBe(dictionary.teamModelLabel)
      expect(group.choices).toMatchObject([
        { current: true, write: { kind: 'config', id: 'engine', value: 'a' } },
        { current: false, capacityRisk: { lastUsed: 16280, targetSize: 12288 } },
      ])
      expect(group.choices[0]?.capacityRisk).toBeUndefined()
      expect(
        agentControlMenuGroups(value, t, false)
          .find((g) => g.kind === 'model')
          ?.choices.every((c) => c.disabled),
      ).toBe(true)
      expect(
        agentControlLabel(
          { ...value, managedModel: { optionId: 'engine', confirmed: null, requested: 'b', recovery: 'unconfirmed' } },
          t,
        ),
      ).toBe(dictionary.managedModelUnconfirmed)
    }
    const { managedModel: _, ...named } = value
    expect(agentControlMenuGroups(named, t).every((g) => g.kind !== 'model')).toBe(true)
  })

  it('uses live reasoning options for the confirmed Agent and lets a dormant session reverify only its model', () => {
    const value = snapshot({
      managedModel: { optionId: 'engine', confirmed: 'a' },
      configOptions: [
        {
          type: 'select',
          id: 'engine',
          category: 'model',
          name: 'Model',
          currentValue: 'a',
          options: [{ value: 'a', name: 'A' }],
        },
        {
          type: 'select',
          id: 'effort',
          category: 'thought_level',
          name: 'Reasoning',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
      ],
    })
    const live = agentControlMenuGroups(value, t)
    expect(live.find((g) => g.id === 'config:effort')?.choices[0]).toMatchObject({
      current: true,
      disabled: false,
      requiresModelAccess: true,
    })
    const cold = agentControlMenuGroups({ ...value, freshness: 'stale', editable: false }, t)
    expect(cold.find((g) => g.id === 'config:effort')).toBeUndefined()
    expect(cold.find((g) => g.kind === 'model')?.choices[0]?.disabled).toBe(false)
    expect(cold.find((g) => g.kind === 'mode')?.choices[0]?.disabled).toBe(true)
    const unknown = agentControlMenuGroups(
      { ...value, managedModel: { optionId: 'engine', confirmed: null, requested: 'b' } },
      t,
    )
    expect(unknown.find((g) => g.id === 'config:effort')).toBeUndefined()
  })

  it('distinguishes the free and paid variants in the trigger and menu when the Agent gives them the same name', () => {
    const value = snapshot({
      managedModel: { optionId: 'model', confirmed: 'hy4flash-free' },
      configOptions: [
        {
          id: 'model',
          type: 'select',
          category: 'model',
          name: 'Model',
          currentValue: 'hy4flash-free',
          options: [
            { value: 'hy4flash-free', name: 'Hy4 flash', description: 'x0.00 credits' },
            { value: 'hy4flash', name: 'Hy4 flash', description: 'x0.03 credits' },
          ],
        },
      ],
    })
    const settings = agentControlMenuGroups(value, t)
    expect(settings.find((g) => g.kind === 'model')?.choices.map((item) => item.label)).toEqual([
      'Hy4 flash · hy4flash-free',
      'Hy4 flash · hy4flash',
    ])
    expect(agentControlLabel(value, t, settings)).toBe('Hy4 flash · hy4flash-free')
  })
  it('presents session approval policy in both locales and keeps inherited Lead policy read-only', () => {
    const policy: ToolApprovalPolicySnapshot = { sessionId: 's', policy: 'auto', source: 'lead', editable: false }
    for (const dictionary of [zh, en]) {
      const group = toolApprovalPolicyGroup(policy, (key) => dictionary[key])
      expect(group).toMatchObject({
        kind: 'policy',
        id: 'tool-approval-policy',
        current: dictionary.toolApprovalAuto,
        description: dictionary.toolApprovalInherited,
      })
      expect(group.choices).toMatchObject([
        { current: true, disabled: true, write: { kind: 'tool-approval-policy', policy: 'auto' } },
        { current: false, disabled: true, write: { kind: 'tool-approval-policy', policy: 'ask' } },
      ])
    }
  })

  it('labels config-only modes and prefers canonical config updates over a legacy mode snapshot', () => {
    const value = {
      sessionId: 's',
      profileId: 'generic',
      freshness: 'live' as const,
      editable: false,
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select' as const,
          currentValue: 'plan',
          options: [{ value: 'plan', name: 'Plan' }],
        },
      ],
      modes: null,
      currentModeId: null,
      contextUsage: null,
      note: null,
    }
    expect(agentControlLabel(value, (key) => key)).toBe('agentControlTitle · Plan')
    expect(
      agentControlLabel({ ...value, modes: [{ id: 'code', name: 'Code' }], currentModeId: 'code' }, (key) => key),
    ).toBe('agentControlTitle · Plan')
  })

  it('shows Agent mode separately from DSH permissions and context/cumulative cost', () => {
    const value = snapshot({
      contextUsage: { used: 12, size: 100, percent: 12, cost: { amount: 0.42, currency: 'USD' } },
    })
    expect(agentControlLabel(value, t)).toBe('agentControlTitle:{} · Plan')
    expect(agentControlFooter(value, t).map((item) => item.text)).toEqual([
      'agentContextUsage:{"used":"0.012k","size":"0.1k","percent":12}',
      'agentSessionCost:{"amount":0.42,"currency":"USD"}',
    ])
  })

  it('localizes adapter-owned boolean and fallback labels while preserving Agent names', () => {
    for (const dictionary of [zh, en]) {
      const translate = (key: keyof typeof zh) => dictionary[key]
      const value = snapshot({
        modes: [],
        currentModeId: null,
        configOptions: [{ type: 'boolean', id: 'flag', name: 'Agent supplied label', currentValue: true }],
      })
      expect(agentControlLabel(value, translate)).toBe(
        `${dictionary.agentControlTitle} · ${dictionary.agentControlDefault}`,
      )
      expect(agentControlMenuGroups(value, translate)[0]).toMatchObject({
        name: 'Agent supplied label',
        current: dictionary.agentControlOn,
      })
      expect(
        agentControlMenuGroups(
          {
            ...value,
            configOptions: [{ type: 'boolean', id: 'flag', name: 'Agent supplied label', currentValue: false }],
          },
          translate,
        )[0],
      ).toMatchObject({ name: 'Agent supplied label', current: dictionary.agentControlOff })
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
    expect(agentControlFooter(value, t).map((item) => item.id)).toEqual(['context-usage', 'stale'])
  })

  it('prefers configOptions.mode over the duplicate legacy modes roster', () => {
    const value = snapshot({
      modes: [
        { id: 'accept-edits', name: 'Code' },
        { id: 'ask', name: 'Ask' },
      ],
      currentModeId: 'accept-edits',
      configOptions: [
        {
          type: 'select',
          id: 'mode',
          name: 'Session Mode',
          category: 'mode',
          currentValue: 'accept-edits',
          options: [
            { value: 'accept-edits', name: 'Code' },
            { value: 'ask', name: 'Ask' },
          ],
        },
      ],
    })
    expect(agentControlMenuGroups(value, t).flatMap((group) => group.choices.map((item) => item.id))).toEqual([
      'config:mode:accept-edits',
      'config:mode:ask',
    ])
  })

  it('keeps legacy modes as the fallback when no mode config option exists', () => {
    const value = snapshot({
      modes: [
        { id: 'plan', name: 'Plan' },
        { id: 'ask', name: 'Ask' },
      ],
      configOptions: [],
    })
    expect(agentControlMenuGroups(value, t).flatMap((group) => group.choices.map((item) => item.id))).toEqual([
      'mode:plan',
      'mode:ask',
    ])
  })

  it('keeps independent settings grouped, selected and read-only when stale', () => {
    const groups = agentControlMenuGroups(
      snapshot({
        freshness: 'stale',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'm',
            options: [{ value: 'm', name: 'Model' }],
          },
          {
            id: 'collaboration',
            name: 'Collaboration mode',
            type: 'select',
            currentValue: 'plan',
            options: [
              {
                group: 'work',
                name: 'Work modes',
                options: [{ value: 'plan', name: 'Plan', description: 'Plan before acting' }],
              },
            ],
          },
          { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false },
        ],
      }),
      (key) => en[key],
    )
    expect(groups.map((group) => group.name)).toEqual(['Mode', 'Collaboration mode', 'Fast mode'])
    expect(groups[1]?.choices[0]).toMatchObject({
      current: true,
      disabled: true,
      group: 'Work modes',
      description: 'Plan before acting',
    })
    expect(groups[2]?.choices).toMatchObject([
      { label: 'Off', current: true, write: { kind: 'config', id: 'fast', value: false } },
      { label: 'On', current: false, write: { kind: 'config', id: 'fast', value: true } },
    ])
  })

  it.each([undefined, 'vendor-choice'])(
    'keeps generic model-named controls visible without a known category (%s)',
    (category) => {
      const groups = agentControlMenuGroups(
        snapshot({
          modes: [],
          configOptions: [
            {
              id: 'model',
              name: 'Vendor choice',
              type: 'select',
              ...(category === undefined ? {} : { category }),
              currentValue: 'one',
              options: [
                { value: 'one', name: 'One' },
                { value: 'two', name: 'Two' },
              ],
            },
          ],
        }),
        (key) => en[key],
      )
      expect(groups).toMatchObject([
        {
          name: 'Vendor choice',
          choices: [
            { current: true, disabled: false, write: { kind: 'config', id: 'model', value: 'one' } },
            { current: false, disabled: false, write: { kind: 'config', id: 'model', value: 'two' } },
          ],
        },
      ])
    },
  )
})
