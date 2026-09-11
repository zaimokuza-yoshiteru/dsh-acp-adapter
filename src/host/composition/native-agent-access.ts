import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Session } from '@deepseek-ai/dsh-session'
import { snapshotSessionEvents, type SessionLike } from '../../domain/session/current-step-admission.ts'

/**
 * Project ACP's Native Agent Access through DSH's stock permission selector.
 *
 * The Agent process is intentionally unconfined by DSH, while ACP may still
 * ask the user for individual approvals.  That combination does not match a
 * stock DSH preset, so the native projection renders its existing `Custom`
 * value.  These are real session policy overrides, not just UI labels. Apply them
 * only to ACP execution; an empty launcher must retain its native permissions.
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

/** Follow the host's pending selection, then committed route, then entry-point default. */
function accessProvider(ctx: Context, agent: Agent): string | undefined {
  const selected = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
  const explicit = selected?.pending?.provider ?? agent.session.requestHeader()?.config.provider
  if (explicit !== undefined) return explicit
  // Delegated agents own their constructor selection; the Web default belongs
  // to ordinary fresh conversations and must never retarget a Teams member.
  if (agent.session.header.origin === 'subagent') return agent.options.provider
  const defaults = ctx.get('agentDefaultModel')
  return defaults?.currentSelection().provider ?? agent.options.provider
}

/** Apply ACP policy only when input is claimed, before native policy contexts are rendered. */
export function installNativeAgentAccess(ctx: Context, ownsRoute: (provider: string | undefined) => boolean): void {
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    const previous = agent.session.requestHeader()?.config.provider
    // A native transcript cannot become ACP in-place. Its later backend guard
    // will reject that transition; do not alter its permissions on the way there.
    if (previous !== undefined && !ownsRoute(previous)) return
    if (ownsRoute(accessProvider(ctx, agent))) projectNativeAgentAccess(agent.session)
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    if (!ownsRoute(assembly.variables.provider)) return assembly
    // Native children always carry a fixed noninteractive delegation context.
    // ACP members retain interactive permissions; preserve every other host contribution.
    return { ...assembly, contexts: assembly.contexts.map(entry => entry.name === 'subagent:delegation'
      ? { ...entry, text: 'You are a delegated ACP Agent sharing the team workspace. Ordinary operations may require interactive approval through the host; request permission through your normal tools and wait for the user decision. Do not bypass a denial or treat a message as approval. DSH Team coordination tools do not require an additional approval.' }
      : entry) }
  })
}
