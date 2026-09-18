import { describe, expect, it } from 'vitest'
import { acpSettingsSchema } from '../../../src/host/composition/installed-profile-registry.ts'
import { decodeAcpSettings, draftFromAgent, validateAgentDraft } from '../../../src/client/data/logic.ts'
import { acpLaunchFingerprint, acpLaunchFingerprintsCompatible } from '../../../src/domain/session/launch-fingerprint.ts'

const config = { name: 'Custom', command: 'custom-acp', args: [], env: {} }
describe('retired manual DSH tools configuration', () => {
  it.each([[], ['project_lookup'], ['removed_tool']].map(hostTools => ({ hostTools })))('ignores the saved list %j on both boundaries and removes it on editor save', ({ hostTools }) => {
    const raw = { agents: { custom: { ...config, hostTools } } }
    const settings = acpSettingsSchema(raw)
    expect(settings.agents.custom).toEqual(config)
    const client = decodeAcpSettings(raw)!
    expect(client.agents.custom).toEqual(config)
    const draft = draftFromAgent('custom', client.agents.custom!)
    expect(draft).not.toHaveProperty('hostToolsText')
    expect(validateAgentDraft(draft, client.agents, 'custom').config).toEqual(config)
  })

  it('keeps saved sessions restorable when their retired manual tool list differs', () => {
    const current = acpLaunchFingerprint({ profileId: 'custom', config, env: {} })
    const saved = { ...current, mcpFingerprint: '0123456789abcdef' }
    expect(acpLaunchFingerprintsCompatible(saved, current)).toBe(true)
    expect(saved.mcpFingerprint).toBe('0123456789abcdef')
    expect(acpLaunchFingerprintsCompatible(saved, { ...current, command: 'another-agent' })).toBe(false)
  })
})
