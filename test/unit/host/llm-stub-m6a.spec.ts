import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { boundedProbeDiagnostic, disambiguateProbeModels, probeModels, reasoningInfoFromConfigOptions } from '../../../src/host/composition/llm-stub.ts'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { acpConfigOptionsSnapshot } from '../../../src/domain/session/acp-config-options.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'

const config: AcpAgentConfig = { name: 'Test', command: 'agent', args: [], env: {} }
const effortOption = (category: string | undefined = 'thought_level', currentValue = 'high', id = 'thinking'): acp.SessionConfigOption => ({
  id, name: 'Thinking', type: 'select', currentValue,
  ...(category === undefined ? {} : { category }),
  options: [
    { value: 'low', name: 'Low', description: 'low effort' },
    { value: 'high', name: 'High' },
    { group: 'advanced', name: 'Advanced', options: [{ value: 'high', name: 'Duplicate' }, { value: 'max', name: 'Max' }] },
  ] as acp.SessionConfigSelectOptions,
})

describe('ACP catalog reasoning metadata', () => {
  it.each(['codex', 'claude', 'kimi'])('maps %s thought_level to DSH reasoning metadata', (profileId) => {
    const info = reasoningInfoFromConfigOptions(profileId, config, [effortOption()])
    expect(info?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'max'])
    expect(info?.defaultEffort).toBe('high')
    expect(info?.efforts[0]?.name).toBe('Low')
  })

  it('maps a proven generic reasoning_effort id without translating Agent labels', () => {
    const info = reasoningInfoFromConfigOptions('my-agent', config, [effortOption(undefined, 'max', 'reasoning_effort')])
    expect(info?.defaultEffort).toBe('max')
    expect(info?.efforts.map((effort) => effort.name)).toEqual(['Low', 'High', 'Max'])
  })

  it('omits Devin reasoning because its model ids encode the effort', () => {
    expect(reasoningInfoFromConfigOptions('devin', config, [effortOption()])).toBeUndefined()
  })

  it('omits an empty or unknown option and does not invent a default', () => {
    expect(reasoningInfoFromConfigOptions('codex', config, [{ id: 'x', name: 'X', type: 'select', currentValue: 'x', options: [] }])).toBeUndefined()
    expect(reasoningInfoFromConfigOptions('codex', config, [effortOption('other', 'missing', 'other')])).toEqual(undefined)
  })

  it('keeps probe snapshots bounded and removes metadata/secret text', () => {
    const snapshot = acpConfigOptionsSnapshot([{
      ...effortOption(),
      description: `Bearer ${'x'.repeat(80)}`,
      _meta: { opaque: 'should not persist' },
      options: [{ value: `sk-${'s'.repeat(32)}`, name: `name-${'n'.repeat(32)}`, description: `sk-${'s'.repeat(32)}` }],
    } as acp.SessionConfigOption])
    expect(snapshot?.[0]).not.toHaveProperty('_meta')
    expect(snapshot?.[0]?.description).toBe(`Bearer ${'x'.repeat(80)}`)
    expect(snapshot?.[0]?.type === 'select' ? snapshot[0].options[0] : undefined).toMatchObject({ value: `sk-${'s'.repeat(32)}`, name: `name-${'n'.repeat(32)}`, description: `sk-${'s'.repeat(32)}` })
  })
})

describe('ACP model display labels', () => {
  const model = (id: string, name: string, description?: string): LlmModelInfo => ({ provider: 'acp-test', id, name, ...(description === undefined ? {} : { description }) })

  it('only disambiguates duplicate names within one profile and keeps ids/values intact', () => {
    const result = disambiguateProbeModels([
      model('a', 'Claude'), model('b', 'Claude'), model('unique', 'Unique'),
    ])
    expect(result.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'a', name: 'Claude · a' }, { id: 'b', name: 'Claude · b' }, { id: 'unique', name: 'Unique' },
    ])
  })

  it('uses a short description when a duplicate value is itself the display name', () => {
    const result = disambiguateProbeModels([
      model('same', 'same', 'Fast mode\nextra detail'), model('other', 'same'),
    ])
    expect(result[0]?.name).toBe('same · Fast mode')
    expect(result[1]?.name).toBe('same · other')
  })

  it('does not manufacture a supplier label or drop a duplicate lacking description', () => {
    const result = disambiguateProbeModels([model('x', 'Model'), model('y', 'Model')])
    expect(result.map(item => item.id)).toEqual(['x', 'y'])
    expect(result.map(item => item.name)).toEqual(['Model · x', 'Model · y'])
  })

  it('flattens grouped model config options without name-based deduplication', () => {
    const models = probeModels('acp-test', [{
      id: 'model', name: 'Model', type: 'select', currentValue: 'one', category: 'model',
      options: [{ group: 'general', name: 'General', options: [
        { value: 'one', name: 'Same' }, { value: 'two', name: 'Same' },
      ] }],
    }])
    expect(models.map(item => item.id)).toEqual(['one', 'two'])
    expect(models.map(item => item.name)).toEqual(['Same · one', 'Same · two'])
  })
})

describe('ACP probe diagnostics', () => {
  it('keeps only a redacted, bounded first line for protocol errors', () => {
    const value = boundedProbeDiagnostic(`Bearer ${'x'.repeat(80)}\n${'secret '.repeat(100)}`)
    expect(value).not.toContain('x'.repeat(20))
    expect(value).not.toContain('\n')
    expect(value.length).toBeLessThanOrEqual(240)
  })
})
