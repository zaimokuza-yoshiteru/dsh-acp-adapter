/** Known complete file sides, shared by live normalization and legacy UI reads. */
export interface ActivityDiff { path: string; oldText: string | null; newText: string }

export function activityDiffsOf(value: unknown): ActivityDiff[] {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  const candidates = record(value) && Array.isArray(value.content) ? value.content : [value]
  const diffs: ActivityDiff[] = []
  for (const item of candidates) {
    if (record(item) && item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
      diffs.push({ path: item.path, oldText: typeof item.oldText === 'string' ? item.oldText : null, newText: item.newText })
    }
  }
  if (diffs.length === 0 && record(value) && value.toolKind === 'edit' && record(value.rawInput)) {
    const input = value.rawInput
    const path = typeof input.path === 'string' ? input.path : input.file_path
    if (typeof path === 'string' && path.trim() && typeof input.content === 'string') diffs.push({ path, oldText: null, newText: input.content })
  }
  return diffs
}
