import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import type { QwenActiveWorkSnapshot } from '../../../src/protocol/v1/types.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'

const fixture = fileURLToPath(new URL('../../fixtures/fake-qwen-agent.mjs', import.meta.url))
let subprocess: Awaited<ReturnType<typeof sharedTestSubprocess>>['seam']
const connections: AcpClientConnection[] = []
const roots: string[] = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})
afterEach(async () => {
  await Promise.all(connections.splice(0).map(async (connection) => await connection.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([undefined, 'number'])('preserves only valid optional finished-turn identity (shape=%s)', async (shape) => {
  const cwd = mkdtempSync(join(tmpdir(), 'qwen-work-contract-'))
  roots.push(cwd)
  const snapshots: QwenActiveWorkSnapshot[] = []
  let bodySeen = false
  const connection = new AcpClientConnection(
    {
      argv: [process.execPath, fixture],
      cwd,
      subprocess,
      env: { FAKE_QWEN_DROP_END: '1', ...(shape === undefined ? {} : { FAKE_QWEN_FINISHED_MARKER_SHAPE: shape }) },
    },
    {
      onQwenTurnStart: () => ({ accepted: true }),
      onQwenTurnEnd: () => undefined,
      onQwenActiveWork: (snapshot) => snapshots.push(snapshot),
      onSessionUpdate: (notification) => {
        const update = notification.update
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text === 'The background command printed done.'
        )
          bodySeen = true
      },
    },
  )
  connections.push(connection)
  await connection.initialize()
  const session = await connection.newSession({ cwd })
  expect(connection.qwenActiveWorkIntervalMs).toBe(5000)
  await connection.prompt(session.sessionId, [{ type: 'text', text: 'background' }])
  if (shape === undefined) {
    await expect.poll(() => snapshots.length).toBe(1)
    expect(snapshots[0]?.sessions).toEqual([
      {
        sessionId: session.sessionId,
        holds: [{ category: 'shell', id: 'background-shells' }],
        finishedBackgroundTurnId: `${session.sessionId}########notification1`,
      },
    ])
  } else {
    await expect.poll(() => bodySeen).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(snapshots).toEqual([])
    expect(connection.qwenActiveWorkSnapshot).toBeUndefined()
  }
})
