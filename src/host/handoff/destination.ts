import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { sameTransferLocation, type AcpHandoffTarget, type AcpTransferLocation } from '../../contract/handoff.ts'

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

/** The active project defines placement for a new chat; execution follows its current directory. */
export function transferLocation(
  ctx: Context,
  session: Session,
  mode: 'placement' | 'execution',
): AcpTransferLocation | undefined {
  const registry = handoffWorkspaces(ctx)
  if (!registry || registry.archivedSessionIds.includes(session.id)) return undefined
  const workspace = registry.list().find((row) => row.sessionIds.includes(session.id))
  const cwd =
    (mode === 'placement' ? workspace?.path : undefined) ??
    ctx.get('workingDirectory', false)?.get(session) ??
    session.header.cwd
  return cwd ? { workspaceId: workspace?.id ?? null, cwd } : undefined
}

/** A cold session's immutable header can predate a durable change of directory. */
export function observedWorkingDirectory(header: SessionHeader, events: readonly SessionEvent[]) {
  const change = events.findLast((event) => event.type === 'working-directory/change')
  return change?.data.cwd ?? header.cwd
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

/** The provider or model is absent from a known catalog. An unsuccessful discovery stays retryable. */
export class UnlistedHandoffModel extends RemoteError<'session/model-unavailable'> {
  constructor(target: AcpHandoffTarget) {
    super('session/model-unavailable', 'Select an available model.', { provider: target.provider, model: target.model })
  }
}

export async function checkHandoffModel(ctx: Context, target: AcpHandoffTarget) {
  const llm = ctx.get('llm')
  if (!llm) throw changedSession()
  try {
    const rows = await llm.listModels(target.provider)
    if (!rows.some((row) => row.id === target.model)) throw new UnlistedHandoffModel(target)
  } catch (error) {
    if (
      error instanceof LlmError &&
      error.code === 'NO_ADAPTER' &&
      !llm.listProviders().some((p) => p.id === target.provider)
    )
      throw new UnlistedHandoffModel(target)
    throw error
  }
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
  beforeCreate?: () => void,
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
  if (!exists) beforeCreate?.()
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
    const targetWorkspace = workspaces.list().find((row) => row.sessionIds.includes(id))
    if (
      currentWorkspace?.id !== workspace?.id ||
      (targetWorkspace !== undefined && targetWorkspace.id !== workspace?.id) ||
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
    if (
      !sameTransferLocation(transferLocation(ctx, agent.session, 'execution'), {
        workspaceId: workspace?.id ?? null,
        cwd,
      }) ||
      agent.inbox.nextStep.length ||
      agent.inbox.nextTurn.length ||
      sessions.get(id) !== agent.session
    )
      throw changedSession()
    agent.model.select(selected)
    await sessions.flush(agent.session)
  })
  return id
}
