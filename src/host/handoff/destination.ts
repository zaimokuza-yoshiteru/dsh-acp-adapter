import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpHandoffTarget } from '../../contract/handoff.ts'

interface HandoffWorkspace {
  readonly id: NonNullable<SessionCreateRequest['workspaceId']>
  readonly path: string
  readonly sessionIds: readonly SessionId[]
  attachSession(sessionId: SessionId): Promise<void>
}

export function handoffWorkspaces(ctx: Context):
  | {
      list(): readonly HandoffWorkspace[]
      readonly archivedSessionIds: readonly SessionId[]
    }
  | undefined {
  return ctx.get('workspaceRegistry', false)
}

export function changedSession() {
  return new RemoteError('session/agent-busy', 'The conversation changed or is busy.', {
    reason: 'HANDOFF_SESSION_CHANGED',
  })
}

/** Optional Host APIs are resolved at the time of the operation, including after a remount. */
export function observeHandoffSession(ctx: Context, id: SessionId, signal?: AbortSignal) {
  const query = ctx.get('sessionQuery')
  if (!query) throw new Error('Session history is unavailable.')
  return query.observeSession(id, { projectionMode: 'none', ...(signal ? { signal } : {}) })
}

export function handoffSessions(ctx: Context) {
  const sessions = ctx.get('sessions')
  if (!sessions) throw new Error('Session storage is unavailable.')
  return sessions
}

export async function mainAgent(ctx: Context, sessionId: string) {
  const controller = ctx.get('sessionController', false)
  if (!controller) throw new Error('The session controller is unavailable.')
  const id = SessionId(sessionId)
  if (handoffWorkspaces(ctx)?.archivedSessionIds.includes(id)) throw changedSession()
  const result = await controller.resolveAgent(id)
  if ('error' in result) throw result.error
  if (result.agent.session.header.origin === 'subagent') throw changedSession()
  return result.agent
}

export async function checkHandoffModel(ctx: Context, target: AcpHandoffTarget) {
  const llm = ctx.get('llm')
  if (!llm) throw changedSession()
  const rows = await llm.listModels(target.provider)
  if (!rows.some((row) => row.id === target.model))
    throw new RemoteError('session/model-unavailable', 'Select an available model.', {
      provider: target.provider,
      model: target.model,
    })
  const selected = {
    provider: target.provider,
    model: target.model,
    ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) }),
  }
  await llm.resolveCallConfig(selected)
  return selected
}

/** Host-minted requestedId is journalled before entry so a lost create reply can locate this exact destination. */
export async function createHandoffDestination(
  ctx: Context,
  sourceSessionId: string,
  target: AcpHandoffTarget,
  requestedId: string,
  authorize: (destinationId?: string) => void,
  existingOnly = false,
): Promise<string> {
  const controller = ctx.get('sessionController', false)
  const workspaces = handoffWorkspaces(ctx)
  if (!controller || !workspaces || !ctx.get('sessionPersistence', false))
    throw new Error('Session storage is unavailable.')
  const source = await mainAgent(ctx, sourceSessionId)
  const workspace = workspaces.list().find((row) => row.sessionIds.includes(source.id))
  const cwd = workspace?.path ?? ctx.get('workingDirectory', false)?.get(source.session) ?? source.session.header.cwd
  const preset = ctx.get('agentPresets', false)?.presetForSession(source.session)
  if (!cwd || requestedId === sourceSessionId) throw changedSession()
  const selected = await checkHandoffModel(ctx, target)
  const requested = SessionId(requestedId)
  const sessions = handoffSessions(ctx)
  const exists = sessions.get(requested) ?? (await ctx.get('sessionPersistence', false)!.stat(requested))
  if (!exists && existingOnly) throw changedSession()
  authorize()
  const id = exists
    ? requested
    : (
        await controller.create({
          sessionId: requested,
          ...(workspace ? { workspaceId: workspace.id } : { cwd }),
          ...(preset ? { agentPreset: preset } : {}),
        })
      ).sessionId
  authorize(id)
  const agent = await mainAgent(ctx, id)
  await agent.runMaintenance(async (signal) => {
    using observed = await observeHandoffSession(ctx, id, signal)
    const currentWorkspace = workspaces.list().find((row) => row.sessionIds.includes(source.id))
    if (
      currentWorkspace?.id !== workspace?.id ||
      agent.session.header.cwd !== cwd ||
      agent.session.header.isSeeded ||
      agent.session.header.origin === 'subagent' ||
      (preset && ctx.get('agentPresets', false)?.presetForSession(agent.session) !== preset) ||
      agent.inbox.nextStep.length ||
      agent.inbox.nextTurn.length ||
      agent.session.requestHeader() ||
      observed.events.some((event) => event.type === 'turn/start')
    )
      throw changedSession()
    signal.throwIfAborted()
    authorize(id)
    if (workspace && !workspace.sessionIds.includes(id)) await workspace.attachSession(id)
    signal.throwIfAborted()
    authorize(id)
    if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length || sessions.get(id) !== agent.session)
      throw changedSession()
    agent.model.select(selected)
    await sessions.flush(agent.session)
  })
  return id
}
