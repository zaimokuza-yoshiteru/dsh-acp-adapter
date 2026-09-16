import { describe, expect, it } from 'vitest'
import { acpSettingsSchema } from '../../../src/host/composition/installed-profile-registry.ts'
import { decodeAcpSettings, draftFromAgent, validateAgentDraft } from '../../../src/client/data/logic.ts'
import { profileLaunchIdentityHash } from '../../../src/domain/session/launch-fingerprint.ts'

const config = { name: 'Custom', command: 'custom-acp', args: [], env: {} }
describe('explicit DSH tools configuration', () => {
  it('preserves selected tools through host settings and the native editor', () => {
    const settings = acpSettingsSchema({ agents: { custom: { ...config, hostTools: ['project_lookup'] } } })
    const client = decodeAcpSettings(settings)!
    const draft = draftFromAgent('custom', client.agents.custom!)
    expect(validateAgentDraft(draft, client.agents, 'custom').config?.hostTools).toEqual(['project_lookup'])
    expect(validateAgentDraft({ ...draft, hostToolsText: '' }, client.agents, 'custom').config?.hostTools).toBeUndefined()
  })
  it('rejects invalid or duplicate tools on both settings boundaries', () => {
    for (const hostTools of [['a', 'a'], ['a b'], [1]]) {
      const input = { agents: { custom: { ...config, hostTools } } }
      expect(() => acpSettingsSchema(input)).toThrow('hostTools')
      expect(decodeAcpSettings(input)).toBeUndefined()
    }
    expect(validateAgentDraft({ ...draftFromAgent('custom', config), hostToolsText: 'one\none' }, {}, undefined).hostTools?.key).toBe('errorHostTools')
  })
  it('changes connection identity only when the selected tool set changes', () => {
    const hash = (hostTools?: string[]) => profileLaunchIdentityHash('custom', { ...config, ...(hostTools === undefined ? {} : { hostTools }) }, {})
    expect(hash([])).toBe(hash())
    expect(hash(['a', 'b'])).toBe(hash(['b', 'a']))
    expect(hash(['a'])).not.toBe(hash())
    expect(hash(['b'])).not.toBe(hash(['a']))
  })
})
