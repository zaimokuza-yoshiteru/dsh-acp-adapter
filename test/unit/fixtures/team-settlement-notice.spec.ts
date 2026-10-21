import { afterEach, describe, expect, it, vi } from 'vitest'
import { teamTurn } from '../../mock-agent/team-turn.ts'
import type { MockPeer, MockSession } from '../../mock-agent/types.ts'

const notice = (ending: string) =>
  `Background subagent calculator finished and will do no further work unless you send it more.\nIts closing message:\n${ending}`

async function run(prompt: string) {
  const text: string[] = []
  const responses: unknown[] = []
  const requests = vi.fn(async () => {
    throw new Error('Unexpected Agent request in isolated notice fixture')
  })
  const session: MockSession = {
    id: 'fixture-session',
    cwd: '/fixture',
    modes: null,
    configOptions: null,
    turn: null,
    closed: false,
    teamPermissionContextVerified: true,
  }
  const peer: MockPeer = {
    sendUpdate(_id, update) {
      if (update.sessionUpdate === 'agent_message_chunk') text.push((update.content as { text: string }).text)
    },
    sendAgentRequest: requests,
    respond(_id, result) {
      responses.push(result)
    },
    log() {},
  }
  const handled = await teamTurn(
    session,
    { id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: prompt }] } },
    peer,
  )
  expect(requests).not.toHaveBeenCalled()
  expect(handled).toBe(true)
  expect(responses).toEqual([{ stopReason: 'end_turn' }])
  expect(session.turn).toBe(null)
  return text
}

afterEach(() => vi.unstubAllEnvs())

describe('permission-gated Teams fixture settlement notices', () => {
  it.each(['DONE', 'DENIED', 'CANCELLED', 'CONTINUED'])(
    'acknowledges a native %s notice without inventing tools',
    async (ending) => {
      vi.stubEnv('MOCK_TEAM_PERMISSION_GATE', '/fixture/gate')
      expect(await run(notice(`E2E_TEAM_MEMBER_${ending}`))).toEqual(['E2E_TEAM_NOTICE_RECEIVED'])
    },
  )

  it.each(['CONTINUE', 'REPLY'])('keeps coalesced explicit %s work on the tool path', async (action) => {
    vi.stubEnv('MOCK_TEAM_PERMISSION_GATE', '/fixture/gate')
    expect(await run(`${notice('E2E_TEAM_MEMBER_CONTINUED')}\nE2E_TEAM_${action} explicit-work`)).toEqual([
      'E2E_TEAM_ERROR No Teams MCP server provided',
    ])
  })

  it.each(['E2E_TEAM_MEMBER_CONTINUED', notice('E2E_TEAM_MEMBER_UNKNOWN')])(
    'does not treat an unrecognized message as a native settlement',
    async (prompt) => {
      vi.stubEnv('MOCK_TEAM_PERMISSION_GATE', '/fixture/gate')
      expect(await run(prompt)).toEqual(['E2E_TEAM_ERROR No Teams MCP server provided'])
    },
  )

  it('retains the normal tool path outside permission-gated fixtures', async () => {
    vi.stubEnv('MOCK_TEAM_PERMISSION_GATE', undefined)
    expect(await run(notice('E2E_TEAM_MEMBER_CONTINUED'))).toEqual(['E2E_TEAM_ERROR No Teams MCP server provided'])
  })
})
