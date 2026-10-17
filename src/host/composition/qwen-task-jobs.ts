import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { QWEN_TASK_JOB_KIND, type QwenTaskJobStarter } from '../../runtime/session/qwen-background.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'acp-qwen-task': 'acp-qwen-task'
  }
}

/**
 * Register Qwen background tasks with the host job registry. A silent outcome
 * arms the public waiter before the registry sees the settlement, so
 * `tool-jobs` treats it as collected and produces no wake-up; an unsilent one
 * is an ordinary completion notice that wakes the idle DSH agent.
 */
export function resolveQwenTaskJobs(ctx: Context, sessionId: string): QwenTaskJobStarter | undefined {
  const holder = ctx as Context & { get(name: string): unknown }
  const jobs = holder.get('jobs') as JobRegistry | undefined
  if (jobs === undefined) return undefined
  return (label, run) => {
    const owner = sessionId as SessionId
    let id!: ReturnType<JobRegistry['start']>
    try {
      id = jobs.start({
        kind: QWEN_TASK_JOB_KIND,
        label,
        owner,
        run: () => {
          const producer = run()
          return {
            cancel: () => {
              producer.cancel()
            },
            done: producer.done.then((outcome) => {
              if (outcome.silent) {
                void jobs.wait(id, 30_000, owner).catch((error: unknown) => {
                  ctx.logger.warn(`ACP Qwen task completion could not be observed: ${String(error)}`)
                })
              }
              return {
                status: outcome.status,
                detail: outcome.detail,
                ...(outcome.result === undefined ? {} : { result: outcome.result }),
              }
            }),
          }
        },
      })
    } catch (error) {
      ctx.logger.warn(`ACP Qwen task job was not registered: ${String(error)}`)
      return undefined
    }
    return {
      cancel: () => {
        jobs.kill(id, owner, 'ACP Qwen task cancellation')
      },
    }
  }
}
