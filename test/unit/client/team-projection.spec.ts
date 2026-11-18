import { expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectionRevision } from '../../../src/client/ui/team-projection.ts'

const sid = (value: string) => value as SessionId
const snapshots = (patch = {}) =>
  ({
    lead: { state: 'ready', values: { subagentCatalog: [{ id: 'member', mode: 'continuable', name: 'worker' }] } },
    member: { state: 'ready', values: { subagentCatalog: [{ id: 'nested', mode: 'continuable', name: 'reviewer' }] } },
    nested: { state: 'ready', values: { modelSelection: { next: { provider: 'acp-codex', model: 'small' } } } },
    ...patch,
  }) as unknown as SessionListState['projectionsBySession']

it('refreshes descendant settings on native catalog, availability and model changes', () => {
  const before = projectionRevision(sid('lead'), snapshots())
  expect(projectionRevision(sid('lead'), snapshots({ nested: { state: 'error', values: {} } }))).not.toBe(before)
  expect(
    projectionRevision(sid('lead'), snapshots({ member: { state: 'ready', values: { subagentCatalog: [] } } })),
  ).not.toBe(before)
  expect(
    projectionRevision(
      sid('lead'),
      snapshots({
        nested: { state: 'ready', values: { modelSelection: { next: { provider: 'acp-codex', model: 'large' } } } },
      }),
    ),
  ).not.toBe(before)
})

it('ignores unrelated catalogs and Team task selection, and terminates malformed cycles', () => {
  const before = projectionRevision(sid('lead'), snapshots())
  expect(projectionRevision(sid('lead'), snapshots({ unrelated: { state: 'error', values: {} } }))).toBe(before)
  const tree = snapshots()
  const lead = tree[sid('lead')]!
  expect(
    projectionRevision(
      sid('lead'),
      snapshots({ lead: { ...lead, values: { ...lead.values, agentTeam: { enabled: false, tasks: [] } } } }),
    ),
  ).toBe(before)
  expect(() =>
    projectionRevision(
      sid('lead'),
      snapshots({ nested: { state: 'ready', values: { subagentCatalog: [{ id: 'lead', mode: 'continuable' }] } } }),
    ),
  ).not.toThrow()
  expect(projectionRevision(sid('missing'), {})).toBe('[["missing",null,null,null,null]]')
})
