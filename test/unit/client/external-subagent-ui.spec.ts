import { describe, expect, it, vi } from 'vitest'
import { ProjectedSubagentCatalog } from '../../../src/client/data/projected-subagents.ts'
import { nativeActivityToolBlock } from '../../../src/client/ui/AcpActivityNode.ts'

describe('external subagent client ownership', () => {
  it('hydrates exact ownership from the host sidecar', async () => {
    const remote = {
      projectedSubagentIds: vi.fn(async () => ({ ok: true as const, value: { sessionIds: ['cold-child'] } })),
    }
    const catalog = new ProjectedSubagentCatalog(remote as never)
    await catalog.refresh()
    expect(catalog.owns('cold-child')).toBe(true)
    expect(catalog.owns('prefix-collision')).toBe(false)
  })

  it('shows a localized external-agent prefix while keeping the source tool identity', () => {
    const block = nativeActivityToolBlock(
      {
        dshSessionId: 'dsh-1',
        ownerDshSessionId: 'dsh-1',
        promptAnchorMessageId: 'message-1',
        activityId: 'turn-1:tool:source-call',
        activitySeq: 1,
        revisionSeq: 1,
        time: 10,
        kind: 'tool',
        status: 'running',
        presentation: 'Inspect files',
        rawDetail: JSON.stringify({
          toolName: 'inspect_files',
          rawInput: { path: '/workspace' },
          externalDelegations: [
            {
              profileKind: 'devin',
              vendorDelegationKey: 'child-1',
              vendorChildId: 'child-1',
              sourceToolCallId: 'source-call',
              label: 'Research files',
              status: 'running',
              observedStartedAt: 1,
              observedAt: 2,
            },
          ],
        }),
      },
      '外部 Agent',
      (status) =>
        ({ running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] ?? '状态未确认',
    )
    expect(block).toMatchObject({
      name: '外部 Agent · Research files · 运行中 · inspect_files',
      phase: 'start',
      subCalls: [],
    })
  })
})
