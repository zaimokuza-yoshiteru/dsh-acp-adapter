import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { vi } from 'vitest'

/** The result must appear outside the token and task IDs in the final reply. */
export function hasTeamCalculationResult(reply: string | undefined, token: string): boolean {
  return reply?.includes(token) === true && /(?<![\w.+-])\+?2(?:\.0+)?(?!\w|\.\d)/.test(reply.replaceAll(token, ' '))
}

/** Both native board reads return complete tasks. A filtered list can return an empty page. */
export function includesReadTask(tool: string, value: unknown, subject: string): boolean {
  const matches = (task: unknown) =>
    typeof task === 'object' && task !== null && 'subject' in task && task.subject === subject
  if (tool === 'team_task_get') return matches(value)
  if (tool !== 'team_task_list' || typeof value !== 'object' || value === null || !('tasks' in value)) return false
  return Array.isArray(value.tasks) && value.tasks.some(matches)
}

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
