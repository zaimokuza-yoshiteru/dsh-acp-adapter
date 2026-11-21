import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-query'
import { ACP_AGENT_ID_PATTERN, acpRouteId } from '../../contract/agent-config.ts'
import {
  acpDeclaredModelRoute,
  acpModelSelection,
  isAcpModelRouteWithinBounds,
} from '../../contract/model-selection.ts'
import type { IndependentSessionRequests } from '../../persistence/independent-session.ts'
import { createHandoffDestination } from '../handoff/destination.ts'

const taskSource = 'dsh-acp-adapter/agent-task'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-acp-adapter/agent-task': {
      kind: typeof taskSource
      sourceSessionId: string
      requestKey: string
      agent: string
      model: string
      profileIdentity: string
    }
  }
}

interface OwnerTurn {
  readonly turn: number
  ownerInput?: string
  committed: boolean
  shared: boolean
}

function mainSession(session: Session): boolean {
  return session.header.origin !== 'subagent' && !session.header.delegationDepth
}

/** Only a foreground owner request that was both claimed and committed may create another top-level Session. */
export class CreateSessionAuthority {
  private readonly turns = new WeakMap<Session, OwnerTurn>()

  claimed(session: Session, turn: number, message: UserMessage): void {
    let state = this.turns.get(session)
    if (state?.turn !== turn) {
      state = { turn, committed: false, shared: false }
      this.turns.set(session, state)
    }
    const source = message.source
    if ('principal' in source && source.principal !== undefined) state.shared = true
    if (source.kind === 'user' && 'rpcId' in source && !state.ownerInput) state.ownerInput = message.id
  }

  committed(session: Session, message: UserMessage): void {
    const state = this.turns.get(session)
    if (!state) return
    if ('principal' in message.source && message.source.principal !== undefined) state.shared = true
    if (message.id === state.ownerInput && message.source.kind === 'user' && 'rpcId' in message.source)
      state.committed = true
  }

  end(session: Session): void {
    this.turns.delete(session)
  }

  owner(session: Session): string | undefined {
    const state = this.turns.get(session)
    return mainSession(session) && state?.committed && !state.shared ? state.ownerInput : undefined
  }
}

interface Arguments {
  agent: string
  model: string
  task?: string
}

interface ToolDeps {
  readonly requests: IndependentSessionRequests
  readonly targetProfile: (id: string) => string | undefined
  readonly profileIds: () => string[]
  readonly models: (provider: string) => Promise<readonly { id: string }[]>
  readonly create: (
    source: string,
    selection: { provider: string; model: string },
    id: string,
    check: () => void,
    existingOnly: boolean,
  ) => Promise<string>
  readonly submit: (id: string, args: Arguments, source: string, key: string, identity: string) => Promise<void>
  readonly submitted: (id: string, key: string) => Promise<boolean>
}

/** Use one key per owner request and exact task, including on ACP bridges that mint a fresh DSH call ID per retry. */
export async function createIndependentSession(
  deps: ToolDeps,
  source: string,
  ownerInput: string,
  args: Arguments,
  authorize: () => void,
): Promise<{ sessionId: string; status: 'created' | 'task-queued' }> {
  authorize()
  const identity = ACP_AGENT_ID_PATTERN.test(args.agent) ? deps.targetProfile(args.agent) : undefined
  if (identity === undefined)
    throw new Error(
      'ACP_SESSION_UNKNOWN_AGENT: Choose an installed Agent ID: ' + deps.profileIds().slice(0, 32).join(', '),
    )
  const provider = acpRouteId(args.agent)
  const model = acpDeclaredModelRoute(args.model)
  if (!isAcpModelRouteWithinBounds(model) || (args.task !== undefined && !args.task.trim()))
    throw new Error('ACP_SESSION_INVALID_ARGUMENT: Supply a model ID and a nonblank task when used.')
  const requireCurrent = () => {
    authorize()
    if (deps.targetProfile(args.agent) !== identity)
      throw new Error('ACP_SESSION_AGENT_CHANGED: Select the installed Agent again.')
  }
  const models = await deps.models(provider)
  requireCurrent()
  if (!models.some((row) => row.id === model)) {
    const choices = models
      .map((row) => acpModelSelection(row.id))
      .flatMap((row) => (row.kind === 'declared-model' ? [row.value] : []))
    throw new Error('ACP_SESSION_UNKNOWN_MODEL: Choose an advertised model ID: ' + choices.slice(0, 32).join(', '))
  }
  const key = createHash('sha256')
    .update(JSON.stringify([ownerInput, args.agent, args.model, args.task ?? null]))
    .digest('hex')
  const receipt = deps.requests.reserve(source, key, args.agent, args.model, identity)
  let { sessionId, phase } = receipt
  if (phase === 'creating') {
    sessionId = await deps.create(source, { provider, model }, sessionId, requireCurrent, !receipt.fresh)
    deps.requests.advance(source, key, 'creating', 'created', sessionId)
    phase = 'created'
  }
  requireCurrent()
  if (args.task === undefined) return { sessionId, status: 'created' }
  if (phase === 'submitting') {
    if (!(await deps.submitted(sessionId, key)))
      throw new Error('ACP_SESSION_TASK_UNCONFIRMED: Open session ' + sessionId + ' and check its first message.')
    requireCurrent()
    deps.requests.advance(source, key, 'submitting', 'queued', sessionId)
  } else if (phase === 'created') {
    deps.requests.advance(source, key, 'created', 'submitting', sessionId)
    await deps.submit(sessionId, args, source, key, identity)
    deps.requests.advance(source, key, 'submitting', 'queued', sessionId)
  }
  return { sessionId, status: 'task-queued' }
}

export function installCreateAgentSession(
  ctx: Context,
  requests: IndependentSessionRequests,
  profileIds: () => string[],
  targetProfile: ToolDeps['targetProfile'],
): () => Promise<void> {
  const pending = new Set<Promise<unknown>>()
  let closing = false
  ctx.inject(
    [
      'agents',
      'tools',
      'sessions',
      'llm',
      'sessionQuery',
      'sessionController',
      'sessionPersistence',
      'workspaceRegistry',
    ],
    (scope) => {
      const authority = new CreateSessionAuthority()
      scope.on('agent/inbox/claimed', ({ agent, message, turn }) => authority.claimed(agent.session, turn, message), {
        global: true,
      })
      scope.on(
        'session/event',
        (session, event) => {
          if (event.type === 'turn/end' || event.type === 'turn/start') authority.end(session)
          if (event.type === 'user/message') authority.committed(session, event.data)
        },
        { global: true },
      )
      const liveRoot = (agent: Agent) =>
        scope.agents.get(agent.id) === agent &&
        scope.sessions.get(agent.id) === agent.session &&
        agent.status === 'running'
      scope.on(
        'agent/pre-step',
        async ({ modelSelection }, next) => {
          const decision = await next()
          if (decision.kind !== 'enter') return decision
          for (const { source } of decision.messages) {
            if (
              source.kind === taskSource &&
              (closing ||
                modelSelection.provider !== acpRouteId(source.agent) ||
                modelSelection.model !== source.model ||
                targetProfile(source.agent) !== source.profileIdentity)
            )
              throw new Error(
                'ACP_SESSION_TARGET_CHANGED: The intended Agent or model changed before the task was admitted.',
              )
          }
          return decision
        },
        { prepend: true, global: true },
      )
      const deps: ToolDeps = {
        requests,
        profileIds,
        targetProfile,
        models: (provider) => scope.llm.listModels(provider),
        create: (source, target, id, check, existingOnly) =>
          createHandoffDestination(scope, source, target, id, check, existingOnly),
        submit: async (id, args, sourceSessionId, requestKey, profileIdentity) => {
          const target = scope.agents.get(SessionId(id))
          const selected = target?.model.current()
          if (
            !target ||
            target.status !== 'idle' ||
            selected?.provider !== acpRouteId(args.agent) ||
            selected.model !== acpDeclaredModelRoute(args.model) ||
            target.session.requestHeader() !== undefined ||
            target.inbox.nextTurn.length ||
            target.inbox.nextStep.length ||
            args.task === undefined
          )
            throw new Error('ACP_SESSION_TARGET_CHANGED: Review the new session before sending the task.')
          target.followup(
            createUserMessage({
              content: [{ type: 'text', text: args.task }],
              source: {
                kind: taskSource,
                sourceSessionId,
                requestKey,
                agent: args.agent,
                model: selected.model,
                profileIdentity,
              },
            }),
          )
          if (!(await scope.sessions.flush(target.session)))
            throw new Error('ACP_SESSION_TASK_UNCONFIRMED: Check the first message in the new session.')
        },
        submitted: async (id, key) => {
          const result = await scope.sessionQuery.readSession(SessionId(id))
          return result.events.some(
            (event) =>
              event.type === 'agent/inbox/spliced' &&
              event.data.inserted.some(
                (message) => message.source.kind === taskSource && message.source.requestKey === key,
              ),
          )
        },
      }
      const tool = defineTool({
        name: 'create_agent_session',
        description:
          'During a foreground request from the workspace owner, create an independent chat using an installed ACP Agent and model. Omit task for a blank chat. An optional standalone task starts its first turn. An identical call in the same user request reuses its chat. No history is transferred.',
        parameters: {
          agent: { type: 'string', required: true, description: 'Installed ACP Agent profile ID.' },
          model: { type: 'string', required: true, description: 'Exact model ID advertised by that Agent.' },
          task: { type: 'string', description: 'Optional first task for the target. No chat history is shared.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string', required: true },
              status: { type: 'string', enum: ['created', 'task-queued'], required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const source = exec.agent
          const owner = source && authority.owner(source.session)
          if (!source || !owner)
            throw new Error(
              'ACP_SESSION_OWNER_REQUIRED: Ask the workspace owner to create a session from their desktop.',
            )
          const work = createIndependentSession(deps, source.id, owner, args, () => {
            exec.signal.throwIfAborted()
            scope.fiber.assertActive()
            if (closing || !liveRoot(source) || authority.owner(source.session) !== owner)
              throw new Error('ACP_SESSION_OWNER_REQUIRED: The owning conversation is no longer active.')
          })
          pending.add(work)
          try {
            return await work
          } finally {
            pending.delete(work)
          }
        },
      })
      scope.tools.register(tool, {
        // A change to the advertised MCP catalog can force an ACP reconnect, including while the
        // external Agent is completing background work. Check turn-specific authority in execute.
        when: ({ agent }) => !closing && mainSession(agent.session) && profileIds().length > 0,
      })
    },
  )
  return async () => {
    closing = true
    await Promise.allSettled([...pending])
  }
}
