export type DevinLiveWaitResult = 'timedOut' | 'noProgress' | 'observedChange' | 'unknown'

/** Project only the published DSH Agent Teams wait_agent result shape. */
export function classifyDevinWaitResult(value: unknown): DevinLiveWaitResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown'
  const result = value as { readonly timedOut?: unknown; readonly noProgress?: unknown }
  if (result.timedOut === true) return 'timedOut'
  if (typeof result.noProgress === 'object' && result.noProgress !== null && !Array.isArray(result.noProgress)) {
    const noProgress = result.noProgress as { readonly reason?: unknown }
    if (noProgress.reason === 'no-active-peer') return 'noProgress'
  }
  if (result.timedOut === false && result.noProgress === undefined) return 'observedChange'
  return 'unknown'
}
