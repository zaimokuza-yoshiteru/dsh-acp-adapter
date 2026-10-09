import { describe, expect, it } from 'vitest'
import { devinPeerMessageOf } from '../../../scripts/devin-live-messages.ts'

describe('Devin native peer-message evidence', () => {
  it('reads target-side Agent relay identity and authored content without a send result or mailbox record', () => {
    const evidence = devinPeerMessageOf({
      id: 'native-message-1',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'member-1' },
      content: [
        { type: 'text', text: 'Team message from checker:' },
        { type: 'text', text: 'EXACT_REPLY_MARKER' },
      ],
    })
    expect(evidence).toEqual({
      kind: 'agent-message',
      id: 'native-message-1',
      senderId: 'member-1',
      text: 'EXACT_REPLY_MARKER',
    })
    expect(evidence).not.toHaveProperty('processed')
    expect(evidence).not.toHaveProperty('status')
  })

  it('retains the historical mailbox identity independently of the enclosing user-message id', () => {
    expect(
      devinPeerMessageOf({
        id: 'enclosing-user-message',
        source: { kind: 'team-message', messageId: 'historical-message', senderId: 'member-old' },
        content: [{ type: 'text', text: 'Historical message body' }],
      }),
    ).toEqual({
      kind: 'team-message',
      id: 'historical-message',
      senderId: 'member-old',
      text: 'Historical message body',
    })
  })

  it('strips only the exact native framing and keeps sender-authored framing-like text', () => {
    const message = {
      id: 'native-adjacent-message',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child' },
      content: [
        { type: 'text', text: 'Agent child sent a message: ' },
        { type: 'text', text: 'Team message from arbitrary prose: keep this body' },
      ],
    }
    expect(devinPeerMessageOf(message)?.text).toBe('Team message from arbitrary prose: keep this body')
    expect(
      devinPeerMessageOf({ ...message, content: [{ type: 'text', text: 'Agent another sent a message: ' }] })?.text,
    ).toBe('Agent another sent a message: ')
  })

  it.each([
    { id: 'message', source: { kind: 'agent-message', form: 'notice', senderSessionId: 'child' } },
    { id: 'message', source: { kind: 'agent-message', form: 'relay' } },
    { id: '', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child' } },
    { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child' } },
    { id: 'message', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' } },
    { id: 'message', source: { kind: 'team-message', senderId: 'child' } },
    { id: 'message', source: { kind: 'user' } },
  ])('rejects unrelated or incomplete attribution (%j)', (message) => {
    expect(
      devinPeerMessageOf({ ...message, content: [{ type: 'text', text: 'not peer acceptance proof' }] }),
    ).toBeUndefined()
  })

  it('does not turn a successful send tool result into native receipt evidence', () => {
    expect(devinPeerMessageOf({ sent: true })).toBeUndefined()
    expect(devinPeerMessageOf({ messageId: 'old-tool-result', status: 'accepted' })).toBeUndefined()
  })
})
