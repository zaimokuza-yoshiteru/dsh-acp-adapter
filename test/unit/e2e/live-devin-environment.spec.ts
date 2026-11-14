import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareLiveDevinEnvironment } from '../../e2e/live-devin-environment.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('isolates existing authentication, MCP config, home and history, then removes the credential copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devin-auth-source-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const credentials = join(home, '.local', 'share', 'devin', 'credentials.toml')
  await mkdir(dirname(credentials), { recursive: true })
  await writeFile(credentials, 'synthetic test credential')
  await writeFile(join(dirname(credentials), 'history.sqlite'), 'unrelated history')
  const live = await prepareLiveDevinEnvironment(
    'existing',
    { HOME: home, CUSTOM_FIXTURE: 'preserved' },
    {
      platform: 'darwin',
      home,
      environment: {},
    },
  )
  cleanups.push(live.dispose)
  expect(live.env.HOME).not.toBe(home)
  expect(live.env.XDG_CONFIG_HOME).not.toContain(home)
  expect(live.env.CUSTOM_FIXTURE).toBe('preserved')
  expect(live.env.TMPDIR).toBe(live.env.TEMP)
  expect(live.env.TMPDIR).toBe(live.env.TMP)
  expect(await readdir(live.env.TMPDIR)).toEqual([])
  if (process.platform !== 'win32') expect((await stat(live.env.TMPDIR)).mode & 0o777).toBe(0o700)
  const copy = join(live.env.XDG_DATA_HOME, 'devin', 'credentials.toml')
  expect(await readdir(dirname(copy))).toEqual(['credentials.toml'])
  expect(await readFile(copy, 'utf8')).toBe('synthetic test credential')
  await live.dispose()
  await expect(stat(copy)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(live.env.TMPDIR)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(credentials, 'utf8')).toBe('synthetic test credential')
})

it('requires explicit auth and isolates token-only runs without discovering the user credential store', async () => {
  await expect(prepareLiveDevinEnvironment(undefined, {})).rejects.toThrow('LIVE_CONFIG_TOKEN_REQUIRED')
  await expect(prepareLiveDevinEnvironment('unsupported', {})).rejects.toThrow('LIVE_AUTH_MODE_INVALID')
  const live = await prepareLiveDevinEnvironment(
    undefined,
    { WINDSURF_API_KEY: 'synthetic' },
    {
      platform: 'darwin',
      home: '/unavailable-test-home',
      environment: {},
    },
  )
  cleanups.push(live.dispose)
  expect(live.env.WINDSURF_API_KEY).toBe('synthetic')
  expect(live.env.XDG_DATA_HOME).not.toContain('unavailable-test-home')
  await expect(stat(join(live.env.XDG_DATA_HOME, 'devin', 'credentials.toml'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

async function manualConfiguration() {
  const live = await prepareLiveDevinEnvironment(undefined, { WINDSURF_API_KEY: 'synthetic' })
  cleanups.push(live.dispose)
  const cwd = await mkdtemp(join(tmpdir(), 'devin-manual-workspace-'))
  cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const config = join(live.env.XDG_CONFIG_HOME, 'devin', 'mcp_config.json')
  await mkdir(dirname(config), { recursive: true })
  return { live, cwd, config }
}

it('requires no native MCP entry for the session-scoped DSH server', async () => {
  const f = await manualConfiguration()
  await expect(f.live.assertIsolatedSessionMcp(f.cwd)).resolves.toBeUndefined()
  await expect(stat(f.config)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(f.config, JSON.stringify({ mcpServers: {} }))
  await expect(f.live.assertIsolatedSessionMcp(f.cwd)).resolves.toBeUndefined()
})

it.each([
  'global-server',
  'legacy-dsh-server',
  'project-server',
  'config-import',
  'mcp-config-import',
  'invalid-config',
])('rejects the manual title prerequisite with %s without exposing configuration content', async (kind) => {
  const f = await manualConfiguration()
  if (kind === 'global-server' || kind === 'legacy-dsh-server')
    await writeFile(
      f.config,
      JSON.stringify({ mcpServers: { [kind === 'global-server' ? 'foreign' : 'dsh']: { command: 'private' } } }),
    )
  if (kind === 'project-server' || kind === 'config-import') {
    await mkdir(join(f.cwd, '.devin'), { recursive: true })
    await writeFile(
      join(f.cwd, '.devin', kind === 'project-server' ? 'mcp_config.json' : 'config.json'),
      JSON.stringify(
        kind === 'project-server' ? { mcpServers: { dsh: { command: 'private' } } } : { read_config_from: 'private' },
      ),
    )
  }
  if (kind === 'mcp-config-import') await writeFile(f.config, JSON.stringify({ read_config_from: 'private' }))
  if (kind === 'invalid-config') await writeFile(f.config, 'private invalid configuration')
  await expect(f.live.assertIsolatedSessionMcp(f.cwd)).rejects.toThrow(/^LIVE_DEVIN_MANUAL_/)
})
