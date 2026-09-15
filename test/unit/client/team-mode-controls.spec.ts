import { expect, it, vi } from 'vitest'
import { applyTeamMode, teamModeChoices } from '../../../src/client/ui/team-mode-controls.ts'
import { teamModeLabel } from '../../../src/contract/session-modes.ts'
import type { AcpAgentSessionSnapshotView, AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'
const snapshot = (patch: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({ sessionId: 'a', profileId: 'devin', freshness: 'live', editable: true, configOptions: null, modes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }], currentModeId: 'code', contextUsage: null, note: null, ...patch })
const member = (sessionId: string, patch: Partial<AcpTeamMemberView> = {}): AcpTeamMemberView => ({ sessionId, profileId: 'devin', name: sessionId, status: 'idle', model: null, description: null, ...patch })
it('limits the menu to canonical modes, without model, reasoning or unrelated settings', () => {
  const choices = teamModeChoices(snapshot({ configOptions: [
    { id: 'model', type: 'select', name: 'Model', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] },
    { id: 'custom-mode', category: 'mode', type: 'select', name: 'Session Mode', currentValue: 'code', options: [{ value: 'plan', name: 'Plan' }] },
  ] }))
  expect(choices).toEqual([{ id: 'plan', name: 'Plan', label: 'Session Mode: Plan', current: false, write: { kind: 'config', id: 'custom-mode', value: 'plan' } }])
})
it('labels pending modes first while preserving confirmed values outside the advertised roster', () => {
  expect(teamModeLabel(snapshot({ pendingModeId: 'plan' }), 'Unknown')).toBe('Plan')
  expect(teamModeLabel(snapshot({ pendingModeId: 'removed' }), 'Unknown')).toBe('Code')
  expect(teamModeLabel(snapshot({ currentModeId: 'confirmed', modes: [] }), 'Unknown')).toBe('confirmed')
  expect(teamModeLabel(snapshot({ configOptions: [{ id: 'mode', type: 'select', name: 'Mode', currentValue: 'confirmed', options: [] }], modes: null, currentModeId: null }), 'Unknown')).toBe('confirmed')
})
it('changes captured compatible members once and never includes other profiles or late arrivals', async () => {
  const write = vi.fn(async () => {})
  const result = await applyTeamMode({ targets: ['a', 'a', 'other', 'running', 'gone'], profileId: 'devin', mode: 'plan', isCurrent: () => true,
    members: async () => [member('a'), member('other', { profileId: 'kimi' }), member('running', { status: 'running' }), member('late')],
    snapshot: async () => snapshot(), write })
  expect(result).toEqual({ applied: 1, skipped: 3, failed: 0 })
  expect(write).toHaveBeenCalledExactlyOnceWith('a', { kind: 'mode', id: 'plan' })
})
it('skips stale, busy, unsupported and already selected modes; isolates individual failures', async () => {
  const ids = ['stale', 'busy', 'unsupported', 'same', 'failed', 'ok']
  const write = vi.fn(async (id: string) => { if (id === 'failed') throw new Error('protocol disconnected') })
  const result = await applyTeamMode({ targets: ids, profileId: 'devin', mode: 'plan', isCurrent: () => true,
    members: async () => ids.map(id => member(id)), snapshot: async id => snapshot(id === 'stale' ? { freshness: 'stale' } : id === 'busy' ? { editable: false } : id === 'unsupported' ? { modes: [] } : id === 'same' ? { currentModeId: 'plan' } : {}), write })
  expect(result).toEqual({ applied: 1, skipped: 4, failed: 1 })
  expect(write).toHaveBeenLastCalledWith('ok', { kind: 'mode', id: 'plan' })
})
it('revalidates before every write and stops when the active conversation changes', async () => {
  let active = true
  const write = vi.fn(async () => { active = false })
  expect(await applyTeamMode({ targets: ['a', 'b'], profileId: 'devin', mode: 'plan', isCurrent: () => active,
    members: async () => [member('a'), member('b')], snapshot: async () => snapshot(), write })).toEqual({ applied: 1, skipped: 1, failed: 0 })
  expect(write).toHaveBeenCalledTimes(1)
})
it('rejects a profile change while a snapshot request is in flight', async () => {
  const write = vi.fn()
  expect(await applyTeamMode({ targets: ['a'], profileId: 'devin', mode: 'plan', isCurrent: () => true,
    members: async () => [member('a')], snapshot: async () => snapshot({ profileId: 'kimi' }), write })).toEqual({ applied: 0, skipped: 1, failed: 0 })
  expect(write).not.toHaveBeenCalled()
})

it('saves dormant member modes and allows replacing a pending mode with the last reported mode', async () => {
  const write = vi.fn(async () => {})
  const result = await applyTeamMode({ targets: ['sleeping'], profileId: 'devin', mode: 'code', isCurrent: () => true,
    members: async () => [member('sleeping', { status: 'inactive' })],
    snapshot: async () => snapshot({ freshness: 'stale', editable: false, modeWritable: true, pendingModeId: 'plan' }), write })
  expect(result).toEqual({ applied: 1, skipped: 0, failed: 0 })
  expect(write).toHaveBeenCalledWith('sleeping', { kind: 'mode', id: 'code' })
})
