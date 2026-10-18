import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workDetailsTurn } from '../../mock-agent/work-details-turn.ts'
import type { MockSession } from '../../mock-agent/types.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-work-details-turn-'))
  vi.stubEnv('MOCK_WORK_DETAILS_GATE_DIR', directory)
  const session: MockSession = { id: 's', cwd: directory, modes: null, configOptions: null, turn: null, closed: false }
  const peer = {
    sendUpdate: vi.fn(),
    respond: vi.fn(),
    sendAgentRequest: async () => {
      throw new Error('Unexpected fixture request')
    },
    log: () => {},
  }
  const pending = workDetailsTurn(
    session,
    {
      id: 1,
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'E2E_WORK_DETAILS fixture' }] },
    },
    peer,
  )
  void pending.catch(() => {})
  const gate = (phase: string) => join(directory, `fixture-${phase}`)
  return {
    session,
    peer,
    pending,
    gate,
    async close() {
      session.turn?.cancel()
      try {
        await Promise.allSettled([pending])
      } finally {
        rmSync(directory, { recursive: true, force: true })
        vi.unstubAllEnvs()
      }
    },
  }
}

it('holds initial, streaming and terminal work-details phases behind observable gates', async () => {
  const test = fixture()
  try {
    expect(existsSync(test.gate('ready'))).toBe(true)
    expect(test.peer.sendUpdate).not.toHaveBeenCalled()
    expect(test.peer.respond).not.toHaveBeenCalled()
    writeFileSync(test.gate('output'), 'output')
    await vi.advanceTimersByTimeAsync(20)
    expect(existsSync(test.gate('streaming'))).toBe(true)
    expect(test.peer.sendUpdate.mock.calls.map((call) => call[1].sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'tool_call',
      'agent_message_chunk',
      'plan',
      'agent_thought_chunk',
      'tool_call',
    ])
    expect(test.peer.respond).not.toHaveBeenCalled()
    writeFileSync(test.gate('finish'), 'finish')
    await vi.advanceTimersByTimeAsync(20)
    await expect(test.pending).resolves.toBe(true)
    expect(test.peer.sendUpdate.mock.calls.at(-2)?.[1]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
    })
    expect(test.peer.sendUpdate.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'E2E_PREF_DONE fixture' },
    })
    expect(test.peer.respond).toHaveBeenCalledExactlyOnceWith(1, { stopReason: 'end_turn' })
    expect(test.session.turn).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await test.close()
  }
})

it.each(['ready', 'streaming'])('cancels and releases a work-details fixture paused at %s', async (phase) => {
  const test = fixture()
  try {
    if (phase === 'streaming') {
      writeFileSync(test.gate('output'), 'output')
      await vi.advanceTimersByTimeAsync(20)
      expect(existsSync(test.gate('streaming'))).toBe(true)
    }
    test.session.turn?.cancel()
    await expect(test.pending).resolves.toBe(true)
    expect(test.peer.respond).toHaveBeenCalledExactlyOnceWith(1, { stopReason: 'cancelled' })
    expect(test.session.turn).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await test.close()
  }
})

it.each(['output', 'finish'])('rejects a missing %s gate without reporting a successful turn', async (phase) => {
  const test = fixture()
  try {
    if (phase === 'finish') {
      writeFileSync(test.gate('output'), 'output')
      await vi.advanceTimersByTimeAsync(20)
      expect(existsSync(test.gate('streaming'))).toBe(true)
    }
    await vi.advanceTimersByTimeAsync(45_000)
    await expect(test.pending).rejects.toThrow(`Work-details fixture did not receive its ${phase} gate`)
    expect(test.peer.respond).not.toHaveBeenCalled()
    expect(test.session.turn).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    const updates = test.peer.sendUpdate.mock.calls.length
    writeFileSync(test.gate(phase), 'too late')
    await vi.advanceTimersByTimeAsync(100)
    expect(test.peer.sendUpdate).toHaveBeenCalledTimes(updates)
    expect(test.peer.respond).not.toHaveBeenCalled()
  } finally {
    await test.close()
  }
})
