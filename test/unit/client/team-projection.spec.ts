import { expect, it } from 'vitest'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { projectionRevision, teamRoster } from '../../../src/client/ui/team-projection.ts'

const projection = (patch: Partial<TeamProjection> = {}): TeamProjection => ({
  members: [
    { id: 'lead' as never, name: 'Lead', role: 'lead', phase: 'active' },
    { id: 'member' as never, name: 'Member', role: 'teammate', phase: 'active' },
  ],
  tasks: [],
  ...patch,
})

it('distinguishes loading, unavailable, empty, ready, and failed Team projections', () => {
  expect(teamRoster(undefined, true).kind).toBe('loading')
  expect(teamRoster(undefined, false).kind).toBe('unavailable')
  expect(teamRoster(projection({ members: [] }), false).kind).toBe('empty')
  expect(teamRoster(projection(), false)).toMatchObject({ kind: 'ready', members: [{ name: 'Member' }] })
  expect(teamRoster(projection({ failure: 'damaged record' }), false)).toEqual({
    kind: 'failed', message: 'damaged record', members: [], memberIds: ['member'],
  })
})

it('changes its revision when durable member identity or phase changes', () => {
  const before = projection()
  expect(projectionRevision(projection({ members: before.members.map(member => member.id === 'member' ? { ...member, phase: 'failed' } : member) })))
    .not.toBe(projectionRevision(before))
})
