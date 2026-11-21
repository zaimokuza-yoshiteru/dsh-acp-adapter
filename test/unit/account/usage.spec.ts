import { PassThrough } from 'node:stream'
import { lstat } from 'node:fs/promises'
import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { AcpAgentConfig } from '../../../src/contract/agent-config.ts'
import { accountUsageProvider } from '../../../src/contract/account-usage.ts'
import { codexFields, devinPlan } from '../../../src/remote/account/fields.ts'
import { MACOS_ACCOUNT_SANDBOX } from '../../../src/remote/account/antigravity.ts'
import { AccountUsageService } from '../../../src/remote/account/service.ts'
import type {
  AcpAccountTerminalSpec,
  AcpSubprocessSpawnSpec,
  SubprocessSeam,
} from '../../../src/runtime/process/subprocess.ts'

const devin: AcpAgentConfig = { name: 'My agent', command: 'devin', args: ['acp'], env: {}, runtime: 'devin' }
const agy: AcpAgentConfig = { ...devin, command: '/custom/bin/agy', runtime: 'antigravity' }

function service(profiles: Map<string, AcpAgentConfig>, methods: Partial<SubprocessSeam> = {}, platform = 'darwin') {
  return new AccountUsageService(
    {
      ok: true,
      seam: { localExecution: true, spawn: vi.fn(), resolveExecutable: vi.fn(), ...methods },
    },
    () => profiles,
    platform,
  )
}

function pipes(output = new PassThrough(), stdin = new PassThrough()) {
  return {
    stdin,
    stdout: output,
    stderr: new PassThrough(),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    waitForExit: vi.fn(async () => true),
    terminate: vi.fn(),
  }
}

describe('Agent account reads', () => {
  it('accepts explicit local CLI launches and declines unsupported contexts', async () => {
    const codex = { ...devin, runtime: 'codex' as const, command: 'codex-acp', args: [] }
    expect(accountUsageProvider('custom', codex)).toBe('codex')
    const { runtime: _runtime, ...manual } = devin
    expect(accountUsageProvider('manual', manual)).toBe('devin')
    expect(accountUsageProvider('manual', { ...manual, command: 'codex-acp', args: [] })).toBe('codex')
    expect(accountUsageProvider('kimi', manual)).toBeUndefined()
    expect(
      accountUsageProvider('custom', { ...codex, env: { DEFAULT_AUTH_REQUEST: 'alternate-login' } }),
    ).toBeUndefined()
    expect(accountUsageProvider('custom', { ...devin, args: ['acp', '--cloud'] })).toBeUndefined()
    expect(accountUsageProvider('custom', { ...devin, command: './devin' })).toBeUndefined()
    expect(accountUsageProvider('custom', { ...agy, command: 'agy-acp' })).toBeUndefined()
    expect(accountUsageProvider('custom', { ...agy, args: ['acp', '--stdio'] }, 'darwin')).toBe('antigravity')
    expect(accountUsageProvider('custom', { ...agy, args: ['acp', '--login'] }, 'darwin')).toBeUndefined()
    const remote = new AccountUsageService(
      { ok: true, seam: { spawn: vi.fn(), resolveExecutable: vi.fn() } },
      () => new Map([['custom', devin]]),
    )
    expect((await remote.read('custom', true)).status).toBe('unsupported')
    expect((await service(new Map([['custom', agy]]), {}, 'win32').read('custom', true)).status).toBe('unsupported')
  })

  it('opens only read-only Codex RPCs on the configured wrapper, returning no account identifiers', async () => {
    const codex = {
      ...devin,
      runtime: 'codex' as const,
      command: '/opt/bin/codex-acp',
      args: [],
      env: { CODEX_HOME: '/profile' },
    }
    const calls: string[] = []
    const p = pipes()
    p.stdin.on('data', (raw) => {
      const msg = JSON.parse(String(raw))
      calls.push(msg.method)
      if (msg.id === undefined) return
      const result =
        msg.id === 1
          ? {}
          : msg.id === 2
            ? { account: { type: 'chatgpt', email: 'hidden', planType: 'pro' } }
            : {
                rateLimits: {
                  secondary: {},
                  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1850000000 },
                  credits: { balance: '0' },
                },
              }
      p.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n')
    })
    const spawn = vi.fn((_spec: AcpSubprocessSpawnSpec) => p)
    const result = await service(new Map([['x', codex]]), { spawn }).read('x', false)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      argv: ['/opt/bin/codex-acp', 'cli', 'app-server'],
      env: codex.env,
    })
    expect(calls).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
    expect(result).toEqual({
      status: 'ready',
      checkedAt: expect.any(Number),
      provider: 'codex',
      plan: 'pro',
      credits: '0',
      windows: [{ key: 'primary', remainingPercent: 0, minutes: 300, resetsAt: 1850000000000 }],
    })
    expect(p.waitForExit).toHaveBeenCalled()
    expect(
      codexFields({ account: { type: 'apiKey' } }, { rateLimits: { credits: { balance: '42' } } }).credits,
    ).toBeNull()
  })

  it.each([
    [{ account: null, requiresOpenaiAuth: true }, 'signin-required'],
    [{ account: null, requiresOpenaiAuth: false }, 'unavailable'],
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, 'unavailable'],
  ] as const)(
    'distinguishes an explicit Codex sign-in requirement from unavailable account data',
    async (account, status) => {
      const codex = { name: 'Codex', command: 'codex-acp', args: [], env: {} }
      const p = pipes()
      const calls: string[] = []
      p.stdin.on('data', (raw) => {
        const message = JSON.parse(String(raw))
        calls.push(message.method)
        if (message.id !== undefined)
          p.stdout.write(JSON.stringify({ id: message.id, result: message.id === 1 ? {} : account }) + '\n')
      })
      expect(await service(new Map([['codex', codex]]), { spawn: () => p }).read('codex', true)).toMatchObject({
        status,
        plan: null,
        credits: null,
        windows: [],
      })
      expect(calls).toEqual(['initialize', 'initialized', 'account/read'])
    },
  )

  it.each([null, 'alternate-default'])('shows every metered window once, default first (limit ID %s)', (limitId) => {
    const account = { account: { type: 'chatgpt', planType: 'pro', email: 'private@example.test' } }
    const base = { limitId, primary: { usedPercent: 2, windowDurationMins: 300 } }
    const extra = {
      limitId: 'extra-meter-id',
      limitName: 'Code Review',
      primary: { usedPercent: 100, windowDurationMins: 1440 },
      secondary: { usedPercent: 0, windowDurationMins: 10080 },
      credits: { balance: '9999' },
      individualLimit: { limit: 'private-spend-limit' },
    }
    const response = codexFields(account, {
      rateLimits: base,
      rateLimitsByLimitId: {
        [limitId ?? 'codex']: base,
        'extra-meter-id': extra,
        'another-alias': extra,
        'private-opaque-meter-id': { limitName: null, secondary: { usedPercent: 3 } },
      },
    })
    expect(response).toEqual({
      plan: 'pro',
      credits: null,
      windows: [
        { key: 'primary', minutes: 300, remainingPercent: 98, resetsAt: null },
        { key: 'primary:1', bucketName: 'Code Review', minutes: 1440, remainingPercent: 0, resetsAt: null },
        { key: 'secondary:1', bucketName: 'Code Review', minutes: 10080, remainingPercent: 100, resetsAt: null },
        { key: 'secondary:2', bucketName: null, minutes: null, remainingPercent: 97, resetsAt: null },
      ],
    })
  })

  it('coalesces reads and drops previous evidence on refresh, profile replacement or removal', async () => {
    const profiles = new Map([['id', devin]])
    const first = pipes(),
      next = pipes(),
      changed = pipes()
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next).mockReturnValueOnce(changed)
    const reader = service(profiles, { spawn })
    const one = reader.read('id', false),
      two = reader.read('id', true)
    first.stdout.end('Email: hidden@example.test\nTier: 1\nPlan: Enterprise\n')
    expect(await one).toEqual(await two)
    expect((await reader.read('id', false)).plan).toBe('Enterprise')
    expect(spawn).toHaveBeenCalledTimes(1)
    const refresh = reader.read('id', true)
    next.stdout.end('Logged in (cached)')
    expect(await refresh).toMatchObject({ status: 'unavailable', plan: null })
    profiles.set('id', { ...devin, env: { XDG_DATA_HOME: '/another' } })
    const again = reader.read('id', false)
    profiles.delete('id')
    changed.stdout.end('Plan: old')
    expect((await again).status).toBe('unsupported')
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(devinPlan('Email: hidden\nPlan: https://id/token\nTier: 3').plan).toBeNull()
  })

  it('stops a pending account pipe on unload and never serves a late result', async () => {
    const p = pipes()
    const reader = service(new Map([['id', devin]]), { spawn: () => p })
    const pending = reader.read('id', true)
    await reader.close()
    expect((await pending).status).toBe('unsupported')
    expect(p.waitForExit).toHaveBeenCalled()
  })

  it('allows unloading after Devin stdout ends but before its process reports an outcome', async () => {
    const p = { ...pipes(), done: new Promise<never>(() => {}) }
    const reader = service(new Map([['id', devin]]), { spawn: () => p })
    const reading = reader.read('id', true)
    const end = new Promise<void>((resolve) => p.stdout.once('end', resolve))
    p.stdout.end('Plan: Enterprise')
    await end
    await reader.close()
    expect((await reading).status).toBe('unsupported')
    expect(p.waitForExit).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'only allocates an agy terminal on demand, merges initialization stages and removes its private socket',
    async () => {
      const started = Promise.withResolvers<AcpAccountTerminalSpec>()
      const terminal = {
        output: new PassThrough(),
        done: new Promise<never>(() => {}),
        terminate: vi.fn(async () => {}),
      }
      const reader = service(new Map([['agy', agy]]), {
        resolveExecutable: async (cmd) => cmd,
        spawnTerminal: async (spec) => {
          started.resolve(spec)
          return terminal
        },
      })
      expect(await reader.read('agy', false)).toMatchObject({ status: 'available', checkedAt: null })
      const reading = reader.read('agy', true)
      const spec = await Promise.race([
        started.promise,
        reading.then((result) => {
          throw new Error('Terminal allocation failed: ' + result.status)
        }),
      ])
      expect(spec.argv.slice(0, 5)).toEqual([
        '/usr/bin/sandbox-exec',
        '-p',
        MACOS_ACCOUNT_SANDBOX,
        agy.command,
        '--settings',
      ])
      expect(spec.env).toMatchObject({ BROWSER: '/usr/bin/false' })
      const socketPath = JSON.parse(spec.argv[5]!).statusLine.command.match(/--unix-socket (\S+) /)?.[1]
      expect(socketPath).toBe(spec.cwd + '/status.sock')
      expect((await lstat(spec.cwd)).mode & 0o777).toBe(0o700)
      const report = (data: object) =>
        new Promise<void>((resolve, reject) => {
          const req = request({ socketPath, path: '/', method: 'POST' }, (res) => {
            res.resume()
            res.on('end', resolve)
          })
          req.on('error', reject)
          req.end(JSON.stringify(data))
        })
      await report({ email: 'private', plan_tier: null, quota: {} })
      await report({
        email: 'private',
        quota: { weekly: { remaining_fraction: 0.5, reset_time: '2026-11-28T00:00:00Z' } },
      })
      await report({ plan_tier: 'Pro' })
      expect(await reading).toEqual({
        status: 'ready',
        provider: 'antigravity',
        checkedAt: expect.any(Number),
        plan: 'Pro',
        credits: null,
        windows: [{ key: 'weekly', remainingPercent: 50, minutes: null, resetsAt: Date.parse('2026-11-28T00:00:00Z') }],
      })
      expect(terminal.terminate).toHaveBeenCalledOnce()
      await expect(lstat(spec.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
