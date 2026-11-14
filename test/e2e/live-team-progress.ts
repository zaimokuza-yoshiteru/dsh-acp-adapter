import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { vi } from 'vitest'

/** A completed turn may precede a teammate relay; only an error ends this live scenario. */
export function createLiveTeamProgress() {
  let failure: Error | undefined
  return {
    observe(reason: TurnEndReason) {
      if (reason.kind === 'error') failure ??= new Error(`Live Teams turn failed (${reason.error.code})`)
    },
    async wait(
      check: () => unknown | Promise<unknown>,
      options: { timeout: number; interval: number },
      beforeCheck?: () => Promise<void>,
    ) {
      let lastAssertion: unknown
      let beforeFailure: { error: unknown } | undefined
      try {
        await vi.waitUntil(async () => {
          if (failure !== undefined) throw failure
          try {
            await beforeCheck?.()
          } catch (error) {
            beforeFailure ??= { error }
            throw error
          }
          try {
            await check()
          } catch (error) {
            lastAssertion = error
            return false
          }
          if (failure !== undefined) throw failure
          return true
        }, options)
      } catch (error) {
        if (failure !== undefined) throw failure
        if (beforeFailure !== undefined) throw beforeFailure.error
        throw lastAssertion ?? error
      }
    },
  }
}
