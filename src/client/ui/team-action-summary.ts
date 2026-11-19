import type { AgentControlTranslate } from './agent-session-controls.ts'

/** Report an accepted interrupt separately from a mode that was saved. */
export function teamActionSummary(
  t: AgentControlTranslate,
  result: ({ applied: number } | { accepted: number }) & { skipped: number; failed: number },
): string {
  const parts: string[] = []
  if ('applied' in result && result.applied > 0)
    parts.push(t(result.applied === 1 ? 'teamModeSavedOne' : 'teamModeSavedMany', { count: result.applied }))
  if ('accepted' in result && result.accepted > 0)
    parts.push(t(result.accepted === 1 ? 'teamInterruptSentOne' : 'teamInterruptSentMany', { count: result.accepted }))
  if (result.skipped > 0) parts.push(t('teamActionSkipped', { count: result.skipped }))
  if (result.failed > 0) parts.push(t('teamActionFailed', { count: result.failed }))
  return parts.length ? parts.join(' ') : t('teamActionEmpty')
}
