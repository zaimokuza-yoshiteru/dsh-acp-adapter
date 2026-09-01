import { describe, expect, it, vi } from 'vitest'
import { ProjectedSubagentCatalog } from '../../../src/client/data/projected-subagents.ts'

describe('external subagent client ownership', () => {
  it('hydrates exact ownership from the host sidecar', async () => {
    const remote = { projectedSubagentIds: vi.fn(async () => ({ ok: true as const, value: { sessionIds: ['cold-child'] } })) }
    const catalog = new ProjectedSubagentCatalog(remote as never)
    await catalog.refresh()
    expect(catalog.owns('cold-child')).toBe(true)
    expect(catalog.owns('prefix-collision')).toBe(false)
  })
})
