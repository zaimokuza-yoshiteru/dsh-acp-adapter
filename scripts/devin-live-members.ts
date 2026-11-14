import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'

/** Require one fresh named child, without treating a failed catalog branch as an empty tree. */
export function requireDevinLiveMember(
  rows: readonly SubagentDescendantListEntry[],
  leadId: string,
): Extract<SubagentDescendantListEntry, { kind: 'child'; mode: 'continuable' }> {
  const member = rows[0]
  if (
    rows.length !== 1 ||
    member?.kind !== 'child' ||
    member.parentId !== leadId ||
    member.depth !== 1 ||
    member.mode !== 'continuable' ||
    member.name !== 'checker' ||
    member.path !== 'checker' ||
    member.id === leadId
  )
    throw new Error('LIVE_EXPECTED_ONE_NAMED_CHILD')
  return member
}
