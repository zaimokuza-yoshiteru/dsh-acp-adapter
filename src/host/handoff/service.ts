import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcpHandoffCommand, AcpHandoffView } from '../../contract/handoff.ts'
import { sameTransferLocation } from '../../contract/handoff.ts'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import type { HandoffRecord } from '../../persistence/handoff.ts'
import {
  mainAgent,
  UnlistedHandoffModel,
  checkHandoffModel,
  changedSession,
  createHandoffDestination,
  handoffWorkspaces,
  observeHandoffSession,
  observedWorkingDirectory,
  handoffSessions,
  transferLocation,
} from './destination.ts'
import { deliveryPrompt, handoffReceipt, ownsHandoffMessage, summaryPrompt } from './messages.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpHandoffs: AcpHandoffs
  }
}

function view(record: HandoffRecord): AcpHandoffView {
  const { provider, model, reasoningEffort } = record.target
  return {
    id: record.id,
    revision: record.revision,
    sourceSessionId: record.sourceSessionId,
    phase: record.phase,
    destinationSessionId: record.destinationUnavailable ? null : record.destinationSessionId,
    target: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
    document: record.document,
    allowHistory: record.allowHistory,
    instruction: record.instruction,
  }
}

function emptyInbox(agent: Agent) {
  return !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length
}
function pending(agent: Agent, id: string, part: 'summary' | 'delivery') {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find((m) => ownsHandoffMessage(m, id, part))
}
function invalid() {
  return new RemoteError('gateway/bad-request', 'Invalid session handoff request.', {})
}
function staleDraft() {
  return new RemoteError('session/agent-busy', 'The handoff draft changed in another window.', {
    reason: 'HANDOFF_STALE_DRAFT',
  })
}

export class AcpHandoffs extends Service {
  private closed = false
  private readonly requests = new Map<string, Promise<unknown>>()
  constructor(
    ctx: Context,
    private readonly store: Pick<AcpSidecar, 'readHandoff' | 'writeHandoff'>,
    private readonly profileIdentity: (provider: string) => string | null,
  ) {
    super(ctx, 'acpHandoffs')
    // A picker in another window can change the route after the user clicks Send.
    // Recheck the selection that the host actually captured for the step.
    ctx.on(
      'agent/pre-step',
      async ({ agent, modelSelection }, next) => {
        const decision = await next()
        if (decision.kind !== 'enter' || !decision.messages.some((m) => m.source.kind === 'acp-handoff'))
          return decision
        const messages = decision.messages.filter((m) => {
          if (m.source.kind !== 'acp-handoff') return true
          const record = this.store.readHandoff(agent.id, m.source.operationId)
          if (!record || this.closed || !this.sameProfiles(record)) return false
          if (
            m.source.launchScope &&
            !sameTransferLocation(transferLocation(ctx, agent.session, 'execution'), m.source.launchScope)
          )
            return false
          return m.source.part === 'summary'
            ? record.phase === 'summarizing' &&
                record.sourceSessionId === agent.id &&
                record.sourceProvider === modelSelection.provider &&
                record.sourceModel === modelSelection.model
            : record.phase === 'queued' &&
                record.destinationSessionId === agent.id &&
                record.target.provider === modelSelection.provider &&
                record.target.model === modelSelection.model
        })
        return messages.length ? { ...decision, messages } : { kind: 'reject' }
      },
      { prepend: true },
    )
  }

  private sameProfiles(record: HandoffRecord) {
    return (
      this.profileIdentity(record.sourceProvider) === record.sourceIdentity &&
      this.profileIdentity(record.target.provider) === record.targetIdentity
    )
  }

  private sourceLocation(id: string, headerCwd: string | undefined) {
    const registry = handoffWorkspaces(this.ctx)
    if (!registry || registry.archivedSessionIds.includes(SessionId(id))) return undefined
    const workspace = registry.list().find((row) => row.sessionIds.includes(SessionId(id)))
    const session = handoffSessions(this.ctx).get(SessionId(id))
    const cwd = workspace?.path ?? (session && this.ctx.get('workingDirectory')?.get(session)) ?? headerCwd
    return cwd ? { workspaceId: workspace?.id ?? null, sourceCwd: cwd } : undefined
  }

  private sourceStillLocated(record: HandoffRecord, headerCwd: string | undefined) {
    const current = this.sourceLocation(record.sourceSessionId, headerCwd)
    return current?.workspaceId === record.workspaceId && current?.sourceCwd === record.sourceCwd
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.requests.values())
  }

  async action(
    sessionId: string,
    command: AcpHandoffCommand,
    authorize: (id: string) => void,
    principal?: Principal,
  ): Promise<AcpHandoffView | null> {
    authorize(sessionId)
    if (this.closed) throw changedSession()
    if (command.id !== undefined && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(command.id)) throw invalid()
    if (
      (command.kind === 'save' || command.kind === 'send') &&
      (command.document.length > 65536 || command.instruction.length > 32768)
    )
      throw invalid()
    const known = this.store.readHandoff(sessionId, command.id)
    if (!known && command.kind === 'status' && !command.id) return null
    const key = known?.sourceSessionId ?? sessionId
    const operation = (this.requests.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const allowed = (session: string) => {
          if (this.closed) throw changedSession()
          authorize(session)
        }
        allowed(sessionId)
        const current = this.store.readHandoff(sessionId, command.id)
        if (!current) {
          if (command.kind === 'status') return null
          if (command.kind !== 'begin') throw changedSession()
          return this.begin(sessionId, command, allowed, principal)
        }
        allowed(current.sourceSessionId)
        if (current.destinationSessionId) allowed(current.destinationSessionId)
        if (
          command.kind === 'begin' &&
          (current.sourceSessionId !== sessionId ||
            current.target.provider !== command.target.provider ||
            current.target.model !== command.target.model ||
            current.target.reasoningEffort !== command.target.reasoningEffort)
        )
          throw invalid()
        if (command.kind === 'cancel') {
          if (current.phase === 'draft' && command.revision !== current.revision) throw staleDraft()
          return this.cancel(current, allowed)
        }
        if (command.kind === 'save' || command.kind === 'send') {
          if (current.phase !== 'draft') return current
          if (current.revision !== command.revision) {
            if (
              command.kind === 'save' &&
              current.document === command.document &&
              current.allowHistory === command.allowHistory &&
              current.instruction === command.instruction
            )
              return current
            throw staleDraft()
          }
          const edited = {
            ...current,
            document: command.document,
            instruction: command.instruction,
            allowHistory: command.allowHistory,
          }
          return command.kind === 'save' ? this.store.writeHandoff(edited) : this.send(edited, allowed, principal)
        }
        return this.refresh(current, allowed, principal)
      })
    this.requests.set(key, operation)
    try {
      const record = await operation
      if (!record) return null
      authorize(record.sourceSessionId)
      // An edited draft can contain private input from the destination even after it disappears.
      if (record.destinationSessionId) authorize(record.destinationSessionId)
      return view(record)
    } finally {
      if (this.requests.get(key) === operation) this.requests.delete(key)
    }
  }

  private async begin(
    sessionId: string,
    command: Extract<AcpHandoffCommand, { kind: 'begin' }>,
    authorize: (id: string) => void,
    principal?: Principal,
  ) {
    let previous = this.store.readHandoff(sessionId)
    if (previous?.sourceSessionId === sessionId && previous.phase === 'draft') {
      if (previous.destinationSessionId) authorize(previous.destinationSessionId)
      previous = await this.refresh(previous, authorize, principal)
    }
    if (previous?.sourceSessionId === sessionId && ['summarizing', 'draft'].includes(previous.phase))
      throw changedSession()
    const targetIdentity = this.profileIdentity(command.target.provider)
    const agent = await mainAgent(this.ctx, sessionId)
    const initialProvider = agent.session.requestHeader()?.config.provider
    const sourceIdentity = initialProvider === undefined ? null : this.profileIdentity(initialProvider)
    if (agent.status !== 'idle') throw changedSession()
    const target = await checkHandoffModel(this.ctx, command.target)
    return agent.runMaintenance(async (signal) => {
      using observed = await observeHandoffSession(this.ctx, agent.id, signal)
      const source = agent.session.requestHeader()?.config
      const active = agent.model.current() ?? source
      const through = observed.events.findLast((e) => e.type === 'turn/end' && e.data.reason.kind === 'completed')?.seq
      if (
        !emptyInbox(agent) ||
        !source ||
        !active ||
        through === undefined ||
        active.provider !== source.provider ||
        active.model !== source.model ||
        source.provider === target.provider ||
        source.provider !== initialProvider ||
        (!sourceIdentity && !targetIdentity) ||
        this.profileIdentity(source.provider) !== sourceIdentity ||
        this.profileIdentity(target.provider) !== targetIdentity
      )
        throw changedSession()
      signal.throwIfAborted()
      authorize(sessionId)
      const location = this.sourceLocation(sessionId, agent.session.header.cwd)
      const launchScope = transferLocation(this.ctx, agent.session, 'execution')
      if (!location || !launchScope) throw changedSession()
      const record = this.store.writeHandoff({
        id: command.id,
        sourceSessionId: sessionId,
        sourceProvider: source.provider,
        sourceModel: source.model,
        sourceIdentity,
        targetIdentity,
        ...location,
        destinationSessionId: null,
        requestedDestinationId: 'session-' + randomUUID(),
        throughSeq: through,
        target: command.target,
        phase: 'summarizing',
        document: '',
        instruction: '',
        ...(command.automatic && { automatic: true as const }),
        locale: command.locale,
        allowHistory: true,
        revision: 0,
      })
      agent.followup(
        createUserMessage({
          source: {
            kind: 'acp-handoff',
            part: 'summary',
            operationId: record.id,
            ...(record.automatic && { automatic: true as const }),
            launchIdentity: record.sourceIdentity,
            launchScope,
            ...(principal && { principal }),
          },
          content: [{ type: 'text', text: summaryPrompt(record.locale) }],
        }),
      )
      await handoffSessions(this.ctx).flush(agent.session)
      return record
    })
  }

  private async refresh(record: HandoffRecord, authorize: (id: string) => void, principal?: Principal) {
    if (record.destinationSessionId && (record.phase === 'draft' || record.phase === 'queued')) {
      if (await this.destinationGone(record.destinationSessionId)) {
        authorize(record.sourceSessionId)
        authorize(record.destinationSessionId)
        return this.store.writeHandoff({
          ...record,
          phase: 'interrupted',
          destinationUnavailable: true,
          allowHistory: false,
        })
      }
    }
    if (record.phase !== 'summarizing' && record.phase !== 'queued') return record
    const source = record.phase === 'summarizing'
    const id = source ? record.sourceSessionId : record.destinationSessionId!
    const part = source ? 'summary' : 'delivery'
    const query = this.ctx.get('sessionQuery', false)
    if (!query) throw changedSession()
    using observed = await query.observeSession(SessionId(id), { projectionMode: 'none' })
    const receipt = handoffReceipt(observed.events.slice(source ? record.throughSeq + 1 : 0), record.id, part)
    authorize(record.sourceSessionId)
    if (!source) authorize(id)
    if (!receipt.ended) {
      const live = this.ctx.get('agents', false)?.get(SessionId(id))
      if (!live || (!pending(live, record.id, part) && live.status === 'idle'))
        return this.store.writeHandoff({ ...record, phase: 'interrupted' })
      return record
    }
    if (!receipt.ok || (source && (!receipt.text || receipt.text.length > 65536)))
      return this.store.writeHandoff({ ...record, phase: 'interrupted' })
    if (!source) return this.store.writeHandoff({ ...record, phase: 'completed' })
    const observedCwd = observedWorkingDirectory(observed.header, observed.events)
    if (!this.sameProfiles(record) || !this.sourceStillLocated(record, observedCwd))
      return this.store.writeHandoff({ ...record, phase: 'interrupted', document: receipt.text })
    if (record.creationAttempted && (await this.destinationGone(record.requestedDestinationId))) {
      authorize(record.sourceSessionId)
      return this.store.writeHandoff({ ...record, phase: 'interrupted', document: receipt.text })
    }
    // Source and destination prompts must run as the same caller. Other authorized
    // windows may inspect the transfer, but polling must never lend it another identity.
    if (record.automatic) {
      const summary = observed.events.find(
        (event) => event.type === 'user/message' && ownsHandoffMessage(event.data, record.id, 'summary'),
      )
      if (
        summary?.type !== 'user/message' ||
        summary.data.source.kind !== 'acp-handoff' ||
        !isDeepStrictEqual(principal, summary.data.source.principal)
      )
        return record
    }
    let destination: string
    try {
      destination = await createHandoffDestination(
        this.ctx,
        record.sourceSessionId,
        view(record).target,
        record.requestedDestinationId,
        (id) => {
          authorize(record.sourceSessionId)
          if (!this.sameProfiles(record) || !this.sourceStillLocated(record, observedCwd)) throw changedSession()
          if (id) authorize(id)
        },
        record.creationAttempted === true,
        () => {
          record = this.store.writeHandoff({ ...record, creationAttempted: true })
        },
      )
    } catch (error) {
      if (!(error instanceof UnlistedHandoffModel)) throw error
      authorize(record.sourceSessionId)
      return this.store.writeHandoff({ ...record, phase: 'interrupted', document: receipt.text })
    }
    authorize(destination)
    const ready = { ...record, destinationSessionId: destination, document: receipt.text }
    if (!this.sameProfiles(ready)) return this.store.writeHandoff({ ...ready, phase: 'interrupted' })
    if (!ready.automatic) return this.store.writeHandoff({ ...ready, phase: 'draft' })
    try {
      return await this.send(ready, authorize, principal)
    } catch (error) {
      // A lost flush acknowledgement may already have committed 'queued'.
      // Reconcile that receipt before ever considering another dispatch.
      const latest = this.store.readHandoff(record.sourceSessionId, record.id)
      if (latest?.phase === 'queued') return latest
      if (
        !(error instanceof RemoteError) ||
        (error.code !== 'session/model-unavailable' && error.code !== 'session/agent-busy')
      )
        throw error
      return this.store.writeHandoff({ ...ready, phase: 'interrupted' })
    }
  }

  private async destinationGone(id: string) {
    const target = SessionId(id)
    const registry = handoffWorkspaces(this.ctx)
    if (!registry) throw changedSession()
    if (registry.archivedSessionIds.includes(target)) return true
    const live = handoffSessions(this.ctx)
    if (live.get(target)) return false
    const storage = this.ctx.get('sessionPersistence', false)
    if (!storage) throw changedSession()
    const stored = await storage.stat(target)
    return registry.archivedSessionIds.includes(target) || (!stored && !live.get(target))
  }

  private async cancel(record: HandoffRecord, authorize: (id: string) => void) {
    if (record.phase !== 'summarizing' && record.phase !== 'draft') return record
    const agent = this.ctx.get('agents', false)?.get(SessionId(record.sourceSessionId))
    authorize(record.sourceSessionId)
    const cancelled = this.store.writeHandoff({
      ...record,
      phase: 'cancelled',
      document: '',
      instruction: '',
      allowHistory: false,
    })
    if (agent && record.phase === 'summarizing') {
      const queued = pending(agent, record.id, 'summary')
      if (queued) agent.inbox.remove(queued.id)
      else {
        using observed = await observeHandoffSession(this.ctx, agent.id)
        authorize(record.sourceSessionId)
        if (
          Number(agent.session.seq) === observed.events.length &&
          handoffReceipt(observed.events.slice(record.throughSeq + 1), record.id, 'summary').active
        )
          agent.cancel({ kind: 'hook', reason: 'acp-handoff-cancelled' }, { keepInbox: true })
      }
      await handoffSessions(this.ctx).flush(agent.session)
    }
    return cancelled
  }

  private async send(record: HandoffRecord, authorize: (id: string) => void, principal?: Principal) {
    const id = record.destinationSessionId
    if (!id || !record.document.trim()) throw invalid()
    const requireProfiles = () => {
      if (!this.sameProfiles(record))
        throw new RemoteError(
          'session/model-unavailable',
          'The Agent configuration changed. Select the destination again.',
          { provider: record.target.provider, model: record.target.model },
        )
    }
    requireProfiles()
    const agent = await mainAgent(this.ctx, id)
    const target = view(record).target
    if (agent.status !== 'idle') throw changedSession()
    return agent.runMaintenance(async (signal) => {
      await checkHandoffModel(this.ctx, target)
      using origin = await observeHandoffSession(this.ctx, SessionId(record.sourceSessionId), signal)
      using observed = await observeHandoffSession(this.ctx, agent.id, signal)
      const current = agent.model.current()
      requireProfiles()
      signal.throwIfAborted()
      authorize(record.sourceSessionId)
      authorize(id)
      const launchScope = { workspaceId: record.workspaceId, cwd: record.sourceCwd }
      if (
        !this.sourceStillLocated(record, observedWorkingDirectory(origin.header, origin.events)) ||
        !sameTransferLocation(transferLocation(this.ctx, agent.session, 'execution'), launchScope) ||
        !emptyInbox(agent) ||
        current?.provider !== target.provider ||
        current.model !== target.model ||
        current.reasoningEffort !== target.reasoningEffort ||
        observed.events.some((e) => e.type === 'turn/start')
      )
        throw changedSession()
      // This decision is committed before the real first input. A crash between the two leaves a
      // visible interrupted operation; an unknown delivery must never be billed a second time.
      const queued = this.store.writeHandoff({ ...record, phase: 'queued' })
      agent.followup(
        createUserMessage({
          source: {
            kind: 'acp-handoff',
            part: 'delivery',
            operationId: record.id,
            ...(record.automatic && { automatic: true as const }),
            launchIdentity: record.targetIdentity,
            launchScope,
            ...(principal && { principal }),
          },
          content: [{ type: 'text', text: deliveryPrompt(record) }],
        }),
      )
      await handoffSessions(this.ctx).flush(agent.session)
      return queued
    })
  }

  async historyFor(destinationId: string) {
    if (this.closed) return undefined
    const record = this.store.readHandoff(destinationId, undefined, true)
    if (
      !record?.allowHistory ||
      record.destinationSessionId !== destinationId ||
      !this.sameProfiles(record) ||
      (record.phase !== 'queued' && record.phase !== 'completed')
    )
      return undefined
    const agent = this.ctx.get('agents', false)?.get(SessionId(destinationId))
    if (!agent) return undefined
    if (record.phase === 'queued') {
      using observed = await observeHandoffSession(this.ctx, agent.id)
      if (!handoffReceipt(observed.events, record.id, 'delivery').accepted) return undefined
    }
    return {
      sourceSessionId: record.sourceSessionId,
      sourceCwd: record.sourceCwd,
      throughSeq: record.throughSeq,
      ...(record.workspaceId && { workspaceId: record.workspaceId }),
    }
  }
}
