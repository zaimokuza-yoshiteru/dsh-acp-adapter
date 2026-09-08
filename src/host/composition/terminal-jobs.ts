import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { AcpTerminalJobStarter } from '../../runtime/client-capabilities/terminal-job.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'acp-terminal': 'acp-terminal' }
}

/** Resolve optional host jobs without creating a second registry or UI store. */
export function resolveTerminalJobs(ctx: Context, sessionId: string): AcpTerminalJobStarter | undefined {
  const holder = ctx as Context & { get(name: string): unknown }
  const jobs = holder.get('jobs') as JobRegistry | undefined
  if (jobs === undefined) return undefined
  return (label, run) => {
    const agents = holder.get('agents') as { get(id: string): Agent | undefined } | undefined
    const owner = agents?.get(sessionId)
    if (owner === undefined) throw new Error('ACP terminal job requires a live owning DSH agent')
    let id!: ReturnType<JobRegistry['start']>
    id = jobs.start({ kind: 'acp-terminal', label, owner, run: () => {
      const producer = run()
      return {
        ...producer,
        done: producer.done.then(outcome => {
          // Arm the public result waiter before publishing the outcome to the
          // registry. Settlement marks it reported before tool-jobs listeners
          // run, so ACP remains the sole completion recipient. No background
          // polling or timer-renewal gap can cause an extra model turn.
          void jobs.wait(id, 30_000, owner).catch((error: unknown) => {
            ctx.logger.warn(`ACP terminal job completion could not be observed: ${String(error)}`)
          })
          return outcome
        }),
      }
    } })
    return { cancel: () => { jobs.kill(id, owner, 'ACP terminal cancellation') } }
  }
}
