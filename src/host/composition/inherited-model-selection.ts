import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-projection'
import { acpDeclaredModelRoute, acpModelConfigOption, isAcpAgentManagedModel } from '../../contract/model-selection.ts'
import type { AcpProfileAdapter } from './profile-adapter.ts'

/** A member or dedicated preset can inherit the native picker's global default.
 * Select a concrete model before DSH prepares the first step, keeping its own controls usable. */
export function installInheritedModelSelection(
  ctx: Context,
  adapterFor: (provider: string) => AcpProfileAdapter | undefined,
): void {
  ctx.inject(['agents', 'agentPresets', 'sessionProjections'], async (child) => {
    const apply = async (agent: Agent, signal?: AbortSignal): Promise<void> => {
      const { provider, model } = agent.options
      if (!provider || !model || !isAcpAgentManagedModel(model)) return
      const adapter = adapterFor(provider)
      const inherited = () =>
        !signal?.aborted &&
        child.agents.get(agent.id) === agent &&
        agent.status === 'idle' &&
        (agent.session.header.origin === 'subagent' ||
          child.agentPresets.composedPreset(agent.ctx) === 'acp-adapter') &&
        agent.model.current()?.model === model &&
        agent.model.current()?.provider === provider &&
        child.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection?.next === null
      if (adapter === undefined || !inherited()) return
      // Discovery errors remain visible through the native catalog. Keep an empty chat usable.
      const rows = await adapter.listModels(provider).catch(() => [])
      const result = adapter.probeSnapshot(provider)?.result
      if (!rows.some((row) => isAcpAgentManagedModel(row.id)) || result?.kind !== 'ok') return
      const selected = acpModelConfigOption(result.configOptions)?.currentValue
      if (selected !== undefined && adapterFor(provider) === adapter && inherited())
        agent.model.select({ provider, model: acpDeclaredModelRoute(selected) })
    }
    child.on('agent/created', async ({ agent, signal }) => {
      await apply(agent, signal)
    })
    await Promise.all(child.agents.list().map((agent) => apply(agent)))
  })
}
