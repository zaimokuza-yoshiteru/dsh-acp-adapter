import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../../../src/host/composition/index.ts'
import { acpSettingsSchema } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpSettings } from '../../../src/host/composition/installed-profile-registry.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

type Watcher = (next: AcpSettings, previous: AcpSettings) => void | Promise<void>

/** A settings provider double with the real Cordis plugin lifecycle around it. */
class SettingsDocument {
  private value: unknown
  private readonly watchers = new Set<Watcher>()

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
    await Promise.all([...this.watchers].map(watcher => watcher(resolved, previous)))
  }
}

function agent(name: string, command: string): AcpAgentConfig {
  return { name, command, args: ['acp'], env: {} }
}

describe('real Cordis ACP composition settings lifecycle', () => {
  it('registers initial settings and follows later mutations through the real injected plugin', async () => {
    expect(inject).toContain('settings')
    const ctx = new Context()
    const settings = new SettingsDocument({ agents: { codex: agent('Codex', 'codex-acp') } })
    const routeCalls: string[][] = []
    const executableChecks: string[] = []
    const spawnedArgv: string[][] = []
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
    ctx.provide('sessions', { get: () => undefined })
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
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        queueMicrotask(() => stdout.end('codex-acp 1.6.2\n'))
        return {
          pid: 1,
          stdin,
          stdout,
          stderr,
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => undefined,
          waitForExit: async () => true,
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
    const fiber = ctx.plugin({ name: 'composition-settings-test', inject: [...inject], apply })
    await fiber.await()

    expect(routeCalls).toEqual([['acp-codex']])
    const remote = ctx.get('dshAcp' as never) as unknown as {
      health(request?: unknown): Promise<{ providers: Array<{ id: string }> }>
      activitySnapshot(sessionId: string, request?: unknown): Promise<unknown>
    }
    // Opening Settings is cache-only: it may resolve executable presence but
    // must not spawn either an ACP probe or a `--version` helper.
    await expect(remote.health()).resolves.toMatchObject({ providers: [{ id: 'codex', executable: true, version: null }] })
    expect(executableChecks).toContain('codex-acp')
    expect(spawnedArgv).not.toContainEqual(['codex-acp', '--version'])
    await expect(remote.health({ recheck: true, agentId: 'codex' })).resolves.toMatchObject({ providers: [{ id: 'codex', version: 'codex-acp 1.6.2' }] })
    expect(spawnedArgv).toContainEqual(['codex-acp', '--version'])

    // The parent SessionStore is intentionally empty in this fixture. A
    // persisted activity owner must still be readable after a cold reload;
    // arbitrary sessions without either live or durable ownership remain
    // denied by the composition's activityAccess gate.
    const persisted = createAcpSidecar({ root: path.join(home, 'dsh-acp') })
    await persisted.upsertActivity({
      dshSessionId: 'cold-parent', ownerDshSessionId: 'cold-parent', promptAnchorMessageId: 'cold-user',
      activityId: 'cold-tool', time: 1, kind: 'tool', status: 'completed', presentation: 'Ran pwd',
    })
    await persisted.dispose()
    await expect(remote.activitySnapshot('cold-parent', { filter: { ownerDshSessionId: 'cold-parent', promptAnchorMessageId: 'cold-user' } })).resolves.toMatchObject({
      activities: [{ activityId: 'cold-tool', presentation: 'Ran pwd' }],
    })
    await expect(remote.activitySnapshot('unrelated-session')).rejects.toThrow('not authorized')

    await settings.replace({ agents: { devin: agent('Devin', 'devin') } })
    expect(routeCalls).toContainEqual(['acp-codex'])
    expect(routeCalls).toContainEqual(['acp-devin'])
    await expect(remote.health()).resolves.toMatchObject({ providers: [{ id: 'devin' }] })
    await expect(remote.health({ recheck: true, agentId: 'devin' })).resolves.toMatchObject({ providers: [{ id: 'devin' }] })
    const callsAtDispose = routeCalls.length
    await ctx.fiber.dispose()
    await settings.replace({ agents: { codex: agent('Codex', 'codex-acp') } })
    expect(routeCalls).toHaveLength(callsAtDispose)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
})
