import { describe, expect, it } from 'vitest'
import type { AcpPendingElicitationView } from '../../../src/client/data/acp-remote.ts'
import { pendingElicitationsForSession } from '../../../src/client/ui/AcpElicitationInputDock.ts'

const pending: readonly AcpPendingElicitationView[] = [{
  requestId: 'el-1',
  sessionId: 'session-a',
  mode: 'form',
  message: 'Choose',
  fields: [],
  createdAt: 1,
}]

describe('ACP elicitation input.dock surface', () => {
  it('never renders the previous session pending list during a session switch', () => {
    expect(pendingElicitationsForSession({ sessionId: 'session-a', pending }, 'session-b')).toEqual([])
    expect(pendingElicitationsForSession({ sessionId: 'session-a', pending }, 'session-a')).toEqual(pending)
  })
})
