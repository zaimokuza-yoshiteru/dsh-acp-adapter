import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AcpMemberModelSelection, AcpSidecar } from '../../persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../persistence/sidecar.ts'
import type { AcpProfileAdapter } from '../composition/profile-adapter.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import { ACP_CURRENT_CONFIG_MODEL_ID, acpDeclaredModelRoute } from '../../contract/model-selection.ts'
import { readMemberRequestModel } from './member-model-facts.ts'
import { installTeamMemberModelFacts } from './member-model-tools.ts'
import { requiresAcpModelSwitchExit } from '../../contract/model-transition.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

export interface MemberModelDependencies {
  sidecar: AcpSidecar
  adapterFor(provider: string): AcpProfileAdapter | undefined
}

/** Keep only unapplied dormant intent outside the native model-selection owner. */
export function createMemberModels(ctx: Context, { sidecar, adapterFor }: MemberModelDependencies) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
  const selectionFor = async (id: string, provider: string, current: () => boolean = () => true) => {
    const binding = await sidecar.readLatestBinding(id as never)
    if (!current()) return undefined
    const saved = await sidecar.readMemberModelSelection(id as never)
    return binding?.status === 'ok' &&
      binding.binding.provider === provider &&
      saved?.bindingKey === modeIntentBindingKey(binding.binding)
      ? saved
      : undefined
  }
  let active = true
  ctx.effect(() => () => {
    active = false
  })
  const nativeKey = (choice: ModelSelection | null | undefined) =>
    choice === undefined
      ? undefined
      : choice === null
        ? 'null'
        : JSON.stringify([choice.provider, choice.model, choice.reasoningEffort ?? null])
  const sessions = ctx.get('sessions')
  const liveCut = (id: string) => {
    const agent = ctx.get('agents', false)?.get(id as never)
    const session = agent?.session ?? sessions?.get(id as never)
    if (session === undefined) return undefined
    const projection = ctx.get('sessionProjections')?.snapshot(session, ['modelSelection']).values.modelSelection
    return {
      session,
      sessionSeq: session.seq,
      lastUsed: session.requestHeader()?.config,
      next: agent?.model.current() ?? projection?.next ?? null,
      recorded: projection?.next,
      nativeSelectionKey: nativeKey(projection?.next),
    }
  }
  const currentCut = async (id: string) => {
    const live = liveCut(id)
    if (live !== undefined) return live
    const query = ctx.get('sessionQuery', false)
    if (query === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
    using observation = await query.observeSession(id as never)
    const next = observation.projections?.values.modelSelection?.next
    return {
      session: undefined,
      sessionSeq: Number(observation.cursor) + 1,
      lastUsed: observation.projections?.values.modelSelection?.lastUsed,
      next: next ?? null,
      recorded: next,
      nativeSelectionKey: nativeKey(next),
    }
  }
  const canApply = async (id: string, saved: AcpMemberModelSelection, cut: Awaited<ReturnType<typeof currentCut>>) => {
    if (saved.sessionSeq === undefined) return cut.recorded === null
    if (saved.nativeSelectionKey === undefined || saved.nativeSelectionKey !== cut.nativeSelectionKey) return false
    if (saved.sessionSeq === cut.sessionSeq) return true
    if (saved.sessionSeq > cut.sessionSeq) return false
    const query = ctx.get('sessionQuery', false)
    if (query === undefined) return false
    // Failed cold activation can persist end-seed markers before our listener.
    // Inspect this exceptional suffix through one immutable public observation;
    // any model change, ABA sequence, request or other activity invalidates it.
    using observation = await query.observeSession(id as never)
    if (
      Number(observation.cursor) + 1 !== cut.sessionSeq ||
      nativeKey(observation.projections?.values.modelSelection?.next) !== saved.nativeSelectionKey
    )
      return false
    return observation.events
      .slice(saved.sessionSeq)
      .every((event) => event.type === 'session/end-seed' && event.data.inherited !== true)
  }
  const consume = async (agent: Agent, saved: AcpMemberModelSelection) => {
    // The native append must be durable before the SQLite fallback disappears.
    if (
      sessions === undefined ||
      sessions.get(agent.id) !== agent.session ||
      !(await sessions.flush(agent.session)) ||
      !active
    )
      return
    await sidecar.clearMemberModelSelection(agent.id, saved)
  }
  // Agent creation is awaited before queued input can prepare its first step.
  // Native model ownership restores already-live members on late mount; never
  // retarget an assembling step from system-prompt/assemble or agent/request.
  ctx.on('agent/created', async ({ agent, signal }) => {
    const provider = agent.model.current()?.provider
    const membership = ctx.get('agentTeams')?.tryMembership(agent)
    if (membership?.role !== 'teammate' || provider === undefined || adapterFor(provider) === undefined) return
    const selected = agent.model.current()
    const selectedSeq = agent.session.seq
    const owns = () => active && !signal?.aborted && ctx.get('agents', false)?.get(agent.id) === agent
    const saved = await selectionFor(agent.id, provider, owns)
    if (!owns() || saved === undefined) return
    const cut = await currentCut(agent.id)
    if (!owns() || agent.session.seq !== selectedSeq) return
    const applicable = await canApply(agent.id, saved, cut)
    if (!owns() || agent.session.seq !== selectedSeq || !applicable) return
    if (
      requiresAcpModelSwitchExit(
        cut.lastUsed,
        { provider, model: saved.model },
        (route) => adapterFor(route) !== undefined,
      )
    )
      return
    const current = agent.model.current()
    if (
      current?.provider !== selected?.provider ||
      current?.model !== selected?.model ||
      current?.reasoningEffort !== selected?.reasoningEffort
    )
      return
    agent.model.select({ provider, model: saved.model })
    await consume(agent, saved)
  })

  const facts = async (id: string, provider: string) => {
    const child = ctx.get('agents', false)?.get(id as never)
    const adapter = adapterFor(provider)
    const snapshot = await adapter?.agentSessionSnapshot(id).catch(() => undefined)
    const reported = snapshot?.configOptions?.find(
      (option) => option.type === 'select' && normalizeAcpConfigOptionKey(option.category ?? '') === 'model',
    )
    // Session snapshots expose Agent values, whereas member selectors consume
    // Host routes. Opaque option ids do not declare a model selector.
    const reportedModel =
      snapshot === undefined
        ? null
        : reported?.type === 'select'
          ? acpDeclaredModelRoute(reported.currentValue)
          : ACP_CURRENT_CONFIG_MODEL_ID
    const currentModel = (await readMemberRequestModel(ctx, id, provider).catch(() => undefined)) ?? reportedModel
    const selected = await selectionFor(id, provider)
    const cut = await currentCut(id)
    const next =
      selected !== undefined && (await canApply(id, selected, cut))
        ? selected.model
        : cut.next?.provider === provider
          ? cut.next.model
          : null
    return {
      currentModel,
      pendingModel: next !== currentModel ? next : null,
      writable: snapshot?.modeWritable === true && child?.status !== 'running',
      ...(cut.lastUsed?.provider === provider ? { unavailableReason: 'model-switch' as const } : {}),
    }
  }
  installTeamMemberModelFacts(ctx, async (id, signal) => {
    const binding = await sidecar.readLatestBinding(id as never)
    if (binding?.status !== 'ok') return undefined
    const adapter = adapterFor(binding.binding.provider)
    if (adapter === undefined) return undefined
    const model = await readMemberRequestModel(ctx, id, binding.binding.provider, signal)
    const current = await sidecar.readLatestBinding(id as never)
    if (
      current?.status !== 'ok' ||
      modeIntentBindingKey(current.binding) !== modeIntentBindingKey(binding.binding) ||
      adapterFor(binding.binding.provider) !== adapter
    )
      return undefined
    return model === undefined ? undefined : { currentModel: model }
  })

  return {
    facts,
    async catalog(provider: string) {
      return (await llm.listModels(provider)).map((model) => ({ id: model.id, name: model.name }))
    },
    async save(id: string, provider: string, model: string, authorize: () => void) {
      const binding = await sidecar.readLatestBinding(id as never)
      if (binding?.status !== 'ok' || binding.binding.provider !== provider) throw new Error('ACP_BINDING_UNAVAILABLE')
      // Catalog and binding reads may yield while a mailbox wakes the member.
      // Recheck at the synchronous SQLite write boundary, not just on entry.
      const observed = await currentCut(id)
      authorize()
      // Even a live cut yielded at the await above. A first request can finish
      // and return the member to idle in that gap. Re-read the native owner
      // synchronously: the following sidecar call writes SQLite before yielding.
      const live = liveCut(id)
      const cut = live ?? observed
      if (requiresAcpModelSwitchExit(cut.lastUsed, { provider, model }, (route) => adapterFor(route) !== undefined))
        throw new LlmError(
          'This ACP member cannot change models after its first request. Keep its current model or create an independent session.',
          'ACP_MODEL_SWITCH_UNAVAILABLE',
        )
      if (
        (observed.session !== undefined && observed.session !== live?.session) ||
        cut.sessionSeq !== observed.sessionSeq ||
        cut.nativeSelectionKey !== observed.nativeSelectionKey
      )
        throw new Error('ACP_TEAM_MODEL_SELECTION_CHANGED')
      if (cut.nativeSelectionKey === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
      const saved = {
        bindingKey: modeIntentBindingKey(binding.binding),
        model,
        sessionSeq: cut.sessionSeq,
        nativeSelectionKey: cut.nativeSelectionKey,
      }
      await sidecar.writeMemberModelSelection(id as never, saved)
      // The host projection can advertise next-request intent for a live
      // member. Dormant members receive the same selection through hydration.
      const child = ctx.get('agents', false)?.get(id as never)
      if (child !== undefined) {
        if (child.session.seq !== saved.sessionSeq) throw new Error('ACP_TEAM_MODEL_SELECTION_CHANGED')
        child.model.select({ provider, model })
        await consume(child, saved)
      }
    },
  }
}
