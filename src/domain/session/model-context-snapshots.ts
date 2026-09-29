/**
 * Read the current DSH model-facing context snapshots from an effective session
 * message projection. This is deliberately a tiny source allow-list: ACP must
 * not replay arbitrary user-role history just because it happens to be durable.
 */
export interface ModelContextMessageLike {
  readonly id?: unknown
  readonly role?: unknown
  readonly source?: unknown
  readonly content?: unknown
}

export interface ModelContextSnapshot {
  readonly source: 'runtime-context' | 'skill-catalog'
  readonly id?: string
  readonly text: string
}

const snapshotSources = ['runtime-context', 'skill-catalog'] as const

/**
 * Return the newest valid runtime-context and skill-catalog messages, in source
 * order. A malformed newest snapshot suppresses that source instead of falling
 * back to stale content. Empty clear snapshots remain present when they contain
 * the source's explicit clearing text.
 */
export function currentModelContextSnapshots(
  messages: readonly ModelContextMessageLike[],
  skillEntryPointAvailable = true,
): readonly ModelContextSnapshot[] {
  const latest = new Map<(typeof snapshotSources)[number], ModelContextMessageLike>()
  for (const message of messages) {
    const source = message.source
    if (typeof source !== 'object' || source === null) continue
    const kind = (source as { kind?: unknown }).kind
    if (snapshotSources.includes(kind as (typeof snapshotSources)[number]))
      latest.set(kind as (typeof snapshotSources)[number], message)
  }

  const result: ModelContextSnapshot[] = []
  for (const kind of snapshotSources) {
    if (kind === 'skill-catalog' && !skillEntryPointAvailable) continue
    const message = latest.get(kind)
    if (message === undefined || message.role !== 'user') continue
    const source = message.source as { readonly form?: unknown; readonly entries?: unknown }
    if (kind === 'skill-catalog') {
      if (source.form !== 'catalog' || !Array.isArray(source.entries)) continue
      if (
        source.entries.some((entry) => {
          if (typeof entry !== 'object' || entry === null) return true
          const value = entry as { readonly name?: unknown; readonly description?: unknown }
          return typeof value.name !== 'string' || value.name.length === 0 || typeof value.description !== 'string'
        })
      )
        continue
    }
    if (!Array.isArray(message.content) || message.content.length === 0) continue
    const blocks = message.content as readonly unknown[]
    if (
      blocks.some(
        (block) => typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'text',
      )
    )
      continue
    const text = blocks.map((block) => (block as { text?: unknown }).text)
    if (text.every((value): value is string => typeof value === 'string')) {
      result.push({
        source: kind,
        ...(typeof message.id === 'string' ? { id: message.id } : {}),
        text: text.join('\n'),
      })
    }
  }
  return result
}
