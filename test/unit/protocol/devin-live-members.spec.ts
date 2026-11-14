import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { requireDevinLiveMember } from '../../../scripts/devin-live-members.ts'

const member = {
  kind: 'child',
  id: SessionId('child-a'),
  parentId: SessionId('lead-a'),
  depth: 1,
  mode: 'continuable',
  name: 'checker',
  path: 'checker',
  label: 'Check marker',
  activity: 'inactive',
  hasChildren: false,
} satisfies SubagentDescendantListEntry

it('identifies exactly one named direct continuable child in its own Lead catalog', () => {
  expect(requireDevinLiveMember([member], 'lead-a')).toBe(member)
})

it.each(
  [
    [],
    [member, { ...member, id: SessionId('extra-child') }],
    [{ ...member, kind: 'diagnostic' as const, reason: 'unavailable' as const }],
    [{ ...member, parentId: SessionId('another-lead') }],
    [{ ...member, depth: 2, path: 'checker/checker' }],
    [{ ...member, name: 'other' }],
    [{ ...member, mode: 'external' as const }],
  ].map((rows) => ({ rows })),
)('rejects missing, unreadable, duplicated or misowned child evidence', ({ rows }) => {
  expect(() => requireDevinLiveMember(rows, 'lead-a')).toThrow('LIVE_EXPECTED_ONE_NAMED_CHILD')
})
