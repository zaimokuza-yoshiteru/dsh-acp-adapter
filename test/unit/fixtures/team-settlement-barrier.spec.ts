import { describe, expect, it } from 'vitest'
import { observedTeamSettlement } from '../../e2e/team-settlement.ts'
import type { ObservedEvent } from '../../e2e/types.ts'

const event = (sessionId: string, type: string, data: unknown) => ({ sessionId, type, data }) as ObservedEvent
const phase = { parentId: 'parent', childId: 'child', after: 1 }
const notice = () =>
  event('parent', 'user/message', {
    id: 'native-settlement',
    role: 'user',
    content: [{ type: 'text', text: 'E2E_TEAM_MEMBER_DONE' }],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child', summary: 'finished' },
  })
const completed = () => [
  event('child', 'turn/start', { turn: 1 }),
  event('child', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  event('parent', 'turn/start', { turn: 4 }),
  event('parent', 'step/start', { turn: 4, step: 1 }),
  notice(),
  event('parent', 'step/end', { turn: 4, step: 1 }),
  event('parent', 'turn/end', { turn: 4, reason: { kind: 'completed' } }),
]

describe('native Teams fixture settlement phase barrier', () => {
  it('allows the child to start before approval, but requires its new native notice and parent completion', () => {
    expect(observedTeamSettlement(completed(), phase)).toEqual({
      childTurn: 1,
      noticeId: 'native-settlement',
      parentTurn: 4,
      parentStep: 1,
    })
  })

  it('does not release the finite approval plan during the idle gap before delayed native cleanup', () => {
    const events = completed().slice(0, 2)
    events.push(event('parent', 'turn/end', { turn: 3, reason: { kind: 'completed' } }))
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
    events.push(...completed().slice(2, 5))
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
    events.push(completed()[5]!)
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
    events.push(completed()[6]!)
    expect(observedTeamSettlement(events, phase)?.noticeId).toBe('native-settlement')
  })

  it('does not use an earlier completed activation for a new phase', () => {
    const events = completed()
    expect(observedTeamSettlement(events, { ...phase, after: events.length })).toBeUndefined()
  })

  it.each(['other-parent', 'other-child', 'relay', 'inbox'])(
    'rejects a %s notification as settlement evidence',
    (kind) => {
      const events = completed()
      const message = notice()
      if (message.type !== 'user/message') throw new Error('fixture message')
      if (kind === 'other-parent') events[4] = event('other', 'user/message', message.data)
      if (kind === 'other-child')
        events[4] = event('parent', 'user/message', {
          ...message.data,
          source: { ...message.data.source, senderSessionId: 'sibling' },
        })
      if (kind === 'relay')
        events[4] = event('parent', 'user/message', {
          ...message.data,
          source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child' },
        })
      if (kind === 'inbox')
        events[4] = event('parent', 'agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [message.data],
        })
      expect(observedTeamSettlement(events, phase)).toBeUndefined()
    },
  )

  it.each(['step', 'turn'])('requires the matching parent %s completion', (kind) => {
    const events = completed()
    if (kind === 'step') events[5] = event('parent', 'step/end', { turn: 4, step: 2 })
    else events[6] = event('parent', 'turn/end', { turn: 5, reason: { kind: 'completed' } })
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
  })

  it.each(['child', 'parent'])('does not claim a failed %s turn completed the phase', (owner) => {
    const events = completed()
    events[owner === 'child' ? 1 : 6] = event(owner, 'turn/end', {
      turn: owner === 'child' ? 1 : 4,
      reason: { kind: 'error', error: { message: 'fixture failure' } },
    })
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
  })

  it('waits for the whole parent turn when native feedback adds another step', () => {
    const events = completed().slice(0, 6)
    events.push(event('parent', 'step/start', { turn: 4, step: 2 }))
    expect(observedTeamSettlement(events, phase)).toBeUndefined()
    events.push(event('parent', 'step/end', { turn: 4, step: 2 }), completed()[6]!)
    expect(observedTeamSettlement(events, phase)?.parentTurn).toBe(4)
  })
})
