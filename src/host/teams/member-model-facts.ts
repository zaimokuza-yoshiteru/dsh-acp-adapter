import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-query'

/** Read the model actually requested by this Session, without activating a dormant child. */
export async function readMemberRequestModel(
  ctx: Context,
  id: string,
  provider: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const child = ctx.get('agents', false)?.get(id as never)
  const session = child?.session ?? ctx.get('sessions')?.get(id as never)
  if (session !== undefined) {
    const selection = ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')?.lastUsed
    const used = selection ?? session.requestHeader()?.config
    return used?.provider === provider ? used.model : undefined
  }
  const query = ctx.get('sessionQuery', false)
  if (query === undefined) return undefined
  using observation = await query.observeSession(id as never, signal === undefined ? {} : { signal })
  const used = observation.projections?.values.modelSelection?.lastUsed
  return used?.provider === provider ? used.model : undefined
}
