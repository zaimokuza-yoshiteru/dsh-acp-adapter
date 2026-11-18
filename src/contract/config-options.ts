/** Shared, dependency-free classification of Agent-owned config options. */

/** Maximum length for opaque ACP option and mode identifiers. */
export const ACP_CONFIG_IDENTIFIER_MAX = 512 as const

/** Normalize ACP identifiers without changing the original value shown to users. */
export function normalizeAcpConfigOptionKey(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

/**
 * Model and reasoning controls remain owned by the stock DSH model picker.
 * An absent or unknown category does not make an opaque id a model selector.
 * Reasoning retains the existing recognized-id compatibility when no category is supplied.
 */
export function isAcpModelOrReasoningOption(option: {
  readonly id: string
  readonly category?: string | null
  readonly type?: string
}): boolean {
  if (option.type !== undefined && option.type !== 'select') return false
  const id = normalizeAcpConfigOptionKey(option.id)
  const category =
    option.category === undefined || option.category === null ? '' : normalizeAcpConfigOptionKey(option.category)
  return (
    category === 'model' ||
    category === 'thought_level' ||
    category === 'reasoning_effort' ||
    (category === '' && (id === 'thought_level' || id === 'reasoning_effort'))
  )
}
