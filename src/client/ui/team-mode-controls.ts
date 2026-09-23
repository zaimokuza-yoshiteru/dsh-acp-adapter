import type { AcpAgentSessionSnapshotView, AcpAgentSessionOptionWrite, AcpTeamMemberView } from '../data/acp-remote.ts'
import { agentControlMenuGroups, type AgentControlGroup, type AgentControlTranslate } from './agent-session-controls.ts'
import { teamModeChoices } from '../../contract/session-modes.ts'
export { teamModeChoices } from '../../contract/session-modes.ts'

/** Same normalized menu as the composer, narrowed to canonical member modes.
 * Dormant modes can be writable even when the reported snapshot is stale.
 * That permission is supplied by the owning team, never inferred by the view.
 */
export function teamSessionMenuGroups(snapshot: AcpAgentSessionSnapshotView, t: AgentControlTranslate, writable: boolean): AgentControlGroup[] {
  const modes = teamModeChoices(snapshot)
  return agentControlMenuGroups(snapshot, t).filter(group => group.kind === 'mode').map(group => ({
    ...group,
    choices: group.choices.filter(choice => modes.some(mode => mode.write.kind === choice.write.kind && mode.write.id === choice.write.id))
      .map(choice => ({ ...choice, disabled: !writable })),
  })).filter(group => group.choices.length > 0)
}

export type TeamModeReason = 'Applied' | 'Inactive' | 'Missing' | 'Stale' | 'Unsupported' | 'Selected' | 'Changed' | 'Failed'
export interface TeamModeResult { readonly sessionId: string; readonly reason: TeamModeReason }

/** A click captures its targets; later members and other profiles never join the batch. */
export async function applyTeamMode(input: {
  targets: readonly string[]; profileId: string; mode: string
  isCurrent(): boolean
  members(): Promise<readonly AcpTeamMemberView[]>
  snapshot(id: string): Promise<AcpAgentSessionSnapshotView>
  write(id: string, value: AcpAgentSessionOptionWrite): Promise<unknown>
}): Promise<{ applied: number; skipped: number; failed: number; members: TeamModeResult[] }> {
  const result = { applied: 0, skipped: 0, failed: 0, members: [] as TeamModeResult[] }
  const skip = (sessionId: string, reason: TeamModeReason): void => { result.skipped++; result.members.push({ sessionId, reason }) }
  for (const id of new Set(input.targets)) {
    try {
      if (!input.isCurrent()) { skip(id, 'Changed'); continue }
      const member = (await input.members()).find(member => member.sessionId === id && member.profileId === input.profileId)
      if (member === undefined) { skip(id, 'Missing'); continue }
      if (member.status !== 'inactive') { skip(id, 'Inactive'); continue }
      const snapshot = await input.snapshot(id)
      const choice = teamModeChoices(snapshot).find(choice => choice.id === input.mode)
      const writable = (snapshot.editable && snapshot.freshness === 'live') || snapshot.modeWritable === true
      const selected = snapshot.pendingModeId ?? (choice?.current ? choice.id : null)
      if (!input.isCurrent()) { skip(id, 'Changed'); continue }
      if (snapshot.profileId !== input.profileId) { skip(id, 'Missing'); continue }
      if (!writable) { skip(id, 'Stale'); continue }
      if (choice === undefined) { skip(id, 'Unsupported'); continue }
      if (selected === input.mode) { skip(id, 'Selected'); continue }
      await input.write(id, choice.write)
      result.applied++
      result.members.push({ sessionId: id, reason: 'Applied' })
    } catch { result.failed++; result.members.push({ sessionId: id, reason: 'Failed' }) }
  }
  return result
}
