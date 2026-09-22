import { expect, it } from 'vitest'
import { ManagedAcpRouteCatalog } from '../../../src/client/data/managed-routes.ts'
import type { AcpScopeSnapshot } from '../../../src/client/data/logic.ts'

it('retains host-confirmed ownership while the native form is loading or unavailable', () => {
  let snapshot: AcpScopeSnapshot = { status: 'loading', value: undefined, revision: undefined, writable: false }
  let publish!: () => void
  const catalog = new ManagedAcpRouteCatalog({ getSnapshot: () => snapshot, subscribe: fn => { publish = fn; return () => {} } }, ['acp-saved'])
  expect(catalog.owns('acp-saved')).toBe(true)
  expect(catalog.owns('acp-unowned')).toBe(false)
  snapshot = { ...snapshot, value: { agents: { custom: { name: 'Custom', command: 'custom', args: [], env: {} } } } }
  publish()
  expect([...catalog.snapshot()]).toEqual(['acp-saved', 'acp-custom'])
  snapshot = { ...snapshot, value: { agents: {} } }
  publish()
  expect([...catalog.snapshot()]).toEqual(['acp-saved'])
  catalog.dispose()
})
