import { expect, it, vi } from 'vitest'
import { applyTeamMode, teamModeChoices, teamSessionMenuGroups } from '../../../src/client/ui/team-mode-controls.ts'
import { teamActionSummary } from '../../../src/client/ui/team-action-summary.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'
import { teamModeLabel } from '../../../src/contract/session-modes.ts'
import type { AcpAgentSessionSnapshotView, AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'
const snapshot = (patch: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: 'a',
  profileId: 'devin',
  freshness: 'live',
  editable: true,
  configOptions: null,
  modes: [
    { id: 'code', name: 'Code' },
    { id: 'plan', name: 'Plan' },
  ],
  currentModeId: 'code',
  contextUsage: null,
  note: null,
  ...patch,
})
const member = (sessionId: string, patch: Partial<AcpTeamMemberView> = {}): AcpTeamMemberView => ({
  sessionId,
  profileId: 'devin',
  name: sessionId,
  status: 'inactive',
  model: null,
  description: null,
  ...patch,
})
it('limits the menu to canonical modes, without model, reasoning or unrelated settings', () => {
  const choices = teamModeChoices(
    snapshot({
      configOptions: [
        { id: 'model', type: 'select', name: 'Model', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] },
        {
          id: 'custom-mode',
          category: 'mode',
          type: 'select',
          name: 'Session Mode',
          currentValue: 'code',
          options: [{ value: 'plan', name: 'Plan' }],
        },
      ],
    }),
  )
  expect(choices).toEqual([
    {
      id: 'plan',
      name: 'Plan',
      label: 'Session Mode: Plan',
      current: false,
      write: { kind: 'config', id: 'custom-mode', value: 'plan' },
    },
  ])
})
it('labels pending modes first while preserving confirmed values outside the advertised roster', () => {
  expect(teamModeLabel(snapshot({ pendingModeId: 'plan' }), 'Unknown')).toBe('Plan')
  expect(teamModeLabel(snapshot({ pendingModeId: 'removed' }), 'Unknown')).toBe('Code')
  expect(teamModeLabel(snapshot({ currentModeId: 'confirmed', modes: [] }), 'Unknown')).toBe('confirmed')
  expect(
    teamModeLabel(
      snapshot({
        configOptions: [{ id: 'mode', type: 'select', name: 'Mode', currentValue: 'confirmed', options: [] }],
        modes: null,
        currentModeId: null,
      }),
      'Unknown',
    ),
  ).toBe('confirmed')
})
it('changes captured compatible members once and never includes other profiles or late arrivals', async () => {
  const write = vi.fn(async () => {})
  const result = await applyTeamMode({
    targets: ['a', 'a', 'other', 'running', 'gone'],
    profileId: 'devin',
    mode: 'plan',
    isCurrent: () => true,
    members: async () => [
      member('a'),
      member('other', { profileId: 'generic' }),
      member('running', { status: 'running' }),
      member('late'),
    ],
    snapshot: async () => snapshot(),
    write,
  })
  expect(result).toMatchObject({ applied: 1, skipped: 3, failed: 0 })
  expect(write).toHaveBeenCalledExactlyOnceWith('a', { kind: 'mode', id: 'plan' })
})
it('skips stale, busy, unsupported and already selected modes; isolates individual failures', async () => {
  const ids = ['stale', 'busy', 'unsupported', 'same', 'failed', 'ok']
  const write = vi.fn(async (id: string) => {
    if (id === 'failed') throw new Error('protocol disconnected')
  })
  const result = await applyTeamMode({
    targets: ids,
    profileId: 'devin',
    mode: 'plan',
    isCurrent: () => true,
    members: async () => ids.map((id) => member(id)),
    snapshot: async (id) =>
      snapshot(
        id === 'stale'
          ? { freshness: 'stale' }
          : id === 'busy'
            ? { editable: false }
            : id === 'unsupported'
              ? { modes: [] }
              : id === 'same'
                ? { currentModeId: 'plan' }
                : {},
      ),
    write,
  })
  expect(result).toMatchObject({ applied: 1, skipped: 4, failed: 1 })
  expect(result.members.map((item) => [item.sessionId, item.reason])).toEqual([
    ['stale', 'Stale'],
    ['busy', 'Stale'],
    ['unsupported', 'Unsupported'],
    ['same', 'Selected'],
    ['failed', 'Failed'],
    ['ok', 'Applied'],
  ])
  expect(write).toHaveBeenLastCalledWith('ok', { kind: 'mode', id: 'plan' })
})
it('revalidates before every write and stops when the active conversation changes', async () => {
  let active = true
  const write = vi.fn(async () => {
    active = false
  })
  expect(
    await applyTeamMode({
      targets: ['a', 'b'],
      profileId: 'devin',
      mode: 'plan',
      isCurrent: () => active,
      members: async () => [member('a'), member('b')],
      snapshot: async () => snapshot(),
      write,
    }),
  ).toMatchObject({ applied: 1, skipped: 1, failed: 0 })
  expect(write).toHaveBeenCalledTimes(1)
})
it('rejects a profile change while a snapshot request is in flight', async () => {
  const write = vi.fn()
  expect(
    await applyTeamMode({
      targets: ['a'],
      profileId: 'devin',
      mode: 'plan',
      isCurrent: () => true,
      members: async () => [member('a')],
      snapshot: async () => snapshot({ profileId: 'generic' }),
      write,
    }),
  ).toMatchObject({ applied: 0, skipped: 1, failed: 0 })
  expect(write).not.toHaveBeenCalled()
})

it('saves dormant member modes and allows replacing a pending mode with the last reported mode', async () => {
  const write = vi.fn(async () => {})
  const result = await applyTeamMode({
    targets: ['sleeping'],
    profileId: 'devin',
    mode: 'code',
    isCurrent: () => true,
    members: async () => [member('sleeping', { status: 'inactive' })],
    snapshot: async () => snapshot({ freshness: 'stale', editable: false, modeWritable: true, pendingModeId: 'plan' }),
    write,
  })
  expect(result).toMatchObject({ applied: 1, skipped: 0, failed: 0 })
  expect(write).toHaveBeenCalledWith('sleeping', { kind: 'mode', id: 'code' })
})

it('shares mode presentation with main sessions, excluding other controls and preserving pending selections', () => {
  const value = snapshot({
    editable: false,
    freshness: 'stale',
    pendingModeId: 'plan',
    configOptions: [
      {
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        currentValue: 'code',
        options: [
          { value: 'code', name: 'Code' },
          { value: 'plan', name: 'Plan', description: 'Plan before acting' },
        ],
      },
      { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: true },
      { id: 'model', name: 'Model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] },
    ],
  })
  const readOnly = teamSessionMenuGroups(value, (key) => key, false)
  expect(readOnly).toHaveLength(1)
  expect(readOnly[0]).toMatchObject({ name: 'Session Mode', current: 'Plan' })
  expect(readOnly[0]?.choices).toMatchObject([
    { label: 'Code', current: false, disabled: true },
    { label: 'Plan', description: 'Plan before acting', current: true, disabled: true },
  ])
  const writable = teamSessionMenuGroups(value, (key) => key, true)
  expect(writable[0]?.choices.map((choice) => ({ ...choice, disabled: true }))).toEqual(readOnly[0]?.choices)
  expect(writable[0]?.choices.every((choice) => !choice.disabled)).toBe(true)
})

it.each([
  [{ applied: 2, skipped: 0, failed: 0 }, 'Mode saved for 2 members.', '已保存 2 位成员的模式。'],
  [{ accepted: 1, skipped: 0, failed: 0 }, 'Interrupt requested for 1 member.', '已向 1 位成员发送中断请求。'],
  [
    { applied: 1, skipped: 2, failed: 1 },
    'Mode saved for 1 member. 2 skipped. 1 failed.',
    '已保存 1 位成员的模式。 已跳过 2 位。 1 位操作失败。',
  ],
  [{ accepted: 0, skipped: 1, failed: 0 }, '1 skipped.', '已跳过 1 位。'],
  [{ accepted: 0, skipped: 0, failed: 0 }, 'No members needed changes.', '没有需要处理的成员。'],
] as const)('reports affected members without zero counts for %j', (result, english, chinese) => {
  for (const [dictionary, expected] of [
    [en, english],
    [zh, chinese],
  ] as const)
    expect(teamActionSummary((key, args) => dictionary[key].replace('{count}', String(args?.count)), result)).toBe(
      expected,
    )
})
