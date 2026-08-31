/** Shared, dependency-free classification of Agent-owned config options. */

/** Normalize ACP identifiers without changing the original value shown to users. */
export function normalizeAcpConfigOptionKey(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_')
}

/**
 * Model and reasoning controls remain owned by the stock DSH model picker.
 * ACP agents may spell their category/id with different casing or separators;
 * classification is normalized while the Agent-provided labels stay untouched.
 */
export function isAcpModelOrReasoningOption(option: {
  readonly id: string
  readonly category?: string | null
}): boolean {
  const id = normalizeAcpConfigOptionKey(option.id)
  const category = option.category === undefined || option.category === null
    ? ''
    : normalizeAcpConfigOptionKey(option.category)
  return category === 'model'
    || id === 'model'
    || category === 'thought_level'
    || category === 'reasoning_effort'
    || id === 'thought_level'
    || id === 'reasoning_effort'
}
