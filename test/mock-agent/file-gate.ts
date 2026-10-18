import { existsSync } from 'node:fs'

/** Wait for a durable browser-controlled phase gate, with owned cancellation and deadline. */
export function waitForFileGate(path: string, signal: AbortSignal, timeoutMessage: string): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (existsSync(path)) return Promise.resolve(true)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(timeoutMessage))
    }, 45_000)
    const cleanup = () => {
      clearInterval(poll)
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
    const finish = (released: boolean) => {
      cleanup()
      resolve(released)
    }
    const abort = () => finish(false)
    const changed = () => {
      if (existsSync(path)) finish(true)
    }
    // watchFile can adopt a newly created file as its initial stat baseline and
    // never notify. Gates persist until teardown, so observe their state directly.
    const poll = setInterval(changed, 20)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) finish(false)
    else changed()
  })
}
