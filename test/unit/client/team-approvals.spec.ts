import { describe, expect, it, vi } from 'vitest'
import {
  answerTeamRequests,
  isStableTeamMemberReadError,
  readTeamMembersUntilAvailable,
  teamApproval,
  type TeamApproval,
} from '../../../src/client/ui/team-approval-actions.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'

const sid = (id: string) => id as SessionId
function approval(id: string, answer: TeamApproval['answer'] = async () => {}): TeamApproval {
  return { key: id, sessionId: sid(id), kind: 'approval', toolName: 'bash', answer }
}
describe('Team approval settlement', () => {
  it('automatically retries only the roster read for the same live session', async () => {
    vi.useFakeTimers()
    try {
      const sessionId = sid('lead')
      const members = [
        {
          profileId: null,
          sessionId: 'worker',
          name: 'Worker',
          status: 'running',
          model: null,
          description: null,
        },
      ] satisfies readonly AcpTeamMemberView[]
      const calls: SessionId[] = []
      const failures: number[] = []
      const loadingAttempts: number[] = []
      const loaded = readTeamMembersUntilAvailable(
        sessionId,
        async (id) => {
          calls.push(id)
          if (calls.length === 1) throw new Error('temporary read failure')
          return members
        },
        () => true,
        { onAttempt: () => loadingAttempts.push(calls.length + 1), onFailure: () => failures.push(calls.length) },
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([sessionId])
      expect(failures).toEqual([1])
      await vi.advanceTimersByTimeAsync(500)
      expect(await loaded).toEqual(members)
      expect(calls).toEqual([sessionId, sessionId])
      expect(loadingAttempts).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a scheduled roster retry when its captured request is no longer live', async () => {
    vi.useFakeTimers()
    try {
      let active = true
      let calls = 0
      const loaded = readTeamMembersUntilAvailable(
        sid('lead'),
        async () => {
          calls++
          throw new Error('temporary read failure')
        },
        () => active,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      active = false
      await vi.advanceTimersByTimeAsync(500)
      expect(await loaded).toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry stable authorization or configuration failures', async () => {
    let reads = 0
    const loaded = readTeamMembersUntilAvailable(
      sid('lead'),
      async () => {
        reads++
        throw Object.assign(new Error('not authorized'), { code: 'dsh-acp/user-rejected' })
      },
      () => true,
    )
    await expect(loaded).rejects.toMatchObject({ code: 'dsh-acp/user-rejected' })
    expect(isStableTeamMemberReadError(new Error('gateway/internal'))).toBe(false)
    expect(reads).toBe(1)
  })

  it('revalidates a captured click after roster retry and answers it only once', async () => {
    vi.useFakeTimers()
    try {
      const pending = approval('worker')
      const current = new Map([
        [pending.sessionId, { running: false, pendingInteraction: pending, completionUnread: false }],
      ])
      let reads = 0
      let answers = 0
      const loaded = readTeamMembersUntilAvailable(
        sid('lead'),
        async () => {
          reads++
          if (reads === 1) throw new Error('temporary read failure')
          return [
            {
              profileId: null,
              sessionId: pending.sessionId,
              name: 'Worker',
              status: 'running',
              model: null,
              description: null,
            },
          ]
        },
        () => true,
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(await loaded).toHaveLength(1)
      const failures = await answerTeamRequests(
        [
          {
            pending,
            answer: async () => {
              answers++
            },
          },
        ],
        () => current,
        new Set([pending.sessionId]),
        () => true,
        new Set(),
      )
      expect(failures).toBe(0)
      expect(reads).toBe(2)
      expect(answers).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures only current members; replacements, cancelled requests and later arrivals are untouched', async () => {
    const calls: string[] = []
    const first = approval('one'),
      replaced = approval('two'),
      cancelled = approval('three'),
      otherTeam = approval('other')
    const current = new Map(
      [first, approval('two'), approval('late'), otherTeam].map((p) => [
        p.sessionId,
        { running: false, pendingInteraction: p, completionUnread: false },
      ]),
    )
    const requests = [first, replaced, cancelled, otherTeam].map((pending) => ({
      pending,
      answer: async () => {
        calls.push(pending.key)
      },
    }))
    expect(
      await answerTeamRequests(
        requests,
        () => current,
        new Set(['one', 'two', 'three', 'late'].map(sid)),
        () => true,
        new Set(),
      ),
    ).toBe(0)
    expect(calls).toEqual(['one'])
    await answerTeamRequests(
      requests,
      () => current,
      new Set([sid('one')]),
      () => false,
      new Set(),
    )
    expect(calls).toEqual(['one'])
  })
  it('deduplicates concurrent clicks and isolates partial failures', async () => {
    let release!: () => void
    let calls = 0
    const one = approval('one'),
      two = approval('two')
    const current = new Map(
      [one, two].map((p) => [p.sessionId, { running: false, pendingInteraction: p, completionUnread: false }]),
    )
    const inFlight = new Set<TeamApproval>()
    const requests = [
      {
        pending: one,
        answer: async () => {
          calls++
          await new Promise<void>((resolve) => {
            release = resolve
          })
        },
      },
      {
        pending: two,
        answer: async () => {
          throw new Error('expired')
        },
      },
    ]
    const first = answerTeamRequests(
      requests,
      () => current,
      new Set(current.keys()),
      () => true,
      inFlight,
    )
    const second = answerTeamRequests(
      requests,
      () => current,
      new Set(current.keys()),
      () => true,
      inFlight,
    )
    release()
    expect(await first).toBe(1)
    expect(await second).toBe(0)
    expect(calls).toBe(1)
    expect(inFlight.size).toBe(0)
  })
  it('does not mistake questions or unknown interactions for allow-once approvals', () => {
    const question = {
      key: 'q',
      sessionId: sid('q'),
      kind: 'question',
      questions: [],
      answer: async () => {},
      cancel: async () => {},
    }
    expect(teamApproval(question)).toBeUndefined()
    expect(teamApproval({ key: 'x', sessionId: sid('x'), kind: 'approval' })).toBeUndefined()
  })

  it('compares the pending request, allowing status-only changes and skipping a settled carrier', async () => {
    let calls = 0
    const pending = approval('one')
    const status = new Map([
      [
        pending.sessionId,
        { running: true, pendingInteraction: pending as TeamApproval | undefined, completionUnread: false },
      ],
    ])
    const requests = [
      {
        pending,
        answer: async () => {
          calls++
        },
      },
    ]
    status.set(pending.sessionId, { running: false, pendingInteraction: pending, completionUnread: true })
    await answerTeamRequests(
      requests,
      () => status,
      new Set(status.keys()),
      () => true,
      new Set(),
    )
    expect(calls).toBe(1)
    status.set(pending.sessionId, { running: false, pendingInteraction: undefined, completionUnread: true })
    await answerTeamRequests(
      requests,
      () => status,
      new Set(status.keys()),
      () => true,
      new Set(),
    )
    expect(calls).toBe(1)
  })
})
