import { describe, expect, it, vi } from 'vitest'
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStreamFactory, RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { AcpRecoveryFrame, AcpRecoveryView } from '../../../src/contract/remote.ts'
import type { AcpRemoteLike } from '../../../src/client/data/acp-remote.ts'
import { recoveringRecoveryStream } from '../../../src/client/data/recovery-stream.ts'

const healthy: AcpRecoveryView = {
  dshSessionId: 'session-1',
  kind: 'healthy',
  cause: null,
  detail: null,
  provider: null,
  acpSessionId: null,
  generation: null,
  interruptedTurnId: null,
  lastAttemptAt: null,
  lastUserAction: null,
  updatedAt: 1,
}

const connection = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/fixture' } }),
    subscribe: () => () => {},
  },
}

function streamFactory(): RemoteStreamFactory {
  return {
    $stream<Item>(options: RemoteStreamOptions<Item>) {
      return new RemoteStream(connection as never, options)
    },
  }
}

describe('recovering recovery snapshot stream', () => {
  it('reopens after a terminal consumer failure only after the old iterator is disposed', async () => {
    let reads = 0
    let active = 0
    let maxActive = 0
    const snapshots: AcpRecoveryView[] = []
    const states: string[] = []
    const remote = {
      async *recoveryFollow(_sessionId: string, signal: AbortSignal): AsyncIterable<AcpRecoveryFrame> {
        reads++
        const read = reads
        active++
        maxActive = Math.max(maxActive, active)
        try {
          yield { type: 'opened', snapshot: { ...healthy, updatedAt: read } }
          if (read === 1) throw new Error('temporary stream read failure')
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          active--
        }
      },
    } as unknown as AcpRemoteLike
    const owner = recoveringRecoveryStream(
      remote,
      streamFactory(),
      'session-1',
      (snapshot) => snapshots.push(snapshot),
      (state) => states.push(state),
    )
    owner.start()

    await vi.waitFor(() => expect(reads).toBe(2), { timeout: 2_000 })
    expect(snapshots.map((snapshot) => snapshot.updatedAt)).toEqual([1, 2])
    expect(states).toContain('reconnecting')
    expect(maxActive).toBe(1)
    await owner.dispose()
    expect(active).toBe(0)
  })

  it('stops automatic reopen for a stable authorization or bad-request failure', async () => {
    let reads = 0
    const states: string[] = []
    const remote = {
      async *recoveryFollow(): AsyncIterable<AcpRecoveryFrame> {
        reads++
        yield { type: 'opened', snapshot: healthy }
        throw new RemoteError('gateway/bad-request', 'invalid session', {})
      },
    } as unknown as AcpRemoteLike
    const snapshots: AcpRecoveryView[] = []
    const owner = recoveringRecoveryStream(
      remote,
      streamFactory(),
      'session-1',
      (snapshot) => snapshots.push(snapshot),
      (state) => states.push(state),
    )
    owner.start()

    await vi.waitFor(() => expect(states).toContain('unavailable'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(reads).toBe(1)
    expect(snapshots).toHaveLength(1)
    expect(states.at(-1)).toBe('unavailable')
    await owner.dispose()
  })

  it('cancels a scheduled replacement when its owner is disposed', async () => {
    let reads = 0
    const remote = {
      async *recoveryFollow(_sessionId: string, signal: AbortSignal): AsyncIterable<AcpRecoveryFrame> {
        reads++
        if (reads === 1) throw new Error('temporary stream read failure')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    } as unknown as AcpRemoteLike
    const owner = recoveringRecoveryStream(
      remote,
      streamFactory(),
      'session-1',
      () => {},
      () => {},
    )
    owner.start()

    await vi.waitFor(() => expect(reads).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 25))
    await owner.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(reads).toBe(1)
  })
})
