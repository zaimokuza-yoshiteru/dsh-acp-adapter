import type { AcpTeamMemberView } from '../data/acp-remote.ts'

/** Capture the visible team, then refresh membership before sending native
 * interrupts. The native endpoint authorizes each durable parent address.
 * Its receipt means accepted, not that execution has already stopped.
 */
export async function interruptTeam(input: {
  lead: string
  targets: readonly string[]
  isCurrent(): boolean
  members(): Promise<readonly AcpTeamMemberView[]>
  interrupt(id: string): Promise<void>
}): Promise<{ accepted: number; skipped: number; failed: number }> {
  const result = { accepted: 0, skipped: 0, failed: 0 }
  const targets = [...new Set(input.targets)].filter(id => id !== input.lead)
  if (!input.isCurrent()) return { ...result, skipped: targets.length }
  const members = await input.members()
  await Promise.all(targets.map(async id => {
    if (!input.isCurrent() || !members.some(member => member.sessionId === id && member.status === 'running')) {
      result.skipped++
      return
    }
    try { await input.interrupt(id); result.accepted++ }
    catch { result.failed++ }
  }))
  return result
}
