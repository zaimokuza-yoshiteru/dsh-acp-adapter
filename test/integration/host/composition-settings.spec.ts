import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject } from '../../../src/host/composition/index.ts'
import { acpSettingsSchema } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpSettings } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import type { AcpBindingData } from '../../../src/persistence/sidecar.ts'

type Watcher = (next: AcpSettings, previous: AcpSettings) => void | Promise<void>

/** A settings provider double with the real Cordis plugin lifecycle around it. */
class SettingsDocument {
  private value: unknown
  private readonly watchers = new Set<Watcher>()
  onChange: () => void = () => {}
  readonly config = {
    agents: { get: () => acpSettingsSchema(this.value).agents },
    searchableModelPicker: { get: () => acpSettingsSchema(this.value).searchableModelPicker },
    toolApprovalDefault: { get: () => acpSettingsSchema(this.value).toolApprovalDefault },
  }
  configure() { return () => {} }

  constructor(initial: unknown) {
    this.value = initial
  }

  register(_namespace: string, schema: typeof acpSettingsSchema) {
    return {
      get: (): AcpSettings => schema(this.value),
      watch: (watcher: Watcher) => {
        this.watchers.add(watcher)
        return () => { this.watchers.delete(watcher) }
      },
    }
  }

  async replace(next: unknown): Promise<void> {
    const previous = acpSettingsSchema(this.value)
    const resolved = acpSettingsSchema(next)
    this.value = next
    this.onChange()
    await Promise.all([...this.watchers].map(watcher => watcher(resolved, previous)))
  }
}

function agent(name: string, command: string): AcpAgentConfig {
  return { name, command, args: ['acp'], env: {} }
}

describe('real Cordis ACP composition settings lifecycle', () => {
  it('registers initial settings and follows later mutations through the real injected plugin', async () => {
    expect(inject).not.toContain('settings')
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    // This registry-only fixture never dispatches an ACP AgentLoop turn.
    ctx.provide('permissionPresets', {})
    const settings = new SettingsDocument({ agents: { codex: agent('Codex', 'codex-acp') } })
    const routeCalls: string[][] = []
    const executableChecks: string[] = []
    const spawnedArgv: string[][] = []
    let failVersionProvider = false
    let versionTerminations = 0
    const handles = new Map<string, { (): void; replace(routes: string[]): void }>()
    const llm = {
      registerAdapter(routes: string[]) {
        routeCalls.push([...routes])
        const dispose = Object.assign(() => undefined, { replace: (next: string[]) => routeCalls.push([...next]) })
        handles.set(routes[0]!, dispose)
        return dispose
      },
    }
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-acp-composition-'))
    ctx.provide('settings', settings)
    ctx.provide('llm', llm)
    const liveSessions = new Map<string, { header: { origin?: string; parentSession?: string }; facts: unknown; permissions: unknown; requestHeader?: () => { config: { provider: string } } }>()
    ctx.provide('sessions', { get: (id: string) => liveSessions.get(id) })
    const liveAgents = new Map<string, { id: string; options: { provider: string } }>()
    const memberships = new Map<object, { id: string; role: 'lead' | 'teammate'; root: object }>()
    const agentResolutionCalls: string[] = []
    ctx.provide('agents', { get: (id: string) => liveAgents.get(id), list: () => [...liveAgents.values()] })
    ctx.provide('sessionController', { resolveAgent: async (id: string) => {
      agentResolutionCalls.push(id)
      return liveSessions.get(id)?.header.origin === 'subagent'
        ? { error: new Error('subagent sessions are not activatable') }
        : { agent: liveAgents.get(id) }
    } })
    ctx.provide('agentTeams', {
      tryMembership: (agent: object) => memberships.get(agent),
      listMembers: (lead: object) => [...memberships.entries()]
        .filter(([, membership]) => membership.role === 'teammate' && membership.root === lead)
        .map(([agent]) => ({ id: (agent as { id: string }).id, role: 'teammate' as const })),
    })
    // Use the actual host subprocess seam shape.  The health service and the
    // ACP probe must share this seam; otherwise a successful probe can still
    // be reported as executable=false/version=null by the Remote constructor.
    const subprocess = {
      resolveExecutable: async (command: string) => {
        executableChecks.push(command)
        return command
      },
      spawn: (spec: { argv: readonly string[] }) => {
        spawnedArgv.push([...spec.argv])
        const isVersion = spec.argv.includes('--version')
        const failThis = failVersionProvider && isVersion
        let terminated = false
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        queueMicrotask(() => stdout.end(isVersion ? 'codex-acp 1.6.2\n' : ''))
        return {

          stdin,
          stdout,
          stderr,
          done: failThis ? Promise.reject(new Error('provider unavailable')) : Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => { terminated = true; versionTerminations += Number(isVersion) },
          waitForExit: async () => { if (failThis && !terminated) throw new Error('cannot observe'); return true },
        }
      },
    }
    ctx.provide('subprocess', subprocess)
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 4096,
        maxImagePixels: 1_000_000,
        maxImageDimension: 4096,
        mediaTypes: ['image/png'],
      },
      readImage: async () => { throw new Error('not used by this composition test') },
    })
    ctx.provide('dshHomePath', (...segments: string[]) => path.join(home, ...segments))
    const fiber = ctx.plugin({ name: 'composition-settings-test', inject: [...inject], apply: (scope: Context) => {
      settings.onChange = () => scope.emit('loader/volatile-update', [])
      apply(scope, settings.config)
    } })
    await fiber.await()

    expect(routeCalls).toEqual([['acp-codex']])
    const remote = ctx.get('dshAcp' as never) as unknown as {
      health(request?: unknown): Promise<{ providers: Array<{ id: string }> }>
      activitySnapshot(sessionId: string, request?: unknown): Promise<unknown>
      toolApprovalPolicy(sessionId: string): Promise<{ policy: 'auto' | 'ask'; source: string; editable: boolean }>
      setToolApprovalPolicy(sessionId: string, request: { policy: 'auto' | 'ask' }): Promise<unknown>
    }
    // Opening Settings is cache-only: it may resolve executable presence but
    // must not spawn either an ACP probe or a `--version` helper.
    await expect(remote.health()).resolves.toMatchObject({ providers: [{ id: 'codex', executable: true, version: null }] })
    expect(executableChecks).toContain('codex-acp')
    expect(spawnedArgv).not.toContainEqual(['codex-acp', '--version'])
    await expect(remote.health({ recheck: true, agentId: 'codex' })).resolves.toMatchObject({ providers: [{ id: 'codex', version: 'codex-acp 1.6.2' }] })
    expect(spawnedArgv).toContainEqual(['codex-acp', '--version'])
    failVersionProvider = true
    await expect(remote.health({ recheck: true, agentId: 'codex' })).resolves.toMatchObject({ providers: [{ id: 'codex', version: null }] })
    expect(versionTerminations).toBe(1)
    failVersionProvider = false

    // The parent SessionStore is intentionally empty in this fixture. A
    // persisted activity owner must still be readable after a cold reload;
    // arbitrary sessions without either live or durable ownership remain
    // denied by the composition's activityAccess gate.
    const persisted = createAcpSidecar({ root: path.join(home, 'dsh-acp') })
    const seedAcpBinding = async (sessionId: string): Promise<void> => {
      const binding: AcpBindingData = {
        provider: 'acp-codex', agentSessionId: `agent-${sessionId}`, profileId: 'codex', canonicalCwd: '/tmp/work',
        launchFingerprint: { command: 'codex-acp', args: ['acp'], envKeys: [] },
        agent: { name: 'Codex', version: '1.6.2' }, protocolVersion: 1,
        capabilityHash: 'a1b2c3d4e5f60708', configHash: '0817f6e5d4c3b2a1', generation: 1,
        bindingEpoch: 1, committedPromptOrdinal: 0, historyBaseSeq: 0, establishedAt: Date.now(), dshCommittedSeq: 0,
      }
      await persisted.append(sessionId as never, { kind: 'binding', data: binding })
    }
    await persisted.upsertActivity({
      dshSessionId: 'cold-parent', ownerDshSessionId: 'cold-parent', promptAnchorMessageId: 'cold-user',
      activityId: 'cold-tool', time: 1, kind: 'tool', status: 'completed', presentation: 'Ran pwd',
    })
    await expect(remote.activitySnapshot('cold-parent', { filter: { ownerDshSessionId: 'cold-parent', promptAnchorMessageId: 'cold-user' } })).resolves.toMatchObject({
      activities: [{ activityId: 'cold-tool', presentation: 'Ran pwd' }],
    })
    await expect(remote.activitySnapshot('unrelated-session')).rejects.toThrow('not authorized')
    await seedAcpBinding('policy-no-session')
    await expect(remote.toolApprovalPolicy('policy-no-session')).rejects.toThrow('ACP_TOOL_APPROVAL_SESSION_UNAVAILABLE')
    await expect(persisted.readToolApprovalPolicy('policy-no-session' as never)).resolves.toBeUndefined()

    // Exercise the production composition resolver against real sidecar rows,
    // session ownership, and live Team membership (not a bridge callback stub).
    const addSession = (id: string, parentSession?: string): void => {
      liveSessions.set(id, { header: { ...(parentSession === undefined ? { origin: 'native' } : { parentSession }) }, facts: {}, permissions: {}, requestHeader: () => ({ config: { provider: 'acp-codex' } }) })
      liveAgents.set(id, { id, options: { provider: 'acp-codex' } })
    }
    addSession('policy-root')
    await seedAcpBinding('policy-root')
    await expect(remote.toolApprovalPolicy('policy-root')).resolves.toMatchObject({ policy: 'auto', source: 'session', editable: true })
    expect(agentResolutionCalls).not.toContain('policy-root')
    await settings.replace({ agents: { codex: agent('Codex', 'codex-acp') }, toolApprovalDefault: 'ask' })
    // First ACP admission snapshots the default; a later global change cannot
    // rewrite an already initialized session.
    await expect(remote.toolApprovalPolicy('policy-root')).resolves.toMatchObject({ policy: 'auto' })
    addSession('policy-new-root')
    await expect(remote.toolApprovalPolicy('policy-new-root')).resolves.toMatchObject({ policy: 'ask' })
    await remote.setToolApprovalPolicy('policy-root', { policy: 'ask' })

    const lead = liveAgents.get('policy-root')!
    const teammate = liveAgents.get('policy-member') ?? { id: 'policy-member', options: { provider: 'acp-codex' } }
    liveAgents.set(teammate.id, teammate)
    liveSessions.set(teammate.id, { header: { origin: 'subagent', parentSession: lead.id }, facts: {}, permissions: {}, requestHeader: () => ({ config: { provider: 'acp-codex' } }) })
    await seedAcpBinding(teammate.id)
    const teamId = 'policy-team'
    memberships.set(lead, { id: teamId, role: 'lead', root: lead })
    memberships.set(teammate, { id: teamId, role: 'teammate', root: lead })
    await expect(remote.toolApprovalPolicy(teammate.id)).resolves.toMatchObject({ policy: 'ask', source: 'lead', editable: false })

    // An ordinary fork of that teammate is independent, initialized from the
    // parent's effective Lead policy rather than the plugin default.
    addSession('policy-fork', teammate.id)
    await expect(remote.toolApprovalPolicy('policy-fork')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    // A cold ordinary fork can initialize through its dormant teammate parent,
    // whose current Lead roster remains authoritative.
    liveAgents.delete(teammate.id)
    await expect(remote.toolApprovalPolicy(teammate.id)).resolves.toMatchObject({ policy: 'ask', source: 'lead', editable: false })
    addSession('policy-fork-dormant-parent', teammate.id)
    await expect(remote.toolApprovalPolicy('policy-fork-dormant-parent')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    // A subagent with no verified Lead roster must fail closed without creating
    // an independent row from the global default.
    memberships.delete(teammate)
    await expect(remote.toolApprovalPolicy(teammate.id)).rejects.toThrow('ACP_TOOL_APPROVAL_LEAD_UNAVAILABLE')
    await expect(persisted.readToolApprovalPolicy(teammate.id as never)).resolves.toBeUndefined()
    memberships.set(teammate, { id: teamId, role: 'teammate', root: lead })
    memberships.set(lead, { id: teamId, role: 'lead', root: lead })
    // The teammate follows the Lead; the ordinary fork keeps its copied value.
    await remote.setToolApprovalPolicy('policy-root', { policy: 'auto' })
    await expect(remote.toolApprovalPolicy(teammate.id)).resolves.toMatchObject({ policy: 'auto', source: 'lead', editable: false })
    await expect(remote.toolApprovalPolicy('policy-fork')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await expect(remote.toolApprovalPolicy('policy-fork-dormant-parent')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await expect(remote.toolApprovalPolicy(teammate.id)).resolves.toMatchObject({ policy: 'auto', source: 'lead', editable: false })
    liveSessions.delete(teammate.id)
    liveAgents.delete('policy-fork')
    await expect(remote.toolApprovalPolicy('policy-fork')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })
    await expect(remote.toolApprovalPolicy('policy-fork-dormant-parent')).resolves.toMatchObject({ policy: 'ask', source: 'session', editable: true })

    await settings.replace({ agents: { devin: agent('Devin', 'devin') } })
    expect(routeCalls).toContainEqual(['acp-codex'])
    expect(routeCalls).toContainEqual(['acp-devin'])
    await expect(remote.health()).resolves.toMatchObject({ providers: [{ id: 'devin' }] })
    await expect(remote.health({ recheck: true, agentId: 'devin' })).resolves.toMatchObject({ providers: [{ id: 'devin' }] })
    const callsAtDispose = routeCalls.length
    await ctx.fiber.dispose()
    await persisted.dispose()
    await settings.replace({ agents: { codex: agent('Codex', 'codex-acp') } })
    expect(routeCalls).toHaveLength(callsAtDispose)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
})
