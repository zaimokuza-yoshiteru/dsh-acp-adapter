import { describe, expect, it } from 'vitest'
import { answerTeamRequests, teamApproval, type TeamApproval } from '../../../src/client/ui/team-approval-actions.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (id: string) => id as SessionId
function approval(id: string, answer: TeamApproval['answer'] = async () => {}): TeamApproval {
  return { key: id, sessionId: sid(id), kind: 'approval', toolName: 'bash', answer }
}
describe('Team approval settlement', () => {
  it('captures only current members; replacements, cancelled requests and later arrivals are untouched', async () => {
    const calls: string[] = []
    const first = approval('one'), replaced = approval('two'), cancelled = approval('three'), otherTeam = approval('other')
    const current = new Map([first, approval('two'), approval('late'), otherTeam].map(p => [p.sessionId, { running: false, pendingInteraction: p, completionUnread: false }]))
    const requests = [first, replaced, cancelled, otherTeam].map(pending => ({ pending, answer: async () => { calls.push(pending.key) } }))
    expect(await answerTeamRequests(requests, () => current, new Set(['one', 'two', 'three', 'late'].map(sid)), () => true, new Set())).toBe(0)
    expect(calls).toEqual(['one'])
    await answerTeamRequests(requests, () => current, new Set([sid('one')]), () => false, new Set())
    expect(calls).toEqual(['one'])
  })
  it('deduplicates concurrent clicks and isolates partial failures', async () => {
    let release!: () => void
    let calls = 0
    const one = approval('one'), two = approval('two')
    const current = new Map([one, two].map(p => [p.sessionId, { running: false, pendingInteraction: p, completionUnread: false }]))
    const inFlight = new Set<TeamApproval>()
    const requests = [
      { pending: one, answer: async () => { calls++; await new Promise<void>(resolve => { release = resolve }) } },
      { pending: two, answer: async () => { throw new Error('expired') } },
    ]
    const first = answerTeamRequests(requests, () => current, new Set(current.keys()), () => true, inFlight)
    const second = answerTeamRequests(requests, () => current, new Set(current.keys()), () => true, inFlight)
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(0)
    expect(calls).toBe(1)
    expect(inFlight.size).toBe(0)
  })
  it('does not mistake questions or unknown interactions for allow-once approvals', () => {
    const question = { key: 'q', sessionId: sid('q'), kind: 'question', questions: [], answer: async () => {}, cancel: async () => {} }
    expect(teamApproval(question)).toBeUndefined()
    expect(teamApproval({ key: 'x', sessionId: sid('x'), kind: 'approval' })).toBeUndefined()
  })

  it('compares the pending request, allowing status-only changes and skipping a settled carrier', async () => {
    let calls = 0
    const pending = approval('one')
    const status = new Map([[pending.sessionId, { running: true, pendingInteraction: pending as TeamApproval | undefined, completionUnread: false }]])
    const requests = [{ pending, answer: async () => { calls++ } }]
    status.set(pending.sessionId, { running: false, pendingInteraction: pending, completionUnread: true })
    await answerTeamRequests(requests, () => status, new Set(status.keys()), () => true, new Set())
    expect(calls).toBe(1)
    status.set(pending.sessionId, { running: false, pendingInteraction: undefined, completionUnread: true })
    await answerTeamRequests(requests, () => status, new Set(status.keys()), () => true, new Set())
    expect(calls).toBe(1)
  })
})
