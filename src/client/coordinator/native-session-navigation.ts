/** Navigation through DSH's Session ownership and native resource presentation. */
import { SessionCreateError, type ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { CrossBackendLocation } from '../data/cross-backend-controller.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'

export function isMainSession(sessions: ISessions, sessionId: SessionId): boolean {
  return (sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) > 0
}

export type IndependentSessionOutcome = 'idle' | 'create-failed' | 'open-failed' | 'ungrouped' | 'ungrouped-open-failed'

/** Keep the Host-published identity across a failed attachment, navigation or interrupted view. */
export function independentSessionNavigation(
  sessions: Pick<ISessions, 'create'>,
  locate: (source: SessionId) => CrossBackendLocation | undefined,
  open: (child: SessionId) => void,
  reconcile: (child: SessionId, location: CrossBackendLocation) => Promise<'missing' | 'created' | 'ungrouped'>,
) {
  interface Destination {
    child: SessionId
    location: CrossBackendLocation
    phase: 'uncertain' | 'created' | 'ungrouped'
  }
  const pending = new Map<SessionId, Destination>()
  const busy = new Set<SessionId>()
  return async (
    source: SessionId,
    current: () => boolean,
    openUngrouped: boolean,
  ): Promise<IndependentSessionOutcome> => {
    if (!current() || busy.has(source)) return 'idle'
    busy.add(source)
    try {
      let destination = pending.get(source)
      if (destination?.phase === 'uncertain') {
        // A missing response may still have published the requested identity.
        // Resolve against a fresh Host baseline before we send another create.
        const observed = await reconcile(destination.child, destination.location)
        if (!current()) return 'idle'
        if (observed !== 'missing') destination.phase = observed
      }
      if (destination === undefined) {
        const location = locate(source)
        if (location === undefined) return 'create-failed'
        destination = { child: `session-${globalThis.crypto.randomUUID()}` as SessionId, location, phase: 'uncertain' }
        pending.set(source, destination)
      }
      if (destination.phase === 'uncertain') {
        const { workspaceId, cwd } = destination.location
        try {
          destination.child = await sessions.create({
            sessionId: destination.child,
            ...(cwd === undefined ? {} : { cwd }),
            ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId }),
          })
          destination.phase = 'created'
        } catch (error) {
          if (!(error instanceof SessionCreateError) || error.rpcError.code !== 'session/workspace-attach-failed') {
            return 'create-failed'
          }
          destination.child = error.rpcError.details.sessionId
          destination.phase = 'ungrouped'
        }
      }
      if (!current()) return 'idle'
      // RC.3 has no remote attachment repair. Reissuing create for an ungrouped
      // child in the original workspace would silently mint a second Session.
      if (destination.phase === 'ungrouped' && !openUngrouped) return 'ungrouped'
      try {
        open(destination.child)
      } catch {
        return destination.phase === 'ungrouped' ? 'ungrouped-open-failed' : 'open-failed'
      }
      pending.delete(source)
      return 'idle'
    } finally {
      busy.delete(source)
    }
  }
}

/**
 * The alpha.2 ui-subagent resource provider owns retention, restoration and rendering.
 * Keep its wire address here; do not import the upstream private source helper or
 * mount another Conversation implementation. Both direct-parent identity and mode
 * are required so a restored tab cannot turn a read-only projection into a live child.
 */
export function openSubagentAside(sidebar: ISidebarRight, address: SubagentAddress): void {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  sidebar.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`, {
    kind: 'subagentchat',
    preferNewPane: true,
  })
}
