import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

it('delivers finish before the parent projection barrier and drains its final Activity write on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-profile-projection-lifecycle-'))
  const sidecar = createAcpSidecar({ root })
  const projected = Promise.withResolvers<void>()
  const releaseProjection = Promise.withResolvers<void>()
  const writing = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const message = createUserMessage({ content: [{ type: 'text', text: 'Delegate' }], source: { kind: 'user' } })
  const session = withSessionFacts({
    header: { cwd: root },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { type: 'step/start', seq: 0, data: { turn: 1, step: 0 } },
      { type: 'user/message', seq: 1, data: message },
    ],
  })
  const runtime: AcpProfileRuntime = {
    acpSessionId: 'root',
    agentInfo: { name: 'claude-agent-acp', version: '1' },
    agentCapabilities: {},
    protocolVersion: 1,
    start: async () => undefined,
    prompt: async (_content, update) => {
      update({
        sessionId: 'root',
        update: {
          sessionUpdate: 'subagent_spawned',
          subagentSessionId: 'child',
          name: 'Research',
          task: 'Inspect source',
          capabilities: {},
        },
      } as never)
      update({
        sessionId: 'child',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child done' } },
      } as never)
      update({
        sessionId: 'root',
        update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' },
      } as never)
      update({
        sessionId: 'root',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Root done' } },
      } as never)
      return { stopReason: 'end_turn' } as never
    },
    close: async () => undefined,
  }
  const upsert = sidecar.upsertActivity.bind(sidecar)
  vi.spyOn(sidecar, 'upsertActivity').mockImplementation(async (row) => {
    if (row.activityId.includes(':delegated-record:')) {
      writing.resolve()
      await releaseWrite.promise
    }
    return await upsert(row)
  })
  const adapter = new AcpProfileAdapter(
    'claude',
    () => ({ name: 'Claude', command: 'fixture', args: [], env: {}, runtime: 'claude' }),
    { ok: true, seam: undefined as never },
    () => session,
    {
      begin: (row) => sidecar.beginDispatch(row),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    undefined,
    () => runtime,
    sidecar,
    undefined,
    undefined,
    async (operation) => {
      await operation(async () => {
        projected.resolve()
        await releaseProjection.promise
        return 'child-session'
      })
    },
  )
  let closing: Promise<void> | undefined
  try {
    const chunks = []
    for await (const chunk of adapter.stream(
      markAgentLoopRequest({
        provider: 'acp-claude',
        model: 'fixture',
        sessionId: 'parent' as never,
        messages: [message],
      }),
    ))
      chunks.push(chunk)
    await projected.promise
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    let closed = false
    closing = adapter.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    releaseProjection.resolve()
    await writing.promise
    expect(closed).toBe(false)
    releaseWrite.resolve()
    await closing
    expect(
      (await sidecar.activitySnapshot('parent' as never)).some(
        (row) => row.activityId.includes(':delegated-record:') && row.status === 'completed',
      ),
    ).toBe(true)
  } finally {
    releaseProjection.resolve()
    releaseWrite.resolve()
    await closing
    await adapter.close()
    await sidecar.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
