import { AssertionError } from 'node:assert'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isLongTaskReadinessError, LongTaskWaitTimeoutError, waitForLongTask } from '../../e2e/live-long-task-wait.ts'

const notReady = (): AssertionError => new AssertionError({ message: 'Not ready yet' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

function failureSource() {
  const listeners = new Set<(error: unknown) => void>()
  return {
    subscribe: (listener: (error: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: (error: unknown) => {
      for (const listener of [...listeners]) listener(error)
    },
    listeners,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('retries assertion and missing-marker readiness errors, then releases timers and the failure subscription', async () => {
  const source = failureSource()
  const checkHealth = vi.fn()
  const action = vi
    .fn()
    .mockImplementationOnce(() => {
      throw notReady()
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('Marker does not exist yet'), { code: 'ENOENT' })
    })
    .mockReturnValue('ready')
  const result = waitForLongTask(action, {
    timeout: 1000,
    interval: 100,
    checkHealth,
    subscribeFailure: source.subscribe,
  })

  await vi.advanceTimersByTimeAsync(200)
  await expect(result).resolves.toBe('ready')
  expect(action).toHaveBeenCalledTimes(3)
  expect(checkHealth).toHaveBeenCalled()
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('escapes a preexisting health failure before invoking the readiness action', async () => {
  const primary = new Error('LONG_TASK_NATIVE_EXECUTE_UNREGISTERED')
  const action = vi.fn()
  const source = failureSource()
  await expect(
    waitForLongTask(action, {
      timeout: 180000,
      checkHealth: () => {
        throw primary
      },
      subscribeFailure: source.subscribe,
    }),
  ).rejects.toBe(primary)
  expect(action).not.toHaveBeenCalled()
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects at the fatal event rather than the phase deadline, and consumes a pending action late rejection', async () => {
  const source = failureSource()
  const pending = deferred<void>()
  const primary = new Error('LONG_TASK_NATIVE_EXECUTE_UNREGISTERED')
  let actionSignal: AbortSignal | undefined
  const action = vi.fn((signal: AbortSignal) => {
    actionSignal = signal
    return pending.promise
  })
  const result = waitForLongTask(action, {
    timeout: 180000,
    interval: 100,
    checkHealth: () => undefined,
    subscribeFailure: source.subscribe,
  })
  const rejected = expect(result).rejects.toBe(primary)
  await vi.advanceTimersByTimeAsync(21249)
  source.emit(primary)
  await rejected

  expect(actionSignal?.aborted).toBe(true)
  expect(actionSignal?.reason).toBe(primary)
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  pending.reject(new Error('Late readiness failure'))
  await vi.advanceTimersByTimeAsync(180000)
  expect(action).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('never overlaps asynchronous readiness actions', async () => {
  const first = deferred<string>()
  let inFlight = 0
  let maximumInFlight = 0
  const action = vi.fn(async () => {
    inFlight += 1
    maximumInFlight = Math.max(maximumInFlight, inFlight)
    try {
      return action.mock.calls.length === 1 ? await first.promise : 'ready'
    } finally {
      inFlight -= 1
    }
  })
  const result = waitForLongTask(action, { timeout: 10000, interval: 100, checkHealth: () => undefined })

  await vi.advanceTimersByTimeAsync(5000)
  expect(action).toHaveBeenCalledTimes(1)
  first.reject(notReady())
  await vi.advanceTimersByTimeAsync(99)
  expect(action).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe('ready')
  expect(action).toHaveBeenCalledTimes(2)
  expect(maximumInFlight).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops a pending readiness action on timeout and observes its late rejection without scheduling another poll', async () => {
  const pending = deferred<void>()
  const source = failureSource()
  let actionSignal: AbortSignal | undefined
  const action = vi.fn((signal: AbortSignal) => {
    actionSignal = signal
    return pending.promise
  })
  const result = waitForLongTask(action, {
    timeout: 1000,
    checkHealth: () => undefined,
    subscribeFailure: source.subscribe,
  })
  const rejected = expect(result).rejects.toBeInstanceOf(LongTaskWaitTimeoutError)
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  expect(actionSignal?.aborted).toBe(true)
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  pending.reject(notReady())
  await vi.advanceTimersByTimeAsync(10000)
  expect(action).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the last readiness assertion as the timeout cause', async () => {
  const readiness = notReady()
  const result = waitForLongTask(
    () => {
      throw readiness
    },
    { timeout: 1000, interval: 100, checkHealth: () => undefined },
  )
  const rejected = expect(result).rejects.toMatchObject({
    code: 'LONG_TASK_WAIT_TIMEOUT',
    cause: readiness,
  })
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves a health deadline error over a secondary readiness timeout', async () => {
  const primary = new Error('LONG_TASK_PHASE_DEADLINE_B:team')
  const deadline = Date.now() + 1000
  const result = waitForLongTask(
    () => {
      throw notReady()
    },
    {
      timeout: 1000,
      interval: 100,
      checkHealth: () => {
        if (Date.now() >= deadline) throw primary
      },
    },
  )
  const rejected = expect(result).rejects.toBe(primary)
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retry ordinary operational errors', async () => {
  const primary = new TypeError('Malformed task shape')
  const action = vi.fn(() => {
    throw primary
  })
  await expect(waitForLongTask(action, { timeout: 1000, checkHealth: () => undefined })).rejects.toBe(primary)
  await vi.advanceTimersByTimeAsync(1000)
  expect(action).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('rechecks fatal health outside the readiness-error retry path', async () => {
  const primary = new Error('LONG_TASK_BUDGET_EXHAUSTED')
  let fatal = false
  const action = vi.fn(() => {
    fatal = true
    throw notReady()
  })
  await expect(
    waitForLongTask(action, {
      timeout: 1000,
      checkHealth: () => {
        if (fatal) throw primary
      },
    }),
  ).rejects.toBe(primary)
  expect(action).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('honors an external abort, including an already aborted signal: %s', async (alreadyAborted) => {
  const controller = new AbortController()
  const primary = new Error('LONG_TASK_PRIMARY_FAILURE')
  const source = failureSource()
  const action = vi.fn(() => new Promise<never>(() => undefined))
  if (alreadyAborted) controller.abort(primary)
  const result = waitForLongTask(action, {
    timeout: 1000,
    checkHealth: () => undefined,
    signal: controller.signal,
    subscribeFailure: source.subscribe,
  })
  const rejected = expect(result).rejects.toBe(primary)
  if (!alreadyAborted) controller.abort(primary)
  await rejected
  expect(action).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('removes the external abort listener after a successful wait', async () => {
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  await expect(
    waitForLongTask(() => 'ready', { timeout: 1000, checkHealth: () => undefined, signal: controller.signal }),
  ).resolves.toBe('ready')
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans up a subscription that synchronously reports an existing fatal failure', async () => {
  const primary = new Error('LONG_TASK_ALREADY_FAILED')
  const unsubscribe = vi.fn()
  const action = vi.fn()
  await expect(
    waitForLongTask(action, {
      timeout: 1000,
      checkHealth: () => undefined,
      subscribeFailure: (listener) => {
        listener(primary)
        return unsubscribe
      },
    }),
  ).rejects.toBe(primary)
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(action).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains both primary and unsubscribe failures without throwing an unobserved callback error', async () => {
  const primary = new Error('LONG_TASK_FATAL')
  const cleanupFailure = new Error('Unsubscribe failed')
  const source = failureSource()
  const result = waitForLongTask(() => new Promise<never>(() => undefined), {
    timeout: 1000,
    checkHealth: () => undefined,
    subscribeFailure: (listener) => {
      source.subscribe(listener)
      return () => {
        source.listeners.delete(listener)
        throw cleanupFailure
      }
    },
  })
  const rejected = expect(result).rejects.toMatchObject({ cause: primary, errors: [primary, cleanupFailure] })
  source.emit(primary)
  await rejected
  expect(source.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('limits automatic retries to known assertion or missing-marker readiness errors', () => {
  expect(isLongTaskReadinessError(notReady())).toBe(true)
  expect(isLongTaskReadinessError({ name: 'VitestAssertionError' })).toBe(true)
  expect(isLongTaskReadinessError({ code: 'ENOENT' })).toBe(true)
  expect(isLongTaskReadinessError(new Error('LONG_TASK_FATAL'))).toBe(false)
  expect(isLongTaskReadinessError({ code: 'EACCES' })).toBe(false)
  expect(isLongTaskReadinessError('AssertionError')).toBe(false)
  expect(isLongTaskReadinessError(null)).toBe(false)
})
