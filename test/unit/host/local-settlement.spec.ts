import { describe, expect, it, vi } from 'vitest'
import {
  AcpLocalSettlementError,
  localSettlementStatus,
  registerLocalSettlementSink,
  settleLocally,
  settlePendingLocally,
} from '../../../src/host/composition/local-settlement.ts'

describe('local terminal settlement queue', () => {
  it('retries transient writes and clears status after success', async () => {
    const root = {}
    const owner = {}
    const onStatusChange = vi.fn()
    let attempts = 0

    await settleLocally(
      root,
      'session-a',
      'dispatch-a',
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary disk error')
      },
      owner,
      onStatusChange,
      {},
    )

    expect(attempts).toBe(2)
    expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
    expect(onStatusChange).toHaveBeenCalledTimes(2)
  })

  it('retains exhausted writes and retries them without blocking other sessions', async () => {
    const root = {}
    const owner = {}
    let attemptsA = 0
    let attemptsB = 0
    let storageAvailable = false

    await expect(
      settleLocally(
        root,
        'session-a',
        'dispatch-a',
        async () => {
          attemptsA += 1
          if (!storageAvailable) throw new Error('storage unavailable')
        },
        owner,
        () => undefined,
        {},
      ),
    ).rejects.toBeInstanceOf(AcpLocalSettlementError)

    expect(localSettlementStatus(root, 'session-a')).toBe('storage-error')
    await settleLocally(
      root,
      'session-b',
      'dispatch-b',
      async () => {
        attemptsB += 1
      },
      {},
      () => undefined,
      {},
    )
    expect(attemptsB).toBe(1)

    storageAvailable = true
    await settlePendingLocally(root, 'session-a', {})
    expect(attemptsA).toBe(4)
    expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
  })

  it('shares one in-flight drain across concurrent requests', async () => {
    const root = {}
    const owner = {}
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let attempts = 0
    const enqueue = settleLocally(
      root,
      'session-a',
      'dispatch-a',
      async () => {
        attempts += 1
        await gate
      },
      owner,
      () => undefined,
      {},
    )
    const firstDrain = settlePendingLocally(root, 'session-a', {})
    const secondDrain = settlePendingLocally(root, 'session-a', {})
    release()

    await Promise.all([enqueue, firstDrain, secondDrain])
    expect(attempts).toBe(1)
    expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
  })

  it('continues a failed settlement in the background without another prompt', async () => {
    vi.useFakeTimers()
    const root = {}
    const owner = {}
    let attempts = 0
    let storageAvailable = false
    const sink = {}
    const statuses: Array<string | undefined> = []
    const dispose = registerLocalSettlementSink(root, 'profile-a', owner, sink)
    try {
      const enqueue = settleLocally(
        root,
        'session-a',
        'dispatch-a',
        async () => {
          attempts += 1
          if (!storageAvailable) throw new Error('temporary storage failure')
        },
        owner,
        () => statuses.push(localSettlementStatus(root, 'session-a')),
        sink,
        'profile-a',
      )
      const rejected = expect(enqueue).rejects.toBeInstanceOf(AcpLocalSettlementError)
      await vi.advanceTimersByTimeAsync(60)
      await rejected
      expect(attempts).toBe(3)
      expect(localSettlementStatus(root, 'session-a')).toBe('storage-error')

      storageAvailable = true
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attempts).toBe(4)
      expect(statuses).toEqual(['saving-results', 'storage-error', undefined])
      expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
    } finally {
      await dispose()
      vi.useRealTimers()
    }
  })

  it('lets the next prompt join a background retry and perform one foreground recovery', async () => {
    vi.useFakeTimers()
    const root = {}
    const owner = {}
    let attempts = 0
    let releaseBackground!: () => void
    let backgroundEntered!: () => void
    const entered = new Promise<void>((resolve) => (backgroundEntered = resolve))
    const backgroundGate = new Promise<void>((resolve) => (releaseBackground = resolve))
    const sink = {}
    const dispose = registerLocalSettlementSink(root, 'profile-a', owner, sink)
    try {
      const task = async () => {
        attempts += 1
        if (attempts <= 3) throw new Error('temporary storage failure')
        if (attempts === 4) {
          backgroundEntered()
          await backgroundGate
          throw new Error('background retry still failed')
        }
      }
      const enqueue = settleLocally(root, 'session-a', 'dispatch-a', task, owner, () => undefined, sink, 'profile-a')
      const rejected = expect(enqueue).rejects.toBeInstanceOf(AcpLocalSettlementError)
      await vi.advanceTimersByTimeAsync(60)
      await rejected
      expect(attempts).toBe(3)

      await vi.advanceTimersByTimeAsync(1_000)
      await entered
      const firstPromptSettlement = settlePendingLocally(root, 'session-a', sink, 'profile-a')
      const concurrentPromptSettlement = settlePendingLocally(root, 'session-a', sink, 'profile-a')
      releaseBackground()
      await Promise.all([firstPromptSettlement, concurrentPromptSettlement])
      expect(attempts).toBe(5)
      expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
    } finally {
      releaseBackground()
      await dispose()
      vi.useRealTimers()
    }
  })

  it('pauses on owner close and resumes with only the replacement profile sink', async () => {
    vi.useFakeTimers()
    const root = {}
    const firstOwner = {}
    const secondOwner = {}
    let firstSinkWrites = 0
    let secondSinkWrites = 0
    const firstSink = {
      write: async () => {
        firstSinkWrites += 1
        throw new Error('closed storage')
      },
    }
    let resolveSecondWrite!: () => void
    const secondWriteDone = new Promise<void>((resolve) => (resolveSecondWrite = resolve))
    const secondSink = {
      write: async () => {
        secondSinkWrites += 1
        resolveSecondWrite()
      },
    }
    const disposeFirst = registerLocalSettlementSink(root, 'profile-a', firstOwner, firstSink)
    try {
      const enqueue = settleLocally(
        root,
        'session-a',
        'dispatch-a',
        async (sink: typeof firstSink) => await sink.write(),
        firstOwner,
        () => undefined,
        firstSink,
        'profile-a',
      )
      const rejected = expect(enqueue).rejects.toBeInstanceOf(AcpLocalSettlementError)
      await vi.advanceTimersByTimeAsync(60)
      await rejected
      expect(firstSinkWrites).toBe(3)

      await disposeFirst()
      const disposeSecond = registerLocalSettlementSink(root, 'profile-a', secondOwner, secondSink)
      // A delayed disposer for an old owner must not unregister its replacement.
      await disposeFirst()
      try {
        await secondWriteDone
        await settlePendingLocally(root, 'session-a', secondSink, 'profile-a')
        expect(secondSinkWrites).toBe(1)
        expect(firstSinkWrites).toBe(3)
        expect(localSettlementStatus(root, 'session-a')).toBeUndefined()
      } finally {
        await disposeSecond()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a scheduled batch with the old sink when enqueue and close share a tick', async () => {
    const root = {}
    const owner = {}
    let writes = 0
    const sink = {
      write: async () => {
        writes += 1
      },
    }
    const dispose = registerLocalSettlementSink(root, 'profile-a', owner, sink)
    const enqueue = settleLocally(
      root,
      'session-a',
      'dispatch-a',
      async (candidate: typeof sink) => await candidate.write(),
      owner,
      () => undefined,
      sink,
      'profile-a',
    )
    const closing = dispose()
    await expect(enqueue).rejects.toBeInstanceOf(AcpLocalSettlementError)
    await closing
    expect(writes).toBe(0)
  })

  it('uses the replacement sink when ownership changes before a scheduled batch starts', async () => {
    const root = {}
    const firstOwner = {}
    const secondOwner = {}
    let firstWrites = 0
    let secondWrites = 0
    const firstSink = {
      write: async () => {
        firstWrites += 1
      },
    }
    const secondSink = {
      write: async () => {
        secondWrites += 1
      },
    }
    const disposeFirst = registerLocalSettlementSink(root, 'profile-a', firstOwner, firstSink)
    const enqueue = settleLocally(
      root,
      'session-a',
      'dispatch-a',
      async (candidate: typeof firstSink) => await candidate.write(),
      firstOwner,
      () => undefined,
      firstSink,
      'profile-a',
    )
    const disposeSecond = registerLocalSettlementSink(root, 'profile-a', secondOwner, secondSink)
    await enqueue
    await disposeFirst()
    expect(firstWrites).toBe(0)
    expect(secondWrites).toBe(1)
    await disposeSecond()
  })

  it('does not cross profile boundaries when settling a retained session task', async () => {
    vi.useFakeTimers()
    const root = {}
    const ownerA = {}
    const ownerB = {}
    let writesA = 0
    let writesB = 0
    const sinkA = {
      write: async () => {
        writesA += 1
      },
    }
    const sinkB = {
      write: async () => {
        writesB += 1
      },
    }
    const disposeA = registerLocalSettlementSink(root, 'profile-a', ownerA, sinkA)
    const disposeB = registerLocalSettlementSink(root, 'profile-b', ownerB, sinkB)
    let attempts = 0
    try {
      const enqueue = settleLocally(
        root,
        'session-a',
        'dispatch-a',
        async () => {
          attempts += 1
          if (attempts <= 3) throw new Error('temporary storage failure')
          await sinkA.write()
        },
        ownerA,
        () => undefined,
        sinkA,
        'profile-a',
      )
      const rejected = expect(enqueue).rejects.toBeInstanceOf(AcpLocalSettlementError)
      await vi.advanceTimersByTimeAsync(60)
      await rejected

      await expect(settlePendingLocally(root, 'session-a', sinkB, 'profile-b')).rejects.toBeInstanceOf(
        AcpLocalSettlementError,
      )
      expect(writesA).toBe(0)
      expect(writesB).toBe(0)
      await settlePendingLocally(root, 'session-a', sinkA, 'profile-a')
      expect(writesA).toBe(1)
      expect(writesB).toBe(0)
    } finally {
      await Promise.all([disposeA(), disposeB()])
      vi.useRealTimers()
    }
  })
})
