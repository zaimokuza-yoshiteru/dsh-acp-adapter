import { describe, expect, it } from 'vitest'
import {
  finalLongTaskFailure,
  longTaskFailure,
  longTaskOutcome,
  settleLongTaskAction,
} from '../../e2e/live-long-task-lifecycle.ts'

describe('live long-task failure and cleanup ownership', () => {
  it('preserves the primary error when writing evidence and closing also fail', async () => {
    const primary = new Error('LONG_TASK_NATIVE_EXECUTE_UNREGISTERED')
    const diskFailure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const evidence = await settleLongTaskAction(
      'evidence',
      () => {
        throw diskFailure
      },
      'record',
    )
    expect(evidence).toMatchObject({ status: 'rejected', failure: { code: 'ENOSPC' } })
    expect(finalLongTaskFailure({ error: primary }, { error: diskFailure }, true)?.error).toBe(primary)
    expect(finalLongTaskFailure({ error: undefined }, { error: diskFailure }, true)).toEqual({ error: undefined })
    expect(finalLongTaskFailure(undefined, { error: diskFailure }, true)?.error).toBe(diskFailure)
    expect(finalLongTaskFailure(undefined, undefined, true)?.error).toMatchObject({
      message: 'LONG_TASK_FINALIZATION_FAILED',
    })
    expect(finalLongTaskFailure(undefined, undefined, false)).toBeUndefined()
  })
  it('retains a primary violation while successful cancellation and closes stay successful', async () => {
    const primary = longTaskFailure(new Error('LONG_TASK_NATIVE_EXECUTE_UNREGISTERED'), 'B:team')
    const cancellations = [await settleLongTaskAction('member', async () => {}, 'cancel')]
    const cleanup = await Promise.all(
      ['host', 'browser'].map((owner) => settleLongTaskAction(owner, async () => {}, 'cleanup')),
    )
    const outcome = longTaskOutcome(primary, cancellations, cleanup)
    expect(outcome.primary).toMatchObject({ code: 'LONG_TASK_NATIVE_EXECUTE_UNREGISTERED', phase: 'B:team' })
    expect(outcome.cleanupFailed).toBe(false)
    expect([...outcome.cancellations, ...outcome.cleanup].map((entry) => entry.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
  })

  it('keeps individual cancel and close failures separate from the first failure', async () => {
    const primary = longTaskFailure(new Error('LONG_TASK_READ_EVIDENCE_MISSING'), 'B:members')
    const cancellations = [
      await settleLongTaskAction('member-1', async () => {}, 'cancel'),
      await settleLongTaskAction(
        'member-2',
        async () => {
          throw new Error('LONG_TASK_CANCEL_FAILED')
        },
        'cancel',
      ),
    ]
    const cleanup = [
      await settleLongTaskAction(
        'host',
        async () => {
          throw new Error('LONG_TASK_HOST_CLOSE_FAILED')
        },
        'cleanup',
      ),
      await settleLongTaskAction('browser', async () => {}, 'cleanup'),
    ]
    const outcome = longTaskOutcome(primary, cancellations, cleanup)
    expect(outcome.primary).toBe(primary)
    expect(outcome.cleanupFailed).toBe(true)
    expect(outcome.cancellations[1]?.failure?.code).toBe('LONG_TASK_CANCEL_FAILED')
    expect(outcome.cleanup[0]?.failure?.code).toBe('LONG_TASK_HOST_CLOSE_FAILED')
  })

  it('reports setup without a Host and still observes browser close failure', async () => {
    const setup = Object.assign(new Error('spawn failed with private path or token'), { code: 'EACCES' })
    const outcome = longTaskOutcome(
      longTaskFailure(setup, 'setup'),
      [],
      [
        await settleLongTaskAction('host', undefined, 'cleanup'),
        await settleLongTaskAction(
          'browser',
          () => {
            throw new Error('LONG_TASK_BROWSER_CLOSE_FAILED')
          },
          'cleanup',
        ),
      ],
    )
    expect(outcome.primary?.code).toBe('EACCES')
    expect(JSON.stringify(outcome)).not.toContain('private path or token')
    expect(outcome.cleanup[0]?.status).toBe('not-created')
    expect(outcome.cleanupFailed).toBe(true)
  })

  it('fails successful work when a resource close fails without inventing a primary error', async () => {
    const outcome = longTaskOutcome(
      undefined,
      [],
      [
        await settleLongTaskAction(
          'browser',
          async () => {
            throw new Error('LONG_TASK_BROWSER_CLOSE_FAILED')
          },
          'cleanup',
        ),
      ],
    )
    expect(outcome.primary).toBeUndefined()
    expect(outcome.cleanupFailed).toBe(true)
  })

  it('records a cancellation rejection without mislabelling successful resource closes', async () => {
    const outcome = longTaskOutcome(
      undefined,
      [
        await settleLongTaskAction(
          'member',
          () => {
            throw new Error('LONG_TASK_CANCEL_FAILED')
          },
          'cancel',
        ),
      ],
      [await settleLongTaskAction('host', async () => {}, 'cleanup')],
    )
    expect(outcome.cancellationFailed).toBe(true)
    expect(outcome.cleanupFailed).toBe(false)
    expect(outcome.finalizationFailed).toBe(true)
  })
})
