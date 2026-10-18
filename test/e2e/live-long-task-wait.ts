export type LongTaskFailureSubscription = (listener: (failure: unknown) => void) => () => void

export interface LongTaskWaitOptions {
  readonly timeout: number
  readonly interval?: number
  readonly checkHealth: () => void
  readonly subscribeFailure?: LongTaskFailureSubscription
  readonly signal?: AbortSignal
  readonly retryOnError?: (error: unknown) => boolean
}

export class LongTaskWaitTimeoutError extends Error {
  readonly code = 'LONG_TASK_WAIT_TIMEOUT'

  constructor(timeout: number, cause?: unknown) {
    super(`LONG_TASK_WAIT_TIMEOUT after ${timeout}ms`, { cause })
    this.name = 'LongTaskWaitTimeoutError'
  }
}

export function isLongTaskReadinessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly name?: unknown; readonly code?: unknown }
  return candidate.name === 'AssertionError' || candidate.name === 'VitestAssertionError' || candidate.code === 'ENOENT'
}

/**
 * Poll test readiness without retrying a fatal fixture failure. The action runs
 * at most once at a time; its signal allows cooperative cancellation. A pending
 * action's late completion is observed, but cannot start another poll.
 */
export function waitForLongTask<T>(
  action: (signal: AbortSignal) => T | PromiseLike<T>,
  options: LongTaskWaitOptions,
): Promise<T> {
  const {
    timeout,
    interval = 50,
    checkHealth,
    subscribeFailure,
    signal,
    retryOnError = isLongTaskReadinessError,
  } = options
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval < 0) {
    return Promise.reject(new RangeError('Long-task wait requires a positive timeout and a nonnegative interval'))
  }

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeFailure: (() => void) | undefined
    let lastReadinessError: unknown

    const cleanup = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      signal?.removeEventListener('abort', onAbort)
      const unsubscribe = unsubscribeFailure
      unsubscribeFailure = undefined
      unsubscribe?.()
    }
    const fail = (failure: unknown): void => {
      if (settled) return
      settled = true
      controller.abort(failure)
      try {
        cleanup()
      } catch (cleanupFailure: unknown) {
        reject(new AggregateError([failure, cleanupFailure], 'Long-task wait cleanup failed', { cause: failure }))
        return
      }
      reject(failure)
    }
    const healthy = (): boolean => {
      if (settled) return false
      try {
        checkHealth()
        return !settled
      } catch (failure: unknown) {
        fail(failure)
        return false
      }
    }
    const onAbort = (): void => fail(signal?.reason ?? new Error('LONG_TASK_WAIT_ABORTED'))
    const retry = (error: unknown): void => {
      // Health failures are outside the assertion retry path, including those
      // raised while an asynchronous readiness action was still pending.
      if (!healthy()) return
      let retryable: boolean
      try {
        retryable = retryOnError(error)
      } catch (failure: unknown) {
        fail(failure)
        return
      }
      if (!retryable) {
        fail(error)
        return
      }
      lastReadinessError = error
      pollTimer = setTimeout(poll, interval)
    }
    const poll = (): void => {
      pollTimer = undefined
      if (!healthy()) return
      let result: T | PromiseLike<T>
      try {
        result = action(controller.signal)
      } catch (error: unknown) {
        retry(error)
        return
      }
      void Promise.resolve(result).then(
        (value) => {
          if (!healthy()) return
          settled = true
          try {
            cleanup()
            resolve(value)
          } catch (failure: unknown) {
            reject(failure)
          }
        },
        // Always attach a rejection handler, even when a fatal failure settles
        // the wait before this action completes.
        retry,
      )
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      unsubscribeFailure = subscribeFailure?.(fail)
      // A subscription may synchronously report an already known failure.
      if (settled) {
        cleanup()
        return
      }
    } catch (failure: unknown) {
      fail(failure)
      return
    }
    deadlineTimer = setTimeout(() => {
      if (healthy()) fail(new LongTaskWaitTimeoutError(timeout, lastReadinessError))
    }, timeout)
    poll()
  })
}
