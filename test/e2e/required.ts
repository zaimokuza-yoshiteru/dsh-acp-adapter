/** Fail at the missing fixture value, before a less useful property-access error. */
export function required<T>(value: T, label = 'Expected fixture value'): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(label)
  return value
}
