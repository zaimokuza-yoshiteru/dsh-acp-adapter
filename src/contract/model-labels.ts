export const acpRouteNames = {
  en: { agentCurrentConfiguration: 'Agent current configuration', agentManagedModel: 'Agent-managed model' },
  zh: { agentCurrentConfiguration: 'Agent 当前配置', agentManagedModel: '由 Agent 管理模型' },
} as const

/** Apply display-only disambiguation after flattening ACP model options.
 * Identity (`id`) and the option value are never changed and names from
 * different profiles are intentionally not compared. */
export function disambiguateModelLabels<
  T extends {
    readonly id: string
    readonly name: string
    readonly description?: string | null | undefined
  },
>(models: readonly T[]): T[] {
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1)
  return models.map((model) => {
    if ((counts.get(model.name) ?? 0) < 2) return model
    if (model.id !== model.name) return { ...model, name: `${model.name} · ${model.id}` }
    const description = model.description?.split(/\r?\n/, 1)[0]?.trim()
    if (description !== undefined && description.length > 0) {
      const short = description.length > 80 ? `${description.slice(0, 77)}...` : description
      return { ...model, name: `${model.name} · ${short}` }
    }
    return model
  })
}
