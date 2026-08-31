/** Bounded detached copies of ACP session configuration options. */
import type * as acp from '@agentclientprotocol/sdk'

const MAX_ID = 512
const MAX_LABEL = 1_024
const boundedLabel = (value: string): string => value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL)}…` : value

/**
 * Keep only the protocol's known option shapes and cap both dimensions.
 * Agent-owned labels and values remain exact protocol data; oversized
 * selectable identifiers are discarded rather than rewritten.
 */
export function acpConfigOptionsSnapshot(options: readonly acp.SessionConfigOption[] | null | undefined): acp.SessionConfigOption[] | undefined {
  if (options === undefined || options === null) return undefined
  const result: acp.SessionConfigOption[] = []
  for (const option of options.slice(0, 128)) {
    if (option.id.length > MAX_ID || option.name.length === 0 || (option.category !== undefined && option.category !== null && option.category.length > MAX_ID)) continue
    if (option.type === 'boolean') {
      result.push({
        id: option.id, name: boundedLabel(option.name), type: 'boolean', currentValue: option.currentValue,
        ...(option.description === undefined ? {} : { description: option.description === null ? null : boundedLabel(option.description) }),
        ...(option.category === undefined ? {} : { category: option.category === null ? null : option.category }),
      })
      continue
    }
    if (option.type !== 'select') continue
    if (option.currentValue.length > MAX_ID) continue
    const values = option.options.flatMap((entry) => 'options' in entry ? entry.options : [entry]).filter((value) => value.value.length <= MAX_ID).slice(0, 256)
    result.push({
      id: option.id, name: boundedLabel(option.name), type: 'select', currentValue: option.currentValue,
      options: values.map((value) => ({
        value: value.value, name: boundedLabel(value.name),
        ...(value.description === undefined ? {} : { description: value.description === null ? null : boundedLabel(value.description) }),
      })),
      ...(option.description === undefined ? {} : { description: option.description === null ? null : boundedLabel(option.description) }),
      ...(option.category === undefined ? {} : { category: option.category === null ? null : option.category }),
    })
  }
  return result
}
