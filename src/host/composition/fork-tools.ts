import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const forkTurnSchema = z.object({ completed: z.boolean(), active: z.boolean() })
type ForkTurnState = z.infer<typeof forkTurnSchema>

const forkTurnProjection = {
  key: 'acpForkDelegation',
  stateVersion: 1,
  stateSchema: forkTurnSchema,
  init: () => ({ completed: false, active: false }),
  apply: (state, event) =>
    event.type === 'turn/end'
      ? { completed: true, active: false }
      : event.type === 'turn/start'
        ? { ...state, active: true }
        : state,
} satisfies ProjectionDefinition<'acpForkDelegation', ForkTurnState>

/**
 * Reject a known ACP child target when an active parent can only offer a
 * completed-history prefix. Tool definitions do not expose their configured
 * child route, so omitted targets retain native route validation and the ACP
 * provider's final seeded-fork gate. Keep the schema visible for native routes.
 * @param ctx - Host composition owning the projection and execution guard.
 * @param ownsProvider - Whether this plugin currently serves the explicit child route.
 */
export async function installAcpForkTools(ctx: Context, ownsProvider: (provider: string) => boolean): Promise<void> {
  const projection = await ctx.sessionProjections.register(forkTurnProjection)
  ctx.fiber.assertActive()
  ctx.inject(['tools'], (child) => {
    child.tools.guard((exec) => {
      if (exec.agent === undefined || exec.name !== 'subagent_fork') return
      const args = exec.arguments
      if (
        typeof args !== 'object' ||
        args === null ||
        !('provider' in args) ||
        typeof args.provider !== 'string' ||
        !ownsProvider(args.provider)
      )
        return
      const state = projection.stateOf(exec.agent.session)
      if (state?.completed === true && state.active)
        return {
          reason:
            'ACP_DELEGATED_FORK_UNAVAILABLE: An ACP child cannot inherit the completed prefix of an active conversation. Use subagent with a complete, self-contained task or select a native child route.',
          info: { name: 'HarnessError', code: 'ACP_DELEGATED_FORK_UNAVAILABLE' },
        }
    })
  })
}
