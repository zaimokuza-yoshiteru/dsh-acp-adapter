import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpAgentId, AcpStubAgentConfig } from '../../../src/contract/agent-config.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { prepareAgentLaunch } from '../../../src/host/composition/agent-launch.ts'
import { acpLaunchFingerprint, profileLaunchIdentityHash } from '../../../src/domain/session/launch-fingerprint.ts'

let originalEnvironment = process.env
beforeEach(() => {
  originalEnvironment = process.env
  // Windows' native env object aliases key casing. A plain dictionary models
  // both routing keys independently without mutating that original object.
  process.env = { ...originalEnvironment }
  for (const name of ['http', 'https', 'all', 'no', 'ftp', 'ws', 'wss']) {
    vi.stubEnv(`${name}_proxy`, undefined)
    vi.stubEnv(`${name.toUpperCase()}_PROXY`, undefined)
  }
  vi.stubEnv('REQUEST_METHOD', undefined)
})
afterEach(() => {
  try {
    vi.unstubAllEnvs()
  } finally {
    process.env = originalEnvironment
  }
})

const subprocess: SubprocessSeam = {
  spawn: () => {
    throw new Error('Launch preparation must not spawn an Agent')
  },
  resolveExecutable: async (command) => command,
}
const config = (env: Record<string, string> = {}): AcpStubAgentConfig => ({
  name: 'Work Codex',
  command: 'custom-codex-acp',
  args: ['--acp'],
  runtime: 'codex',
  env,
})
const prepare = (profile: AcpStubAgentConfig, runtime: AcpAgentId | undefined = 'codex') =>
  prepareAgentLaunch(runtime, profile, '/workspace', subprocess, undefined)

describe('Codex subprocess loopback MCP routing', () => {
  it('adds only the trusted MCP IP to both routing keys before MCP discovery exists', async () => {
    const profile = config()
    const before = structuredClone(profile)
    const createMcpLease = vi.fn(async () => undefined)
    const launch = await prepareAgentLaunch('codex', profile, '/workspace', subprocess, createMcpLease)
    expect(launch.env).toEqual({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' })
    expect(launch.spawnPlan?.env).toEqual(launch.env)
    expect(launch.argv).toEqual(['custom-codex-acp', '--acp'])
    expect(createMcpLease).not.toHaveBeenCalled()
    expect(profile).toEqual(before)
  })

  it.each(['NO_PROXY', 'no_proxy'] as const)('preserves a sole inherited %s list in both cases', async (key) => {
    vi.stubEnv(key, 'intranet.example,.private.example,10.0.0.0/8')
    const expected = 'intranet.example,.private.example,10.0.0.0/8,127.0.0.1'
    expect((await prepare(config())).env).toEqual({ NO_PROXY: expected, no_proxy: expected })
  })

  it('unions both effective parent lists so neither case shadows external exclusions', async () => {
    vi.stubEnv('NO_PROXY', 'UPPER.internal,127.0.0.1')
    vi.stubEnv('no_proxy', '.lower.internal,UPPER.internal')
    const expected = 'UPPER.internal,127.0.0.1,.lower.internal'
    expect((await prepare(config())).env).toEqual({ NO_PROXY: expected, no_proxy: expected })
  })

  it.each(['NO_PROXY', 'no_proxy'] as const)(
    'retains a sole profile %s override and the other inherited case',
    async (key) => {
      const other = key === 'NO_PROXY' ? 'no_proxy' : 'NO_PROXY'
      vi.stubEnv(key, 'superseded.internal')
      vi.stubEnv(other, 'retained.internal')
      const launch = await prepare(config({ [key]: 'profile.internal' }))
      const items = launch.env.NO_PROXY!.split(',')
      expect(new Set(items)).toEqual(new Set(['profile.internal', 'retained.internal', '127.0.0.1']))
      expect(launch.env.no_proxy).toBe(launch.env.NO_PROXY)
      expect(items).not.toContain('superseded.internal')
    },
  )

  it('lets explicit profile values win for both keys without mutating their configured identity', async () => {
    vi.stubEnv('NO_PROXY', 'old-upper.internal')
    vi.stubEnv('no_proxy', 'old-lower.internal')
    const profile = config({ NO_PROXY: 'profile-upper.internal', no_proxy: 'profile-lower.internal' })
    const identity = acpLaunchFingerprint({ profileId: 'work-codex', config: profile })
    const launch = await prepare(profile)
    const expected = 'profile-upper.internal,profile-lower.internal,127.0.0.1'
    expect(launch.env).toEqual({ NO_PROXY: expected, no_proxy: expected })
    expect(profile.env).toEqual({ NO_PROXY: 'profile-upper.internal', no_proxy: 'profile-lower.internal' })
    expect(acpLaunchFingerprint({ profileId: 'work-codex', config: profile })).toEqual(identity)
  })

  it('keeps wildcard and domain exclusions without extending the automatic bypass to other hosts', async () => {
    vi.stubEnv('NO_PROXY', ' *.corp.internal,*,127.0.0.1, ')
    const launch = await prepare(config())
    expect(launch.env).toEqual({ NO_PROXY: '*.corp.internal,*,127.0.0.1', no_proxy: '*.corp.internal,*,127.0.0.1' })
    expect(launch.env.NO_PROXY).not.toContain('localhost')
    expect(launch.env.NO_PROXY).not.toContain('::1')
  })

  it('respects explicit empty overrides without restoring the overridden parent exclusions', async () => {
    vi.stubEnv('NO_PROXY', 'overridden.internal')
    vi.stubEnv('no_proxy', 'also-overridden.internal')
    expect((await prepare(config({ NO_PROXY: '', no_proxy: '' }))).env).toEqual({
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    })
  })

  it('copies no other parent routing, credential or state keys and preserves explicit profile overrides', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://parent-proxy.invalid')
    vi.stubEnv('HTTP_PROXY', 'http://parent-http.invalid')
    vi.stubEnv('ALL_PROXY', 'socks5://parent-socks.invalid')
    vi.stubEnv('UNRELATED_TOKEN', 'parent-secret-never-forward')
    vi.stubEnv('CODEX_HOME', '/parent/codex')
    const profile = config({ HTTPS_PROXY: 'http://profile-proxy.invalid', PROFILE_ONLY: 'yes' })
    expect((await prepare(profile)).env).toEqual({
      ...profile.env,
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    })
    expect(process.env.HTTPS_PROXY).toBe('http://parent-proxy.invalid')
    expect(process.env.NO_PROXY).toBeUndefined()
    expect(process.env.no_proxy).toBeUndefined()
  })

  it('keeps inherited routing out of launch identity while retaining native state identity', async () => {
    const profile = config()
    const first = { HOME: '/stable-home', CODEX_HOME: '/stable-codex', NO_PROXY: 'first.internal' }
    const second = { ...first, NO_PROXY: 'second.internal', no_proxy: '*.internal' }
    expect(profileLaunchIdentityHash('work-codex', profile, first)).toBe(
      profileLaunchIdentityHash('work-codex', profile, second),
    )
    expect(acpLaunchFingerprint({ profileId: 'work-codex', config: profile, env: first })).toEqual(
      acpLaunchFingerprint({ profileId: 'work-codex', config: profile, env: second }),
    )
    expect(profileLaunchIdentityHash('work-codex', profile, first)).not.toBe(
      profileLaunchIdentityHash('work-codex', profile, { ...second, CODEX_HOME: '/other-codex' }),
    )
  })

  it.each(['devin', 'claude', 'kimi', 'codebuddy', undefined] as const)(
    'leaves runtime %s environment unchanged',
    async (runtime) => {
      vi.stubEnv('NO_PROXY', 'parent.internal')
      const profile = config({ NO_PROXY: 'profile.internal', no_proxy: 'profile-lower.internal', KEEP: 'yes' })
      const launch = await prepareAgentLaunch(runtime, profile, '/workspace', subprocess, undefined)
      expect(launch.env).toEqual(profile.env)
    },
  )
})

describe('Antigravity local harness routing', () => {
  it('preserves implicit OS proxy discovery when there is no explicit proxy environment', async () => {
    const profile = config({ ANTIGRAVITY_HARNESS_PATH: '/official/localharness_external' })
    expect((await prepare(profile, 'antigravity')).env).toEqual(profile.env)
  })

  it.each([
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'WS_PROXY',
    'ws_proxy',
    'WSS_PROXY',
    'wss_proxy',
  ])('recognizes an existing %s route without copying or replacing its value', async (key) => {
    vi.stubEnv(key, 'http://existing-proxy.invalid')
    expect((await prepare(config(), 'antigravity')).env).toEqual({
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    })
    expect(process.env[key]).toBe('http://existing-proxy.invalid')
  })

  it('does not treat Python-ignored uppercase CGI HTTP_PROXY as an explicit route', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://cgi-proxy.invalid')
    vi.stubEnv('REQUEST_METHOD', 'GET')
    expect((await prepare(config(), 'antigravity')).env).toEqual({})
    vi.stubEnv('http_proxy', 'http://explicit-lowercase.invalid')
    expect((await prepare(config(), 'antigravity')).env).toEqual({
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    })
  })

  it('honors an empty lowercase override of an inherited uppercase proxy', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://superseded.invalid')
    const profile = config({ https_proxy: '' })
    expect((await prepare(profile, 'antigravity')).env).toEqual(profile.env)
  })

  it('exempts only the two hosts used by the official local harness when proxy routing is explicit', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://existing-proxy.invalid')
    const profile = { ...config(), name: 'Official Antigravity', runtime: 'antigravity' as const }
    const before = structuredClone(profile)
    const identity = acpLaunchFingerprint({ profileId: 'antigravity', config: profile })
    const launch = await prepare(profile, 'antigravity')
    expect(launch.env).toEqual({ NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' })
    expect(launch.spawnPlan?.env).toEqual(launch.env)
    expect(profile).toEqual(before)
    expect(acpLaunchFingerprint({ profileId: 'antigravity', config: profile })).toEqual(identity)
    expect(process.env.NO_PROXY).toBeUndefined()
    expect(process.env.no_proxy).toBeUndefined()
  })

  it('retains effective exclusions and explicit external proxy configuration without forwarding credentials', async () => {
    vi.stubEnv('NO_PROXY', 'superseded.internal')
    vi.stubEnv('no_proxy', '.retained.internal')
    vi.stubEnv('UNRELATED_TOKEN', 'parent-secret-never-forward')
    vi.stubEnv('HTTPS_PROXY', 'http://parent-proxy.invalid')
    const profile = config({
      NO_PROXY: 'profile.internal,localhost',
      HTTPS_PROXY: 'http://profile-proxy.invalid',
      ALL_PROXY: 'socks5://profile-socks.invalid',
      ANTIGRAVITY_HARNESS_PATH: '/official/localharness_external',
    })
    const expected = 'profile.internal,localhost,.retained.internal,127.0.0.1'
    const launch = await prepare(profile, 'antigravity')
    expect(launch.env).toEqual({ ...profile.env, NO_PROXY: expected, no_proxy: expected })
    expect(launch.env).not.toHaveProperty('UNRELATED_TOKEN')
    expect(process.env.HTTPS_PROXY).toBe('http://parent-proxy.invalid')
  })

  it('does not duplicate existing local hosts or add a wider loopback network exemption', async () => {
    vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1,.corp.internal')
    vi.stubEnv('no_proxy', '127.0.0.1, localhost')
    const expected = 'localhost,127.0.0.1,.corp.internal'
    expect((await prepare(config(), 'antigravity')).env).toEqual({ NO_PROXY: expected, no_proxy: expected })
  })

  it('preserves explicit empty overrides and keeps generic profiles untouched', async () => {
    vi.stubEnv('NO_PROXY', 'overridden.internal')
    vi.stubEnv('no_proxy', 'also-overridden.internal')
    const profile = { ...config({ NO_PROXY: '', no_proxy: '' }), runtime: 'antigravity' as const }
    expect((await prepare(profile, 'antigravity')).env).toEqual(profile.env)
    const generic = await prepareAgentLaunch(undefined, profile, '/workspace', subprocess, undefined)
    expect(generic.env).toEqual(profile.env)
  })
})
