import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { handoffHistoryPage, installHandoffHistory } from '../../../src/host/tools/handoff-history.ts'

function transcript(text = 'A') {
  const session = Session.create(SessionId('source'))
  const add = (turn: number, user: string, answer: string, cancelled = false) => {
    session.append('turn/start', { turn })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'private injected data' }],
        source: { kind: 'acp-handoff', operationId: 'previous', part: 'delivery', launchIdentity: null },
      }),
      { surfaceOp: 'append' },
    )
    const message = createAssistantMessage({
      source: { provider: 'example', model: 'small' },
      content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: answer },
      ],
    })
    session.append(
      'assistant/message',
      { turn, step: 1, message, stream: [], ...(cancelled && { interrupted: true }) },
      { surfaceOp: 'append' },
    )
    return session.append('turn/end', { turn, reason: cancelled ? { kind: 'interrupted' } : { kind: 'completed' } }).seq
  }
  add(1, text, 'B')
  const cut = add(2, 'failed turn', 'partial', true)
  add(3, 'C', 'post-handoff')
  return { session, cut, events: session.snapshotEvents() }
}

describe('history handed to an independent session', () => {
  it('includes only completed direct conversation at the chosen cut', () => {
    const { events, cut } = transcript()
    expect(handoffHistoryPage(events, cut)).toEqual({
      messages: [
        { role: 'user', text: 'A' },
        { role: 'assistant', text: 'B' },
      ],
      nextCursor: null,
    })
  })

  it('paginates long messages without losing a character or crossing the source cut', () => {
    const text = 'a'.repeat(7999) + '💬' + 'z'.repeat(5000)
    const { events, cut } = transcript(text)
    const first = handoffHistoryPage(events, cut)
    expect(first.messages[0]?.text).toHaveLength(7999)
    const last = handoffHistoryPage(events, cut, first.nextCursor!)
    expect(last.nextCursor).toBeNull()
    expect(first.messages[0]!.text + last.messages[0]!.text).toBe(text)
    expect(() => handoffHistoryPage(events, cut, 'some-other-session')).toThrow()
    expect(() => handoffHistoryPage(events, events.length + 1)).toThrow()
  })

  function historyFixture() {
    const { session, events, cut } = transcript()
    const source = SessionId('source'),
      dest = SessionId('destination')
    const row = { id: 'workspace', path: '/project', sessionIds: [source, dest] }
    const grant = { sourceSessionId: source, throughSeq: cut, workspaceId: row.id, sourceCwd: row.path }
    const historyFor = vi.fn(async (_id: string): Promise<typeof grant | undefined> => grant)
    const duringRead = vi.fn()
    const observeSession = vi.fn(async (id: string) => {
      if (id === dest)
        return { header: { id: dest }, events: [{ type: 'turn/start', data: { turn: 1 } }], [Symbol.dispose]() {} }
      duringRead()
      return { header: session.header, events, [Symbol.dispose]() {} }
    })
    const register = vi.fn()
    const audiences: { sessionIds: string[] }[] = []
    const decide = vi.fn(() => ({ kind: 'allow' }))
    const services = {
      acpHandoffs: { historyFor },
      workspaceRegistry: { list: () => [row], archivedSessionIds: [] },
      remoteAccess: { decide },
      liveshareShares: { list: async () => ({ shares: audiences }) },
    }
    const on = vi.fn()
    const scope = {
      on,
      logger: { warn: vi.fn() },
      tools: { register },
      sessionQuery: { observeSession },
      get: (key: keyof typeof services) => services[key],
    }
    installHandoffHistory({
      inject: (_names: string[], mount: (ctx: unknown) => void) => mount(scope),
    } as unknown as Context)
    const [tool, options] = register.mock.calls[0]!
    const exec = {
      agent: { id: dest, session: { header: { id: dest } }, inbox: { nextStep: [] } },
      signal: new AbortController().signal,
    }
    const guestSteers = () =>
      on.mock.calls[0]![1]({
        agent: exec.agent,
        turn: 1,
        message: { source: { kind: 'user', principal: { kind: 'share-viewer', shareId: 'link' } } },
      })
    return { tool, options, source, dest, row, grant, historyFor, exec, audiences, decide, duringRead, guestSteers }
  }

  it('resolves the grant from the executing destination and rechecks it after the source read', async () => {
    const { tool, options, dest, row, grant, historyFor, exec } = historyFixture()
    expect(await options.when(exec)).toBe(true)
    expect(JSON.parse(await tool.execute({}, exec)).messages).toHaveLength(2)
    expect(historyFor.mock.calls.every(([id]) => id === dest)).toBe(true)
    historyFor.mockResolvedValueOnce(grant).mockResolvedValueOnce(undefined)
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
    row.sessionIds.pop()
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
    historyFor.mockResolvedValue(undefined)
    expect(await options.when(exec)).toBe(false)
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
  })

  it('withholds the durable result if a destination audience lacks the source, even on an owner turn', async () => {
    const { tool, options, source, dest, exec, audiences, duringRead } = historyFixture()
    audiences.push({ sessionIds: [dest] })
    expect(await options.when(exec)).toBe(false)
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
    expect(duringRead).not.toHaveBeenCalled()
    audiences[0]!.sessionIds.push(source)
    expect(await options.when(exec)).toBe(true)
    duringRead.mockImplementationOnce(() => audiences.push({ sessionIds: [dest] }))
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
  })

  it('requires current source read access for a guest steering an owner turn and checks revocation after reading', async () => {
    const { tool, options, source, dest, exec, audiences, decide, guestSteers, duringRead } = historyFixture()
    audiences.push({ sessionIds: [source, dest] })
    decide.mockReturnValue({ kind: 'deny' })
    expect(await options.when(exec)).toBe(true)
    duringRead.mockImplementationOnce(guestSteers)
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
    expect(decide).toHaveBeenCalledWith({
      principal: { kind: 'share-viewer', shareId: 'link' },
      action: 'session/events',
      resources: [{ kind: 'session', id: source }],
    })
    decide.mockReturnValue({ kind: 'allow' })
    expect(await tool.execute({}, exec)).toContain('messages')
    duringRead.mockImplementationOnce(() => decide.mockReturnValue({ kind: 'deny' }))
    await expect(tool.execute({}, exec)).rejects.toThrow('unavailable')
  })
})
