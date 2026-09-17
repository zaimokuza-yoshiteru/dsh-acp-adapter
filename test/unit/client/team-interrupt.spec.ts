import { expect, it, vi } from 'vitest'
import { interruptTeam } from '../../../src/client/ui/team-interrupt.ts'
import type { AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'

const member = (sessionId: string, patch: Partial<AcpTeamMemberView> = {}): AcpTeamMemberView => ({
  sessionId, profileId: 'devin', name: sessionId, status: 'running', model: null, description: null, ...patch,
})

it('interrupts all captured running teammates across profiles, excluding the lead, idle and removed members', async () => {
  const interrupt = vi.fn(async () => {})
  const result = await interruptTeam({
    lead: 'lead', targets: ['lead', 'a', 'a', 'b', 'native', 'idle', 'gone'], isCurrent: () => true,
    members: async () => [member('lead'), member('a'), member('b', { profileId: 'codex' }), member('native', { profileId: null }), member('idle', { status: 'idle' }), member('late')],
    interrupt,
  })
  expect(interrupt.mock.calls).toEqual([['a'], ['b'], ['native']])
  expect(result).toEqual({ accepted: 3, skipped: 2, failed: 0 })
})

it('does not interrupt after navigation during a roster refresh', async () => {
  let active = true
  const interrupt = vi.fn(async () => {})
  const result = await interruptTeam({ lead: 'lead', targets: ['a'], isCurrent: () => active,
    members: async () => { active = false; return [member('a')] }, interrupt })
  expect(interrupt).not.toHaveBeenCalled()
  expect(result).toEqual({ accepted: 0, skipped: 1, failed: 0 })
})

it('isolates an unauthorized or disconnected member without blocking other interrupts', async () => {
  const interrupt = vi.fn(async (id: string) => { if (id === 'a') throw new Error('subagent/unauthorized') })
  expect(await interruptTeam({ lead: 'lead', targets: ['a', 'b'], isCurrent: () => true,
    members: async () => [member('a'), member('b')], interrupt })).toEqual({ accepted: 1, skipped: 0, failed: 1 })
})

it('fails closed when the roster cannot be refreshed', async () => {
  const interrupt = vi.fn(async () => {})
  await expect(interruptTeam({ lead: 'lead', targets: ['a'], isCurrent: () => true,
    members: async () => { throw new Error('offline') }, interrupt })).rejects.toThrow('offline')
  expect(interrupt).not.toHaveBeenCalled()
})
