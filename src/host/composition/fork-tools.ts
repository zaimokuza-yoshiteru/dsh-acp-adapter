import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'

const forkTurnSchema = z.object({ completed: z.boolean(), active: z.boolean() })
type ForkTurnState = z.infer<typeof forkTurnSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    acpForkDelegation: ForkTurnState
  }
}

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
 */
export function installAcpForkTools(ctx: Context): void {
  ctx.inject(['tools', 'sessionProjections'], (child) => {
    // Registration is asynchronous and readiness must precede reads; the guard
    // remains registered immediately and simply has no state until ready.
    let readState: ((session: Session) => ForkTurnState) | undefined
    child.effect(async () => {
      const handle = await child.sessionProjections.register(forkTurnProjection)
      const read = (session: Session): ForkTurnState => handle.stateOf(session)
      readState = read
      return () => {
        if (readState === read) readState = undefined
      }
    }, '@zaimokuza/dsh-acp-adapter: fork-turn projection')
    child.tools.guard((exec) => {
      if (exec.agent === undefined || exec.name !== 'subagent_fork') return
      const args = exec.arguments
      if (
        typeof args !== 'object' ||
        args === null ||
        !('provider' in args) ||
        typeof args.provider !== 'string' ||
        acpAgentIdFromRoute(args.provider) === undefined
      )
        return
      const state = readState?.(exec.agent.session)
      if (state?.completed === true && state.active)
        return 'ACP_DELEGATED_FORK_UNAVAILABLE: An ACP child cannot inherit the completed prefix of an active conversation. Use subagent with a complete, self-contained task or select a native child route.'
    })
  })
}
