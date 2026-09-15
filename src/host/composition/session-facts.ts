import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { applySessionFact, initialSessionFacts, sessionFactsSchema, type SessionFacts, type SessionLike } from '../../domain/session/session-facts.ts'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { acpExecution: SessionFacts }
}

export const acpExecutionProjection = {
  key: 'acpExecution', stateVersion: 1, stateSchema: sessionFactsSchema,
  init: (_header, inheritedEventCount) => initialSessionFacts(inheritedEventCount),
  apply: applySessionFact,
} satisfies ProjectionDefinition<'acpExecution'>

export function readSessionFacts(ctx: Context, session: Session): SessionFacts {
  const state = ctx.sessionProjections.stateOf(session, 'acpExecution')
  if (state === undefined) throw new Error('ACP execution projection is unavailable')
  return state
}

/** Accessors always read the host's current cut, including after a policy append. */
export function acpSessionView(ctx: Context, session: Session | undefined): SessionLike | undefined {
  if (session === undefined) return undefined
  return {
    identity: session,
    header: session.header,
    get seq() { return session.seq },
    get facts() { return readSessionFacts(ctx, session) },
    get permissions() {
      const state = ctx.sessionProjections.stateOf(session, 'permissions')
      if (state === undefined) throw new Error('DSH permission projection is unavailable')
      return state
    },
    append: (type, data) => session.append(type as keyof SessionEventMap, data as never),
  }
}
