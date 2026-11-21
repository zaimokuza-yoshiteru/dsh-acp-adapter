import { describe, expect, it } from 'vitest'
import {
  agentControlFooter,
  agentControlLabel,
  agentControlMenuGroups,
  formatContextTokenCount,
  lastSuccessfulModelChoice,
  primaryAgentControlGroup,
} from '../../../src/client/ui/agent-session-controls.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/client/data/acp-remote.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'
import {
  beginFirstTurnIntent,
  confirmsFirstTurnIntent,
  finishFirstTurnIntent,
  firstTurnIntentKey,
  readFirstTurnIntent,
} from '../../../src/client/data/first-turn-intent.ts'

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
  it('reconciles an unknown write only against a newer Host revision with the same intent', () => {
    const key = firstTurnIntentKey('session', 'acp-test')
    const other = firstTurnIntentKey('other', 'acp-test')
    const choice = { kind: 'config' as const, id: 'approval', value: 'ask' }
    const intent = beginFirstTurnIntent(key, 2, choice)
    expect(confirmsFirstTurnIntent(snapshot(), intent)).toBe(false)
    expect(confirmsFirstTurnIntent(snapshot({ firstPromptCommitted: true }), intent)).toBe(true)
    expect(confirmsFirstTurnIntent(snapshot({ freshness: 'stale' }), intent)).toBe(false)
    expect(readFirstTurnIntent(other)).toBeNull()
    expect(confirmsFirstTurnIntent(snapshot({ preselectionRevision: 2, preselected: [choice] }), intent)).toBe(false)
    expect(
      confirmsFirstTurnIntent(
        snapshot({ preselectionRevision: 3, preselected: [{ ...choice, value: 'code' }] }),
        intent,
      ),
    ).toBe(false)
    expect(confirmsFirstTurnIntent(snapshot({ preselectionRevision: 3, preselected: [choice] }), intent)).toBe(true)
    const clear = beginFirstTurnIntent(key, 3, null)
    finishFirstTurnIntent(key, intent)
    expect(readFirstTurnIntent(key)).toBe(clear)
    expect(confirmsFirstTurnIntent(snapshot({ preselectionRevision: 4, preselected: [choice] }), clear)).toBe(false)
    expect(confirmsFirstTurnIntent(snapshot({ preselectionRevision: 4 }), clear)).toBe(true)
    finishFirstTurnIntent(key, clear)
    expect(readFirstTurnIntent(key)).toBeNull()
  })
  it('prefers the Agent permission option to its mode and enables only editable first-turn discovery', () => {
    const permission = {
      type: 'select' as const,
      id: 'approval-mode',
      name: 'Tool approvals',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask before use' },
        { value: 'edit', name: 'Allow edits' },
      ],
    }
    const discovery = snapshot({ preselection: true, freshness: 'stale', configOptions: [permission] })
    const primary = primaryAgentControlGroup(agentControlMenuGroups(discovery, t))
    expect(primary?.choices.map((choice) => [choice.label, choice.disabled])).toEqual([
      ['Ask before use', false],
      ['Allow edits', false],
    ])
    expect(agentControlFooter(discovery, t)).toEqual([])
    const stale = snapshot({ freshness: 'stale', editable: false, configOptions: [permission] })
    expect(primaryAgentControlGroup(agentControlMenuGroups(stale, t))?.choices.every((choice) => choice.disabled)).toBe(
      true,
    )
    expect(
      primaryAgentControlGroup(
        agentControlMenuGroups({ ...discovery, configOptions: [{ ...permission, options: [] }] }, t),
      )?.kind,
    ).toBe('mode')
    expect(
      primaryAgentControlGroup(
        agentControlMenuGroups({ ...discovery, modes: null, configOptions: [{ ...permission, id: 'theme' }] }, t),
      ),
    ).toBeUndefined()
  })
  it('leaves model and reasoning in the native picker, including on old Agent-managed conversations', () => {
    const value = snapshot({
      managedModel: { optionId: 'engine', confirmed: 'large' },
      configOptions: [
        {
          type: 'select',
          id: 'engine',
          name: 'Engine',
          currentValue: 'large',
          options: [{ value: 'large', name: 'Large' }],
        },
        {
          type: 'select',
          id: 'depth',
          category: 'thought_level',
          name: 'Depth',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
      ],
    })
    for (const dictionary of [en, zh]) {
      const t = (key: keyof typeof zh) => dictionary[key]
      expect(agentControlLabel(value, t)).toBe(`${dictionary.agentControlTitle} · Plan`)
      expect(agentControlMenuGroups(value, t).map(({ kind }) => kind)).toEqual(['mode'])
    }
  })

  it('offers only the previous delivered model for recovery and preserves its capacity warning and unambiguous label', () => {
    const value = snapshot({
      freshness: 'stale',
      editable: false,
      managedModel: {
        optionId: 'engine',
        confirmed: null,
        lastSuccessfulModel: 'flash-free',
        capacityRisks: [{ model: 'flash-free', lastUsed: 16280, targetSize: 12288 }],
      },
      configOptions: [
        {
          type: 'select',
          id: 'engine',
          name: 'Engine',
          currentValue: 'flash',
          options: [
            { value: 'flash-free', name: 'Flash' },
            { value: 'flash', name: 'Flash' },
          ],
        },
      ],
    })
    expect(lastSuccessfulModelChoice(value)).toMatchObject({
      label: 'Flash · flash-free',
      write: { kind: 'config', id: 'engine', value: 'flash-free' },
      current: false,
      disabled: false,
      capacityRisk: { lastUsed: 16280, targetSize: 12288 },
    })
    expect(lastSuccessfulModelChoice({ ...value, configOptions: [] })).toBeUndefined()
    expect(
      lastSuccessfulModelChoice({ ...value, managedModel: { optionId: 'engine', confirmed: 'flash' } }),
    ).toBeUndefined()
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
