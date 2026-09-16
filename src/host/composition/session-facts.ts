import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tool-todo'
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
    watchTurnEnd: listener => ctx.on('session/event', (owner, event) => {
      if (owner.id === session.id && event.type === 'turn/end') listener()
    }),
    watchRouteChange: (provider, listener) => ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      if (agent.id === session.id && config.provider !== provider) await listener()
      return config
    }),
    watchSteering: listener => {
      let disposed = false
      const check = (): void => {
        if (disposed) return
        const agent = ctx.get('agents')?.get(session.id)
        if (agent?.inbox.nextStep.some(message => message.source.kind === 'user')) listener()
      }
      // Re-read after the mutation's synchronous listeners have run: an edit or
      // removal in the same task must not interrupt an otherwise valid prompt.
      const off = ctx.on('agent/inbox/inserted', ({ agent }) => {
        if (agent.id === session.id) queueMicrotask(check)
      })
      queueMicrotask(check)
      return () => { disposed = true; off() }
    },
    publishPlan: todos => {
      // tool-todo is optional. Its projection owns current plan state and the native dock.
      if (ctx.sessionProjections.stateOf(session, 'todos') === undefined) return
      session.append('todo/write', { todos: [...todos] })
    },
  }
}
