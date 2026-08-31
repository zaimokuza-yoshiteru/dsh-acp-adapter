import { describe, expect, it } from 'vitest'
import { AcpToolCallReducer, acpToolProvenanceId } from '../../../src/host/composition/tool-call-reducer.ts'

describe('ACP tool-call reducer', () => {
  it('merges sparse updates into one current snapshot', () => {
    const reducer = new AcpToolCallReducer('turn-1')
    expect(reducer.apply({ callId: '7', title: 'Read', name: 'read_file', kind: 'read', rawInput: { path: '/tmp/a' }, locations: [{ path: '/tmp/a' }], content: [{ type: 'terminal' }], status: 'in_progress' }).status).toBe('running')
    reducer.apply({ callId: '7', name: null, rawOutput: { bytes: 4 }, status: 'completed' })
    const settled = reducer.apply({ callId: '7', status: 'completed' })
    expect(settled).toMatchObject({
      callId: '7', provenanceId: acpToolProvenanceId('turn-1', '7'), title: 'Read', name: 'read_file', kind: 'read',
      rawInput: { path: '/tmp/a' }, rawOutput: { bytes: 4 }, locations: [{ path: '/tmp/a' }], content: [{ type: 'terminal' }], status: 'completed',
    })
  })

  it('does not regress a terminal call when a late progress patch arrives', () => {
    const reducer = new AcpToolCallReducer('turn-late')
    reducer.apply({ callId: 'x', title: 'Run', status: 'completed' })
    expect(reducer.apply({ callId: 'x', status: 'in_progress' }).status).toBe('completed')
  })

  it.each(['failed', 'cancelled'] as const)('keeps prior fields when settling as %s', (status) => {
    const reducer = new AcpToolCallReducer('turn-crash')
    reducer.apply({ callId: 'x', name: 'Terminal', content: [{ type: 'terminal' }], status: 'running' })
    reducer.apply({ callId: 'x', status })
    expect(reducer.apply({ callId: 'x', status })).toMatchObject({ name: 'Terminal', content: [{ type: 'terminal' }], status })
  })

  it('keeps provenance stable and isolates equal call ids across turns', () => {
    const first = new AcpToolCallReducer('a')
    const second = new AcpToolCallReducer('b')
    expect(first.apply({ callId: 'same', status: 'running' }).provenanceId).toBe('acp:a:same')
    expect(second.apply({ callId: 'same', status: 'running' }).provenanceId).toBe('acp:b:same')
  })
})
