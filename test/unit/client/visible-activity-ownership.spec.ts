import { describe, expect, it } from 'vitest'
import { visibleActivityRows } from '../../../src/client/ui/AcpActivityNode.ts'

const base = {
  dshSessionId: 'parent',
  ownerDshSessionId: 'parent',
  promptAnchorMessageId: 'user-1',
  revisionSeq: 1,
  time: 1,
  status: 'completed' as const,
}

const tool = (call: string, seq: number) => ({
  ...base,
  activityId: `user-1:tool:${call}`,
  activitySeq: seq,
  kind: 'tool' as const,
  presentation: call === 'parent-read' ? 'Read parent file' : 'Research',
  rawDetail: JSON.stringify({ toolKind: 'read', rawInput: { file_path: `/work/${call}.ts` } }),
})

const projection = (call: string, seq: number) => ({
  ...base,
  activityId: `user-1:delegated-record:${call}`,
  activitySeq: seq,
  kind: 'delegated' as const,
  presentation: 'Research',
  rawDetail: JSON.stringify({ projectedChildSessionId: `child-${call}`, sourceToolCallId: call }),
})

const content = (call: string, seq: number, namespace: 'tool' | 'part' = 'part') => ({
  ...base,
  activityId: `user-1:${namespace}:${call}:0:content`,
  activitySeq: seq,
  kind: 'other' as const,
  presentation: 'Tool output',
  rawDetail: JSON.stringify({ type: 'content', content: { type: 'text', text: 'fixture output' } }),
})

describe('delegated activity ownership', () => {
  it('preserves an independent parent read made after a delegation tool', () => {
    const rows = visibleActivityRows([tool('delegate-a', 1), tool('parent-read', 2), projection('delegate-a', 3)])
    expect(rows.map((row) => row.activityId)).toEqual(['user-1:tool:delegate-a', 'user-1:tool:parent-read'])
  })

  it('preserves both independent delegation tools and each projected child link', () => {
    const rows = visibleActivityRows([
      tool('delegate-a', 1),
      tool('delegate-b', 2),
      projection('delegate-a', 3),
      projection('delegate-b', 4),
    ])
    expect(rows.map((row) => row.activityId)).toEqual(['user-1:tool:delegate-a', 'user-1:tool:delegate-b'])
    expect(rows.map((row) => row.projectedChild?.childSessionId)).toEqual(['child-delegate-a', 'child-delegate-b'])
  })

  it('preserves opaque sibling IDs while folding exact new and legacy content rows', () => {
    const rows = visibleActivityRows([
      tool('a', 1),
      tool('a:b', 2),
      content('a', 3),
      content('a', 4, 'tool'),
      {
        ...base,
        activityId: 'user-1:tool:a:not-content',
        activitySeq: 5,
        kind: 'other' as const,
        presentation: 'Other',
      },
      projection('a', 6),
    ])
    expect(rows.map((row) => row.activityId)).toEqual(['user-1:tool:a', 'user-1:tool:a:b', 'user-1:tool:a:not-content'])
  })

  it.each([
    ['empty', ''],
    ['newline', 'a\nb'],
  ])('folds part content for the valid %s opaque ID and keeps its tool sibling', (_label, call) => {
    const siblingId = `${call}:0:content`
    const rows = visibleActivityRows([tool(call, 1), content(call, 2), tool(siblingId, 3)])
    expect(rows.map((row) => [row.activityId, row.kind])).toEqual([
      [`user-1:tool:${call}`, 'tool'],
      [`user-1:tool:${siblingId}`, 'tool'],
    ])
  })

  it('matches a projected source by its full opaque ID instead of a delimiter suffix', () => {
    const rows = visibleActivityRows([tool('b:tool:a', 1), tool('a', 2), projection('a', 3)])
    expect(rows.map((row) => [row.activityId, row.projectedChild?.childSessionId])).toEqual([
      ['user-1:tool:b:tool:a', undefined],
      ['user-1:tool:a', 'child-a'],
    ])
  })

  it('keeps exact legacy tool roots and folds their legacy content rows', () => {
    const legacyRoot = { ...tool('a', 1), activityId: 'tool:a' }
    const legacyContent = { ...content('a', 2, 'tool'), activityId: 'tool:a:0:content' }
    const rows = visibleActivityRows([legacyRoot, legacyContent, projection('a', 3)])
    expect(rows.map((row) => row.activityId)).toEqual(['tool:a'])
    expect(rows[0]?.projectedChild?.childSessionId).toBe('child-a')
  })

  it.each([
    ['dshSessionId', { dshSessionId: 'other-session' }],
    ['ownerDshSessionId', { ownerDshSessionId: 'other-owner' }],
    ['promptAnchorMessageId', { promptAnchorMessageId: 'another-anchor' }],
  ] as const)('does not attach a projection from a different %s', (_field, mismatch) => {
    const rows = visibleActivityRows([tool('a', 1), { ...projection('a', 2), ...mismatch }])
    expect(rows.find((row) => row.activityId === 'user-1:tool:a')?.projectedChild).toBeUndefined()
  })
})
