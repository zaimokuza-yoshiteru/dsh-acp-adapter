/** Navigation through DSH's Session ownership and native resource presentation. */
import type { SessionCreateError, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import type { ClientRemoteAccess } from '@deepseek-ai/dsh-api-remote-access/client'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { CrossBackendLocation } from '../data/cross-backend-controller.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'

export function isMainSession(sessions: ISessions, sessionId: SessionId): boolean {
  return (sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) > 0
}

// RC.3 can load the contributing client and the Host service in different bundles.
export function sessionCreateFailure(error: unknown): SessionCreateError['rpcError'] | undefined {
  if (error instanceof Error && error.name === 'SessionCreateError') return (error as SessionCreateError).rpcError
  return undefined
}

export async function sourcePresetUnavailable(ctx: Context, preset: string): Promise<boolean> {
  // Reading the optional roster is advisory: creation has its own Host grant and validation.
  const registry = ctx.get('remote.agentPresets') as TypertClientRemote['agentPresets'] | undefined
  const roster = await registry?.list?.().catch(() => undefined)
  if (!roster?.ok) return false
  const row = roster.value.presets.find((entry) => entry.id === preset)
  return row === undefined || row.broken !== undefined
}

export function createIndependentChild(
  sessions: Pick<ISessions, 'create'>,
  sessionId: SessionId,
  location: CrossBackendLocation,
) {
  const { agentPreset, workspaceId, cwd } = location
  return sessions.create({
    sessionId,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(workspaceId === undefined ? {} : { workspaceId: workspaceId as WorkspaceId }),
  })
}

export function presetUnavailable(code: string | undefined, location: CrossBackendLocation): boolean {
  return location.agentPreset !== undefined && (code === 'agent-preset/not-found' || code === 'agent-preset/invalid')
}

export function withDefaultPreset({ agentPreset: _preset, ...location }: CrossBackendLocation): CrossBackendLocation {
  return location
}

export function openIndependentChild(ctx: Context, child: SessionId): void {
  const access = ctx.get('remoteAccess') as unknown as ClientRemoteAccess | undefined
  if (access?.source('session', child, 'session/follow').getSnapshot() !== true)
    throw new Error('Session history is unavailable.')
  ctx.uiWorkspace.openSession(child)
}

/** The Host may retain a ready client list after a failed pull. An absent row
 * may also be filtered, and a cold row may have no cached blankness yet. */
async function readIndependentBlank(ctx: Context, child: SessionId) {
  const remote = ctx.remote as TypertClientRemote
  const list = await remote.session.list({})
  if (!list.ok) throw list.error
  const row = list.value.items.find((item) => item.sessionId === child)
  if (!row) {
    const access = ctx.get('remoteAccess') as unknown as ClientRemoteAccess | undefined
    if (access?.source('session', child, 'session/list').getSnapshot() !== true)
      throw new Error('Session list unavailable')
    const observed = await remote.session.projections({ sessionId: child })
    if (!observed.ok) throw observed.error
    if (observed.value === null) return undefined
    throw new Error('Session is missing from the current list')
  }
  if (row.running || row.origin === 'subagent' || row.parentSessionId !== undefined)
    throw new Error('An idle main session is required')
  if (!row.agentAvailable) {
    const observed = await remote.session.projections({ sessionId: child })
    if (!observed.ok) throw observed.error
    if (
      observed.value?.kind !== 'sequenced' ||
      observed.value.values.sessionListMetadata?.blank !== true ||
      observed.value.values.sessionListMetadata.lastPromptAt !== null
    )
      throw new Error('Blank session unavailable')
  } else if (!row.blank) throw new Error('Blank session unavailable')
  return row
}

export async function reconcileIndependentChild(ctx: Context, child: SessionId, location: CrossBackendLocation) {
  const remote = ctx.remote as TypertClientRemote
  const access = ctx.get('remoteAccess') as unknown as ClientRemoteAccess | undefined
  if (!(await readIndependentBlank(ctx, child))) return 'missing'
  if (location.workspaceId === undefined) return 'created'
  const controller = new AbortController()
  try {
    for await (const frame of remote.workspace.follow(controller.signal)) {
      if (frame.type !== 'baseline') break
      if (frame.value.archivedSessionIds.includes(child)) throw new Error('Blank session is archived')
      const workspace = frame.value.items.find((row) => row.workspaceId === location.workspaceId)
      if (workspace?.sessionIds.includes(child)) return 'created'
      if (workspace !== undefined && access?.source('session', child, 'workspace/follow').getSnapshot() === true)
        return 'ungrouped'
      break
    }
    throw new Error('Workspace membership unavailable')
  } finally {
    controller.abort()
  }
}

export function definiteCreateRefusal(code: string | undefined): boolean {
  return (
    code === 'remote-access/denied' ||
    code === 'gateway/bad-request' ||
    code?.startsWith('workspace/') === true ||
    code?.startsWith('session/') === true ||
    code?.startsWith('agent-preset/') === true
  )
}

/** A failed preset mount may already have written the requested blank to disk.
 * A workspace create would mint another child if attachment never ran. Recover
 * the existing blank by its actual cwd, and retain the result across lost replies. */
export class DefaultPresetRepair {
  private attempted = false
  private expected: string | undefined

  async run(ctx: Context, child: SessionId, current: () => boolean): Promise<SessionId> {
    const row = await readIndependentBlank(ctx, child)
    if (!row?.cwd) throw new Error('Blank session working directory unavailable')
    if (this.attempted) {
      if (row.agentAvailable && this.expected !== undefined && row.projections?.values.agentPreset === this.expected)
        return child
      throw new Error('Default mode activation has not been confirmed')
    }
    const registry = ctx.get('remote.agentPresets') as TypertClientRemote['agentPresets'] | undefined
    const roster = await registry?.list?.().catch(() => undefined)
    this.expected = roster?.ok ? roster.value.presets.find((preset) => preset.isDefault)?.id : undefined
    if (!current()) throw new Error('Session creation was interrupted')
    this.attempted = true
    try {
      const restored = await (ctx.get('sessions') as unknown as ISessions).create({ sessionId: child, cwd: row.cwd })
      if (restored !== child) throw new Error('The Host could not reuse the original blank session')
      return restored
    } catch (error) {
      if (definiteCreateRefusal(sessionCreateFailure(error)?.code)) this.attempted = false
      throw error
    }
  }
}

export type IndependentSessionAction = 'create' | 'open-existing' | 'use-default'
export type IndependentSessionOutcome =
  | 'create-unknown'
  | 'preset-unavailable'
  | 'idle'
  | 'create-failed'
  | 'open-failed'
  | 'ungrouped'
  | 'ungrouped-open-failed'

export function nextIndependentAction(outcome: IndependentSessionOutcome | 'busy'): IndependentSessionAction {
  if (outcome === 'preset-unavailable') return 'use-default'
  if (outcome.startsWith('ungrouped') || outcome === 'open-failed') return 'open-existing'
  return 'create'
}

/** Keep the Host-published identity across a failed attachment, navigation or interrupted view. */
export function independentSessionNavigation(
  sessions: Pick<ISessions, 'create'>,
  locate: (source: SessionId) => CrossBackendLocation | undefined,
  open: (child: SessionId) => void,
  reconcile: (child: SessionId, location: CrossBackendLocation) => Promise<'missing' | 'created' | 'ungrouped'>,
  unavailable?: (preset: string) => Promise<boolean>,
  repairDefault?: (repair: DefaultPresetRepair, child: SessionId, current: () => boolean) => Promise<SessionId>,
) {
  interface Destination {
    child: SessionId
    location: CrossBackendLocation
    phase: 'preset-unavailable' | 'uncertain' | 'created' | 'ungrouped'
    attempted: boolean
    refused: boolean
    repair: DefaultPresetRepair
  }
  const pending = new Map<SessionId, Destination>()
  const busy = new Set<SessionId>()
  return async (
    source: SessionId,
    current: () => boolean,
    action: IndependentSessionAction,
  ): Promise<IndependentSessionOutcome> => {
    if (!current() || busy.has(source)) return 'idle'
    busy.add(source)
    try {
      let destination = pending.get(source)
      if (destination?.phase === 'uncertain' && destination.attempted) {
        // A missing response may still have published the requested identity.
        // Resolve against a fresh Host baseline before we send another create.
        const observed = await reconcile(destination.child, destination.location)
        if (!current()) return 'idle'
        if (observed !== 'missing') destination.phase = observed
        else if (!destination.refused) return 'create-unknown'
      }
      if (destination === undefined) {
        const location = locate(source)
        if (location === undefined) return 'create-failed'
        destination = {
          child: `session-${globalThis.crypto.randomUUID()}` as SessionId,
          location,
          phase: 'uncertain',
          attempted: false,
          refused: false,
          repair: new DefaultPresetRepair(),
        }
        pending.set(source, destination)
      }
      if (destination.phase === 'preset-unavailable') {
        if (action !== 'use-default') return 'preset-unavailable'
        const existing = destination.attempted ? await reconcile(destination.child, destination.location) : 'missing'
        if (!current()) return 'idle'
        if (existing !== 'missing') {
          if (!repairDefault) throw new Error('Default mode recovery unavailable')
          destination.child = await repairDefault(destination.repair, destination.child, current)
          destination.phase = existing
        } else {
          destination.location = withDefaultPreset(destination.location)
          destination.phase = 'uncertain'
        }
        if (!current()) return 'idle'
      }
      if (destination.phase === 'uncertain') {
        if (destination.location.agentPreset && unavailable) {
          if (await unavailable(destination.location.agentPreset)) {
            destination.phase = 'preset-unavailable'
            return 'preset-unavailable'
          }
          if (!current()) return 'idle'
        }
        try {
          destination.attempted = true
          destination.child = await createIndependentChild(sessions, destination.child, destination.location)
          destination.phase = 'created'
        } catch (error) {
          const failure = sessionCreateFailure(error)
          if (presetUnavailable(failure?.code, destination.location)) {
            destination.phase = 'preset-unavailable'
            return 'preset-unavailable'
          }
          if (failure?.code !== 'session/workspace-attach-failed') {
            destination.refused = definiteCreateRefusal(failure?.code)
            return destination.refused ? 'create-failed' : 'create-unknown'
          }
          destination.child = failure.details.sessionId
          destination.phase = 'ungrouped'
        }
      }
      if (!current()) return 'idle'
      // RC.3 has no remote attachment repair. Reissuing create for an ungrouped
      // child in the original workspace would silently mint a second Session.
      if (destination.phase === 'ungrouped' && action !== 'open-existing') return 'ungrouped'
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
