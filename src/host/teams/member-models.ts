import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { AcpSidecar } from '../../persistence/sidecar.ts'
import { modeIntentBindingKey } from '../../persistence/sidecar.ts'
import type { AcpProfileAdapter } from '../composition/profile-adapter.ts'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'

export interface MemberModelDependencies {
  sidecar: AcpSidecar
  adapterFor(provider: string): AcpProfileAdapter | undefined
}

/** Binding-scoped preference survives native cold continuation's fixed constructor model. */
export function createMemberModels(ctx: Context, { sidecar, adapterFor }: MemberModelDependencies) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('ACP_TEAM_MODELS_UNAVAILABLE')
  const selectionFor = async (id: string, provider: string) => {
    const binding = await sidecar.readLatestBinding(id as never)
    const saved = await sidecar.readMemberModelSelection(id as never)
    return binding?.status === 'ok' && binding.binding.provider === provider
      && saved?.bindingKey === modeIntentBindingKey(binding.binding) ? saved : undefined
  }
  const installed = new WeakSet<Agent>()
  const install = (agent: Agent): void => {
    const membership = ctx.get('agentTeams')?.tryMembership(agent)
    const provider = agent.options.provider
    if (membership?.role !== 'teammate' || provider === undefined || adapterFor(provider) === undefined || installed.has(agent)) return
    installed.add(agent)
    ctx.effect(() => agent.ctx.effect(() => {
      const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
      // Load before the native helper captures its step selection, including
      // after a rebind. Never retarget a step already assembling or running.
      const hydrate = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const saved = await selectionFor(agent.id, provider)
        ref.current = saved === undefined ? undefined : await llm.resolveCallConfig({ provider, model: saved.model })
        return await next()
      }, { prepend: true })
      const disposeSelection = installModelSelection(agent.ctx, ref)
      return () => { hydrate(); disposeSelection() }
    }))
  }
  ctx.on('agent/created', ({ agent }) => { install(agent); return undefined })
  for (const agent of ctx.get('agents', false)?.list() ?? []) install(agent)

  return {
    async facts(id: string, provider: string) {
      const child = ctx.get('agents', false)?.get(id as never)
      const session = child?.session ?? ctx.get('sessions')?.get(id as never)
      const adapter = adapterFor(provider)
      const snapshot = await adapter?.agentSessionSnapshot(id).catch(() => undefined)
      const reported = snapshot?.configOptions?.find(option => normalizeAcpConfigOptionKey(option.id) === 'model' || normalizeAcpConfigOptionKey(option.category ?? '') === 'model')
      const currentModel = session?.requestHeader()?.config.model ?? (reported?.type === 'select' ? reported.currentValue : null)
      const selected = await selectionFor(id, provider)
      return { currentModel, pendingModel: selected !== undefined && selected.model !== currentModel ? selected.model : null,
        writable: snapshot?.modeWritable === true && child?.status !== 'running' }
    },
    async catalog(provider: string) {
      return (await llm.listModels(provider)).map(model => ({ id: model.id, name: model.name }))
    },
    async save(id: string, provider: string, model: string, authorize: () => void) {
      const binding = await sidecar.readLatestBinding(id as never)
      if (binding?.status !== 'ok' || binding.binding.provider !== provider) throw new Error('ACP_BINDING_UNAVAILABLE')
      // Catalog and binding reads may yield while a mailbox wakes the member.
      // Recheck at the synchronous SQLite write boundary, not just on entry.
      authorize()
      await sidecar.writeMemberModelSelection(id as never, { bindingKey: modeIntentBindingKey(binding.binding), model })
      // The host projection can advertise next-request intent for a live
      // member. Dormant members receive the same selection through hydration.
      const child = ctx.get('agents', false)?.get(id as never)
      if (child !== undefined && child.status !== 'running') child.session.append('model/selection', { provider, model })
    },
  }
}
