import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { acpDeclaredModelRoute, acpModelConfigOption, isAcpAgentManagedModel } from '../../contract/model-selection.ts'
import type { AcpProfileAdapter } from './profile-adapter.ts'

/** Keep the native picker usable for defaults and conversations saved before it listed only named models. */
export function installInheritedModelSelection(
  ctx: Context,
  adapterFor: (provider: string) => AcpProfileAdapter | undefined,
): void {
  ctx.inject(['agents', 'sessionProjections'], async (child) => {
    const apply = async (agent: Agent, signal?: AbortSignal): Promise<void> => {
      const source = agent.model.current()
      if (!source || !isAcpAgentManagedModel(source.model)) return
      const { provider } = source
      const adapter = adapterFor(provider)
      const header = agent.session.requestHeader()?.config
      const existing = header?.provider === provider && isAcpAgentManagedModel(header.model)
      // An explicit pending choice on a blank chat belongs to its writer.
      const selection = () => child.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection
      if (!adapter || (!existing && (header !== undefined || selection()?.next !== null))) return
      const initialSeq = agent.session.seq
      const current = () =>
        !signal?.aborted &&
        child.agents.get(agent.id) === agent &&
        agent.status === 'idle' &&
        adapterFor(provider) === adapter &&
        agent.model.current()?.provider === provider &&
        agent.model.current()?.model === source.model &&
        agent.session.seq === initialSeq
      if (!current()) return
      const previous = existing
        ? await adapter.confirmedLegacyModel(agent.id, provider).catch(() => undefined)
        : undefined
      if ((existing && previous === undefined) || !current()) return
      const rows = await adapter.listModels(provider).catch(() => [])
      const result = adapter.probeSnapshot(provider)?.result
      if (result?.kind !== 'ok') return
      const advertised = acpModelConfigOption(result.configOptions)?.currentValue
      const target = existing ? previous : advertised === undefined ? undefined : acpDeclaredModelRoute(advertised)
      if (target && rows.some((row) => row.id === target) && current()) agent.model.select({ provider, model: target })
    }
    child.on('agent/created', async ({ agent, signal }) => {
      await apply(agent, signal)
    })
    await Promise.all(child.agents.list().map((agent) => apply(agent)))
  })
}
