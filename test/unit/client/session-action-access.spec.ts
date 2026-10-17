import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteAccessFrame, RemoteAccessGrant } from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AcpAgentSessionSnapshotView, AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'
import { sessionActionAccess, type SessionAccessSource } from '../../../src/client/ui/session-action-access.ts'
import { applyTeamMode } from '../../../src/client/ui/team-mode-controls.ts'

type Baseline = Extract<RemoteAccessFrame, { type: 'baseline' }>
interface NativeAccessState {
  resource(kind: string, id: string, action: string): HostObservable<boolean>
  replace(frame: Baseline): void
  update(frame: Exclude<RemoteAccessFrame, { type: 'baseline' }>): void
  unavailable(): void
}

// The published Client entry is a Loader registration wrapper. Exercise its
// exact emitted state implementation; only the carrier frames are controlled.
const accessPackage = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-api-remote-access/package.json')))
const { ClientAccessState } = (await import(pathToFileURL(join(accessPackage, 'lib/types/client/state.js')).href)) as {
  ClientAccessState: new (initial?: Baseline) => NativeAccessState
}

const action = 'dshAcp/setTeamMemberMode'
const grant = (id: string, actions: readonly string[] = [action]): RemoteAccessGrant => ({
  resource: { kind: 'session', id: id as SessionId },
  actions,
})
const baseline = (...ids: string[]): Baseline => ({
  type: 'baseline',
  owner: false,
  grants: ids.map((id) => grant(id)),
})
const sourceOf =
  (state: NativeAccessState): SessionAccessSource =>
  (id, endpoint) =>
    state.resource('session', id, endpoint)
const allow = (state: NativeAccessState, id: string): void => {
  state.update({ type: 'upsert', grant: grant(id) })
}
const revoke = (state: NativeAccessState, id: string): void => {
  state.update({ type: 'remove', resource: { kind: 'session', id: id as SessionId } })
}

const member = (sessionId: string, patch: Partial<AcpTeamMemberView> = {}): AcpTeamMemberView => ({
  sessionId,
  profileId: 'codex',
  name: sessionId,
  status: 'inactive',
  model: null,
  description: null,
  ...patch,
})
const snapshot = (sessionId: string): AcpAgentSessionSnapshotView => ({
  sessionId,
  profileId: 'codex',
  freshness: 'live',
  editable: true,
  configOptions: null,
  modes: [
    { id: 'code', name: 'Code' },
    { id: 'plan', name: 'Plan' },
  ],
  currentModeId: 'code',
  contextUsage: null,
  note: null,
})

describe('session action access from the published native Client snapshot', () => {
  it('preserves owner answers without inventing access for IDs outside the captured set', () => {
    const state = new ClientAccessState({ type: 'baseline', owner: true })
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    expect(access.getSnapshot()).toBe('11')
    expect(access.allows('lead') && access.allows('child')).toBe(true)
    expect(access.allows('not-captured')).toBe(false)
    state.unavailable()
    revoke(state, 'child')
    expect(access.getSnapshot()).toBe('11')
  })

  it('denies without a baseline and does not substitute a global or different-action grant', () => {
    const state = new ClientAccessState()
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    expect(access.getSnapshot()).toBe('00')
    state.replace({
      type: 'baseline',
      owner: false,
      grants: [{ resource: { kind: 'global' }, actions: [action] }, grant('lead', ['dshAcp/teamMembers'])],
    })
    expect(access.getSnapshot()).toBe('00')
    expect(access.allows('lead')).toBe(false)
    expect(access.allows('child')).toBe(false)
  })

  it('requires independent lead and child grants and follows revocation and restoration', () => {
    const state = new ClientAccessState(baseline('lead'))
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    const canWrite = () => access.allows('lead') && access.allows('child')
    expect(access.getSnapshot()).toBe('10')
    expect(canWrite()).toBe(false)
    allow(state, 'child')
    expect(access.getSnapshot()).toBe('11')
    expect(canWrite()).toBe(true)
    revoke(state, 'lead')
    expect(access.getSnapshot()).toBe('01')
    expect(canWrite()).toBe(false)
    allow(state, 'lead')
    expect(canWrite()).toBe(true)
    revoke(state, 'child')
    expect(access.getSnapshot()).toBe('10')
    expect(canWrite()).toBe(false)
  })

  it('fails closed after a non-owner stream failure until a new native baseline arrives', () => {
    const state = new ClientAccessState(baseline('lead', 'child'))
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    expect(access.getSnapshot()).toBe('11')
    state.unavailable()
    expect(access.getSnapshot()).toBe('00')
    allow(state, 'lead')
    expect(access.getSnapshot()).toBe('00')
    state.replace(baseline('lead', 'child'))
    expect(access.getSnapshot()).toBe('11')
  })

  it('deduplicates captured members and releases the old real-source subscriptions on replacement', () => {
    const state = new ClientAccessState(baseline('lead'))
    const subscriptions = new Map<string, ReturnType<typeof vi.fn>>()
    const disposers = new Map<string, ReturnType<typeof vi.fn>[]>()
    const source = vi.fn((id: string, endpoint: string): HostObservable<boolean> => {
      const native = state.resource('session', id, endpoint)
      const subscribe = vi.fn((changed: () => void) => {
        const releaseNative = native.subscribe(changed)
        const dispose = vi.fn(releaseNative)
        disposers.set(id, [...(disposers.get(id) ?? []), dispose])
        return dispose
      })
      subscriptions.set(id, subscribe)
      return { getSnapshot: native.getSnapshot, subscribe }
    })
    const first = sessionActionAccess(source, ['lead', 'old', 'old'], action)
    expect(source.mock.calls).toEqual([
      ['lead', action],
      ['old', action],
    ])
    const oldChanged = vi.fn()
    const stopOld = first.subscribe(oldChanged)
    expect(subscriptions.get('lead')).toHaveBeenCalledOnce()
    expect(subscriptions.get('old')).toHaveBeenCalledOnce()
    allow(state, 'old')
    expect(first.getSnapshot()).toBe('11')
    expect(oldChanged).toHaveBeenCalledOnce()
    stopOld()
    expect(disposers.get('lead')?.[0]).toHaveBeenCalledOnce()
    expect(disposers.get('old')?.[0]).toHaveBeenCalledOnce()

    const replacement = sessionActionAccess(source, ['new', 'lead', 'new'], action)
    const changed = vi.fn()
    const stopReplacement = replacement.subscribe(changed)
    expect(replacement.getSnapshot()).toBe('01')
    expect(replacement.allows('old')).toBe(false)
    allow(state, 'new')
    expect(replacement.getSnapshot()).toBe('11')
    expect(changed).toHaveBeenCalledOnce()
    expect(oldChanged).toHaveBeenCalledOnce()
    stopReplacement()
    revoke(state, 'new')
    expect(changed).toHaveBeenCalledOnce()
    expect(disposers.get('new')?.[0]).toHaveBeenCalledOnce()
    expect(disposers.get('lead')?.[1]).toHaveBeenCalledOnce()
  })

  it('keeps an unavailable source and an empty captured set denied', () => {
    const state = new ClientAccessState({ type: 'baseline', owner: true })
    const source: SessionAccessSource = (id, endpoint) =>
      id === 'child' ? undefined : state.resource('session', id, endpoint)
    const access = sessionActionAccess(source, ['lead', 'child'], action)
    expect(access.getSnapshot()).toBe('10')
    expect(access.allows('child')).toBe(false)
    const changed = vi.fn()
    const stop = access.subscribe(changed)
    stop()
    const empty = sessionActionAccess(source, [], action)
    expect(empty.getSnapshot()).toBe('')
    expect(empty.allows('lead')).toBe(false)
    empty.subscribe(changed)()
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('native access revalidation at Team mode dispatch', () => {
  it('does not read membership or mode metadata for a member without write authority', async () => {
    const state = new ClientAccessState(baseline('lead'))
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    const members = vi.fn(async () => [member('child')])
    const read = vi.fn(async (id: string) => snapshot(id))
    const write = vi.fn(async () => {})
    const result = await applyTeamMode({
      targets: ['child'],
      profileId: 'codex',
      mode: 'plan',
      isCurrent: () => true,
      canWrite: (id) => access.allows('lead') && access.allows(id),
      members,
      snapshot: read,
      write,
    })
    expect(result).toEqual({ applied: 0, skipped: 1, failed: 0, members: [{ sessionId: 'child', reason: 'Stale' }] })
    expect(members).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['lead', 'child'])('does not write when %s authority is revoked during the mode read', async (revoked) => {
    const state = new ClientAccessState(baseline('lead', 'child'))
    const access = sessionActionAccess(sourceOf(state), ['lead', 'child'], action)
    const entered = Promise.withResolvers<void>()
    const modeRead = Promise.withResolvers<AcpAgentSessionSnapshotView>()
    const write = vi.fn(async () => {})
    const result = applyTeamMode({
      targets: ['child'],
      profileId: 'codex',
      mode: 'plan',
      isCurrent: () => true,
      canWrite: (id) => access.allows('lead') && access.allows(id),
      members: async () => [member('child')],
      snapshot: async () => {
        entered.resolve()
        return await modeRead.promise
      },
      write,
    })
    await entered.promise
    revoke(state, revoked)
    modeRead.resolve(snapshot('child'))
    expect(await result).toEqual({
      applied: 0,
      skipped: 1,
      failed: 0,
      members: [{ sessionId: 'child', reason: 'Stale' }],
    })
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['members', 'snapshot'])(
    'skips a member revoked during the %s read and continues the other captured member',
    async (phase) => {
      const state = new ClientAccessState(baseline('lead', 'first', 'second'))
      const access = sessionActionAccess(sourceOf(state), ['lead', 'first', 'second'], action)
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      let membershipReads = 0
      const read = vi.fn(async (id: string) => {
        if (phase === 'snapshot' && id === 'first') {
          entered.resolve()
          await released.promise
        }
        return snapshot(id)
      })
      const write = vi.fn(async () => {})
      const result = applyTeamMode({
        targets: ['first', 'second'],
        profileId: 'codex',
        mode: 'plan',
        isCurrent: () => true,
        canWrite: (id) => access.allows('lead') && access.allows(id),
        members: async () => {
          if (phase === 'members' && membershipReads++ === 0) {
            entered.resolve()
            await released.promise
          }
          return [member('first'), member('second')]
        },
        snapshot: read,
        write,
      })
      await entered.promise
      revoke(state, 'first')
      released.resolve()
      expect(await result).toEqual({
        applied: 1,
        skipped: 1,
        failed: 0,
        members: [
          { sessionId: 'first', reason: 'Stale' },
          { sessionId: 'second', reason: 'Applied' },
        ],
      })
      expect(read.mock.calls.map(([id]) => id)).toEqual(phase === 'members' ? ['second'] : ['first', 'second'])
      expect(write).toHaveBeenCalledExactlyOnceWith('second', { kind: 'mode', id: 'plan' })
    },
  )

  it('preserves captured-target, profile and running-state checks after native authorization', async () => {
    const ids = ['lead', 'allowed', 'denied', 'foreign', 'running', 'gone', 'late']
    const state = new ClientAccessState(baseline(...ids.filter((id) => id !== 'denied')))
    const access = sessionActionAccess(sourceOf(state), ids, action)
    const read = vi.fn(async (id: string) => snapshot(id))
    const write = vi.fn(async () => {})
    const result = await applyTeamMode({
      targets: ['allowed', 'allowed', 'denied', 'foreign', 'running', 'gone'],
      profileId: 'codex',
      mode: 'plan',
      isCurrent: () => true,
      canWrite: (id) => access.allows('lead') && access.allows(id),
      members: async () => [
        member('allowed'),
        member('denied'),
        member('foreign', { profileId: 'kimi' }),
        member('running', { status: 'running' }),
        member('late'),
      ],
      snapshot: read,
      write,
    })
    expect(result).toEqual({
      applied: 1,
      skipped: 4,
      failed: 0,
      members: [
        { sessionId: 'allowed', reason: 'Applied' },
        { sessionId: 'denied', reason: 'Stale' },
        { sessionId: 'foreign', reason: 'Missing' },
        { sessionId: 'running', reason: 'Inactive' },
        { sessionId: 'gone', reason: 'Missing' },
      ],
    })
    expect(read).toHaveBeenCalledExactlyOnceWith('allowed')
    expect(write).toHaveBeenCalledExactlyOnceWith('allowed', { kind: 'mode', id: 'plan' })
  })
})
