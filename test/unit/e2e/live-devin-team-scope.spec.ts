import { expect, it } from 'vitest'
import { summarizeRawInputForAudit } from '../../../src/domain/policy/events.ts'
import {
  exactOnceOption,
  intactPermissionInput,
  permitsDevinTeamTool,
  type DevinTeamScope,
} from '../../e2e/live-devin-team-scope.ts'

const base: DevinTeamScope = {
  role: 'lead',
  token: 'TEAM_test',
  memberName: 'calculator',
  provider: 'acp-devin',
  model: 'swe-2-high',
  tasks: [],
  childExists: false,
  messageSent: false,
}
const compute = { id: 'compute', subject: 'Compute TEAM_test', revision: 1, status: 'pending', ready: true }
const review = { id: 'review', subject: 'Review TEAM_test', revision: 1, status: 'pending', ready: false }
const scope = { ...base, tasks: [compute, review] }

it('selects only the unique original allow_once among all seven Devin choices', () => {
  const choices = [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' as const },
    ...['tool-session', 'tool-always', 'server-session', 'server-always', 'bypass'].map((id) => ({
      optionId: id,
      name: id,
      kind: 'allow_always' as const,
    })),
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
  ]
  expect(exactOnceOption(choices)).toBe(choices[0])
  expect(() =>
    exactOnceOption([{ optionId: 'bypass', kind: 'allow_once', name: 'Yes, switch to bypass mode' }]),
  ).toThrow('ONCE_AMBIGUOUS')
  expect(() => exactOnceOption(choices.slice(1))).toThrow('ONCE_AMBIGUOUS')
  expect(() => exactOnceOption([...choices, { optionId: 'second', name: 'Second', kind: 'allow_once' }])).toThrow(
    'ONCE_AMBIGUOUS',
  )
  expect(() => exactOnceOption([...choices, { optionId: 'other', name: 'Allow', kind: 'allow_always' }])).toThrow(
    'ONCE_AMBIGUOUS',
  )
})

it('refuses truncated, redacted, missing and altered audit input instead of guessing from a title', () => {
  const input = { subject: 'Compute TEAM_test', description: '1+1' }
  const audit = summarizeRawInputForAudit(input)
  expect(intactPermissionInput(audit.summary, audit.hash)).toEqual(input)
  expect(() => intactPermissionInput(undefined, audit.hash)).toThrow('INPUT_MISSING')
  expect(() => intactPermissionInput('{...', audit.hash)).toThrow('INPUT_TRUNCATED')
  expect(() => intactPermissionInput('{}', audit.hash)).toThrow('INPUT_CHANGED')
  const secret = summarizeRawInputForAudit({ api_key: 'private' })
  expect(() => intactPermissionInput(secret.summary, secret.hash)).toThrow('INPUT_CHANGED')
})

it('accepts complete native details only when their raw input reproduces the original audit hash', () => {
  const input = {
    subject: 'Compute TEAM_4a44ed4c',
    description: 'Compute the value of 1+1 and record the result. Token: TEAM_4a44ed4c.',
  }
  const audit = summarizeRawInputForAudit(input)
  expect(audit.summary).toContain('<redacted>')
  expect(() => intactPermissionInput(audit.summary, audit.hash)).toThrow('INPUT_CHANGED')
  const detail = `\`\`\`\n${JSON.stringify({ rawInput: input }, null, 2)}\n\`\`\``
  expect(intactPermissionInput(audit.summary, audit.hash, detail)).toEqual(input)
  const childDetail = `Source child session: \` calculator (child) \`\n\n${detail}`
  expect(intactPermissionInput(audit.summary, audit.hash, childDetail)).toEqual(input)
  expect(() => intactPermissionInput(audit.summary, audit.hash, detail.replace('1+1', '2+2'))).toThrow('DETAIL_CHANGED')
  for (const invalid of [
    detail.slice(0, -1),
    'Input: ' + JSON.stringify(input),
    `\`\`\`\n${JSON.stringify(input)}\n\`\`\``,
    `\`\`\`\n${JSON.stringify({ rawInput: input, unexpected: true })}\n\`\`\``,
    `${detail}\n\n${detail}`,
    `${childDetail}\n\n${detail}`,
    `Unverified prose\n\n${detail}`,
  ])
    expect(() => intactPermissionInput(audit.summary, audit.hash, invalid)).toThrow('DETAIL_INVALID')
})

it('allows exactly the two new subjects and the declared dependency without write scopes', () => {
  expect(
    permitsDevinTeamTool('team_task_create', { subject: compute.subject, description: 'Calculate 1+1' }, base),
  ).toBe(true)
  const input = { subject: review.subject, description: 'Review the calculation', blocked_by: ['compute'] }
  expect(permitsDevinTeamTool('team_task_create', input, { ...base, tasks: [compute] })).toBe(true)
  for (const changed of [
    { subject: 'foreign' },
    { blocked_by: ['foreign'] },
    { write_scopes: ['.'] },
    { owner: 'lead' },
  ])
    expect(permitsDevinTeamTool('team_task_create', { ...input, ...changed }, { ...base, tasks: [compute] })).toBe(
      false,
    )
  expect(permitsDevinTeamTool('team_task_create', input, scope)).toBe(false)
  expect(permitsDevinTeamTool('team_task_create', input, { ...base, role: 'member', tasks: [compute] })).toBe(false)
})

it('restricts spawning to the one named child and explicitly authorized model', () => {
  const input = {
    name: 'calculator',
    description: 'calculate',
    prompt: 'Use task compute to calculate 1+1 and report TEAM_test',
  }
  expect(permitsDevinTeamTool('subagent', input, scope)).toBe(true)
  for (const changed of [
    { name: 'other' },
    { prompt: 'another task' },
    { model: 'paid-model' },
    { provider: 'native' },
    { context: {} },
  ])
    expect(permitsDevinTeamTool('subagent', { ...input, ...changed }, scope)).toBe(false)
  expect(permitsDevinTeamTool('subagent', input, { ...scope, childExists: true })).toBe(false)
  expect(permitsDevinTeamTool('subagent', input, { ...scope, role: 'member' })).toBe(false)
})

it('admits claim and completion only for the correct owner, tracked task, revision and readiness', () => {
  const claim = { task_id: 'compute', expected_revision: 1, action: 'claim' }
  expect(permitsDevinTeamTool('team_task_update', claim, { ...scope, role: 'member' })).toBe(true)
  expect(permitsDevinTeamTool('team_task_update', claim, scope)).toBe(false)
  expect(permitsDevinTeamTool('team_task_update', { ...claim, task_id: 'review' }, scope)).toBe(false)
  const owned = { ...compute, revision: 2, status: 'in_progress', ownerName: 'calculator' }
  const complete = { ...claim, expected_revision: 2, action: 'complete' }
  const member = { ...scope, role: 'member' as const, tasks: [owned, review] }
  expect(permitsDevinTeamTool('team_task_update', complete, member)).toBe(true)
  for (const changed of [
    { task_id: 'foreign' },
    { expected_revision: 1 },
    { action: 'delete' },
    { action: 'reassign', owner: 'lead' },
    { write_scopes: ['.'] },
  ])
    expect(permitsDevinTeamTool('team_task_update', { ...complete, ...changed }, member)).toBe(false)
  expect(permitsDevinTeamTool('team_task_get', { task_id: 'foreign' }, scope)).toBe(false)
})

it('admits one token-bearing result to lead only after the member completes its task', () => {
  const input = { agent: 'lead', message: 'TEAM_test result: 2' }
  const member = {
    ...scope,
    role: 'member' as const,
    tasks: [{ ...compute, status: 'completed', ownerName: 'calculator' }, review],
  }
  expect(permitsDevinTeamTool('send_message', input, member)).toBe(true)
  expect(permitsDevinTeamTool('send_message', input, { ...member, messageSent: true })).toBe(false)
  expect(permitsDevinTeamTool('send_message', { ...input, agent: 'foreign' }, member)).toBe(false)
  expect(permitsDevinTeamTool('send_message', { ...input, message: '2' }, member)).toBe(false)
  expect(permitsDevinTeamTool('send_message', input, { ...member, tasks: [compute] })).toBe(false)
})

it('never authorizes native/private tools, alternate servers, file/shell operations or arbitrary coordination', () => {
  for (const tool of [
    'bash',
    'read',
    'write',
    'execute',
    'native-subagent',
    'mcp__other__team_task_create',
    'interrupt_agent',
    'subagent_fork',
  ])
    expect(permitsDevinTeamTool(tool, {}, scope)).toBe(false)
  expect(permitsDevinTeamTool('list_agents', {}, scope)).toBe(true)
  expect(permitsDevinTeamTool('list_agents', { root: 'foreign' }, scope)).toBe(false)
  expect(permitsDevinTeamTool('team_task_list', { owner: 'foreign' }, scope)).toBe(false)
  expect(permitsDevinTeamTool('wait_agent', { timeout_ms: Infinity }, scope)).toBe(false)
})
