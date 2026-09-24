import type { TeamMemberProjection, TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type TeamRoster =
  | { readonly kind: 'loading'; readonly members: readonly [] }
  | { readonly kind: 'unavailable'; readonly members: readonly [] }
  | { readonly kind: 'failed'; readonly message: string; readonly members: readonly []; readonly memberIds: readonly SessionId[] }
  | { readonly kind: 'empty'; readonly members: readonly [] }
  | { readonly kind: 'ready'; readonly members: readonly TeamMemberProjection[] }

/** Interpret the shared projection without treating a failed residual roster as current. */
export function teamRoster(projection: TeamProjection | undefined, loading: boolean): TeamRoster {
  if (projection === undefined) return loading ? { kind: 'loading', members: [] } : { kind: 'unavailable', members: [] }
  if (projection.failure !== undefined) return {
    kind: 'failed', message: projection.failure, members: [],
    // Scope a failure notice to known teammates without treating their stale
    // identities as a complete authorization roster.
    memberIds: projection.members.filter(member => member.role === 'teammate').map(member => member.id),
  }
  const members = projection.members.filter(member => member.role === 'teammate')
  return members.length === 0 ? { kind: 'empty', members: [] } : { kind: 'ready', members }
}

export function projectionRevision(projection: TeamProjection | undefined): string {
  if (projection === undefined) return ''
  return JSON.stringify([projection.failure, projection.members.map(member => [member.id, member.name, member.role, member.phase, member.error])])
}
