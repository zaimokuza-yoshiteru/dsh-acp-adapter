import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotSessionEvents, type SessionLike } from '../../domain/session/current-step-admission.ts'

/**
 * Project ACP's Native Agent Access through DSH's stock permission selector.
 *
 * The Agent process is intentionally unconfined by DSH, while ACP may still
 * ask the user for individual approvals.  That combination does not match a
 * stock DSH preset, so the native projection renders its existing `Custom`
 * value.  These events belong only to the already-established ACP session;
 * native sessions never pass through this adapter.
 */
export function projectNativeAgentAccess(session: SessionLike | Session | undefined): void {
  if (session?.append === undefined) return
  const latest = (type: string, key: string): unknown => {
    const events = snapshotSessionEvents(session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== type || typeof event.data !== 'object' || event.data === null) continue
      return (event.data as Record<string, unknown>)[key]
    }
    return undefined
  }
  if (latest('sandbox/mode', 'mode') !== 'danger-full-access') {
    session.append('sandbox/mode', { mode: 'danger-full-access' })
  }
  if (latest('approval/policy', 'policy') !== 'ask') {
    session.append('approval/policy', { policy: 'ask' })
  }
}

/** Align only ACP runtime facts before the host renders its first request. */
export function installNativeAgentAccess(ctx: Context, ownsRoute: (provider: string | undefined) => boolean): void {
  ctx.on('agent/created', ({ agent }) => {
    if (ownsRoute(agent.options.provider)) projectNativeAgentAccess(agent.session)
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (!ownsRoute(context.agent?.options.provider)) return assembly
    // Native children always carry a fixed noninteractive delegation context.
    // ACP members retain interactive permissions; preserve every other host contribution.
    return { ...assembly, contexts: assembly.contexts.map(entry => entry.name === 'subagent:delegation'
      ? { ...entry, text: 'You are a delegated ACP Agent sharing the team workspace. Ordinary operations may require interactive approval through the host; request permission through your normal tools and wait for the user decision. Do not bypass a denial or treat a message as approval. DSH Team coordination tools do not require an additional approval.' }
      : entry) }
  })
}
