import { describe, expect, it } from 'vitest'
import { permitsTeamReviewTool, type TeamReviewScope } from '../../e2e/live-long-task-team-scope.ts'

const scope: TeamReviewScope = {
  role: 'lead',
  sources: {
    'runtime-reader': ['/public/a', '/public/b', '/public/c'],
    'teams-reader': ['/public/d', '/public/e', '/public/f'],
  },
  reportMarkers: { 'runtime-reader': 'REPORT_RUNTIME', 'teams-reader': 'REPORT_TEAMS' },
  tasks: [
    { id: 'runtime-task', ownerName: 'runtime-reader' },
    { id: 'teams-task', ownerName: 'teams-reader' },
  ],
}
const child = { ...scope, role: 'runtime-reader' as const }

describe('real B permission responder scope', () => {
  it('allows the assigned read and normal member task lifecycle', () => {
    expect(permitsTeamReviewTool('read', { file_path: '/public/a' }, child)).toBe(true)
    expect(permitsTeamReviewTool('team_task_get', { task_id: 'runtime-task' }, child)).toBe(true)
    for (const action of ['claim', 'edit', 'complete'])
      expect(
        permitsTeamReviewTool('team_task_update', { task_id: 'runtime-task', expected_revision: 2, action }, child),
      ).toBe(true)
    expect(permitsTeamReviewTool('send_message', { target: 'lead', message: 'REPORT_RUNTIME /public/a' }, child)).toBe(
      true,
    )
  })
  it('allows only the requested fresh lead delegation', () => {
    const args = {
      name: 'runtime-reader',
      description: 'Read runtime',
      prompt: '/public/a /public/b /public/c REPORT_RUNTIME',
    }
    expect(permitsTeamReviewTool('spawn_teammate', args, scope)).toBe(true)
    expect(permitsTeamReviewTool('spawn_teammate', { ...args, context: 'fork' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('spawn_teammate', args, child)).toBe(false)
    expect(permitsTeamReviewTool('spawn_teammate', { ...args, prompt: 'Run unknown shell' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('spawn_teammate', { ...args, provider: 'other' }, scope)).toBe(false)
  })
  it('refuses foreign owners, foreign paths, execution, writes and destructive task transitions', () => {
    expect(permitsTeamReviewTool('read', { file_path: '/public/d' }, child)).toBe(false)
    expect(permitsTeamReviewTool('read', { file_path: '/credentials' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('bash', { command: 'anything' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('write', { file_path: '/public/a', content: '' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('team_task_get', { task_id: 'foreign-task' }, scope)).toBe(false)
    expect(permitsTeamReviewTool('team_task_get', { task_id: 'teams-task' }, child)).toBe(false)
    for (const action of ['delete', 'reopen', 'set_dependencies'])
      expect(
        permitsTeamReviewTool('team_task_update', { task_id: 'runtime-task', expected_revision: 2, action }, scope),
      ).toBe(false)
    expect(
      permitsTeamReviewTool(
        'team_task_update',
        { task_id: 'runtime-task', expected_revision: 2, action: 'complete' },
        scope,
      ),
    ).toBe(false)
    expect(permitsTeamReviewTool('send_message', { target: 'outside-member', message: 'hello' }, scope)).toBe(false)
  })
  it('does not approve an extra scope hidden in otherwise valid task arguments', () => {
    const args = { subject: 'Runtime', description: '/public/a /public/b /public/c REPORT_RUNTIME' }
    expect(permitsTeamReviewTool('team_task_create', args, scope)).toBe(true)
    expect(permitsTeamReviewTool('team_task_create', { ...args, write_scopes: ['.'] }, scope)).toBe(false)
    expect(permitsTeamReviewTool('team_task_create', { ...args, blocked_by: ['foreign-task'] }, scope)).toBe(false)
    expect(permitsTeamReviewTool('team_task_create', { ...args, command: 'extra' }, scope)).toBe(false)
  })
})
