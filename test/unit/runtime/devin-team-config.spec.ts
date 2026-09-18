import { link, lstat, mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDevinTeamConfig } from '../../../src/host/teams/devin-config.ts'

const failures = vi.hoisted(() => ({ symlink: '', link: '', type: 'file', roots: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const root = await fs.mkdtemp(...args)
      if (String(args[0]).includes('dsh-acp-team-')) failures.roots.push(String(root))
      return root
    },
    symlink: async (...args: Parameters<typeof fs.symlink>) => {
      if (failures.symlink && args[2] === failures.type) throw Object.assign(new Error('symlink denied'), { code: failures.symlink })
      return fs.symlink(...args)
    },
    link: vi.fn(async (...args: Parameters<typeof fs.link>) => {
      if (failures.link) throw Object.assign(new Error('hard link denied'), { code: failures.link })
      return fs.link(...args)
    }),
  }
})
afterEach(() => { failures.symlink = ''; failures.link = ''; failures.type = 'file'; failures.roots.length = 0; vi.clearAllMocks() })

async function withPlatform(platform: string, action: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try { await action() } finally { Object.defineProperty(process, 'platform', original) }
}

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), 'devin-config-test-'))
  await mkdir(join(source, 'devin'))
  await writeFile(join(source, 'devin/config.json'), '{"permissions":{}}')
  await writeFile(join(source, 'devin/mcp_config.json'), '{"mcpServers":{"user":{"command":"user-tool"}}}')
  const lease = {
    signal: new AbortController().signal,
    servers: [{ name: 'team', type: 'http' as const, url: 'http://127.0.0.1:1234/private', headers: [] }],
    beginPrompt() {}, endPrompt() {}, permission: () => undefined, close: vi.fn(async () => {}),
  }
  return { source, lease }
}

it.each(['EPERM', 'EACCES'])('falls back to a shared file hard link on Windows %s, keeping MCP isolated', async code => {
  const { source, lease } = await fixture()
  let prepared: Awaited<ReturnType<typeof prepareDevinTeamConfig>> | undefined
  try {
    failures.symlink = code
    await withPlatform('win32', async () => {
      prepared = await prepareDevinTeamConfig({ XDG_CONFIG_HOME: source }, lease)
    })
    const original = join(source, 'devin/config.json')
    const linked = join(prepared!.env.XDG_CONFIG_HOME!, 'devin/config.json')
    expect((await lstat(linked)).isSymbolicLink()).toBe(false)
    expect((await stat(original)).nlink).toBe(2)
    await writeFile(linked, '{"permissions":{"saved":true}}')
    expect(await readFile(original, 'utf8')).toBe('{"permissions":{"saved":true}}')
    expect(JSON.parse(await readFile(join(source, 'devin/mcp_config.json'), 'utf8')).mcpServers).not.toHaveProperty('team')
    expect(JSON.parse(await readFile(join(prepared!.env.XDG_CONFIG_HOME!, 'devin/mcp_config.json'), 'utf8')).mcpServers).toHaveProperty('team')
    expect(link).toHaveBeenCalledTimes(1)
    await prepared!.lease.close()
    expect((await stat(original)).nlink).toBe(1)
    expect(await readFile(original, 'utf8')).toBe('{"permissions":{"saved":true}}')
    expect(lease.close).toHaveBeenCalledOnce()
  } finally { await prepared?.lease.close(); await rm(source, { recursive: true, force: true }) }
})

it.each(['EXDEV', 'EACCES'])('reports hard-link failure %s and cleans the failed preparation without copying', async code => {
  const { source, lease } = await fixture()
  try {
    failures.symlink = 'EPERM'; failures.link = code
    await withPlatform('win32', async () => {
      await expect(prepareDevinTeamConfig({ XDG_CONFIG_HOME: source }, lease)).rejects.toMatchObject({ code, message: expect.stringContaining('hard-link fallback failed') })
    })
    expect(lease.close).toHaveBeenCalledOnce()
    await expect(stat(failures.roots.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'devin/config.json'), 'utf8')).toBe('{"permissions":{}}')
  } finally { await rm(source, { recursive: true, force: true }) }
})

it.each([
  ['darwin', 'EPERM', 'file'],
  ['win32', 'EIO', 'file'],
  ['win32', 'EPERM', 'junction'],
])('does not fallback for platform=%s error=%s type=%s', async (platform, code, type) => {
  const { source, lease } = await fixture()
  try {
    if (type === 'junction') await mkdir(join(source, 'sibling'))
    failures.symlink = code; failures.type = type
    await withPlatform(platform!, async () => {
      await expect(prepareDevinTeamConfig({ XDG_CONFIG_HOME: source }, lease)).rejects.toMatchObject({ code })
    })
    expect(link).not.toHaveBeenCalled()
    expect(lease.close).toHaveBeenCalledOnce()
  } finally { await rm(source, { recursive: true, force: true }) }
})

it('isolates the Team endpoint, preserves existing MCP tools and native settings writes, and removes only the overlay', async () => {
  const source = await mkdtemp(join(tmpdir(), 'devin-config-test-'))
  const close = vi.fn(async () => {})
  let prepared
  try {
    await mkdir(join(source, 'devin'))
    await writeFile(join(source, 'devin/config.json'), '{"permissions":{}}')
    const original = JSON.stringify({ mcpServers: { user: { command: 'user-tool' } }, other: true })
    await writeFile(join(source, 'devin/mcp_config.json'), original)
    prepared = await prepareDevinTeamConfig({ XDG_CONFIG_HOME: source }, {
      signal: new AbortController().signal,
      servers: [{ name: 'team', type: 'http', url: 'http://127.0.0.1:1234/private', headers: [] }],
      beginPrompt() {}, endPrompt() {}, permission: () => undefined, close,
    })
    const root = prepared.env.XDG_CONFIG_HOME!
    expect(JSON.parse(await readFile(join(root, 'devin/mcp_config.json'), 'utf8'))).toMatchObject({ other: true, mcpServers: { user: { command: 'user-tool' }, team: { url: 'http://127.0.0.1:1234/private' } } })
    expect(await readFile(join(source, 'devin/mcp_config.json'), 'utf8')).toBe(original)
    await writeFile(join(root, 'devin/config.json'), '{"permissions":{"saved":true}}')
    expect(JSON.parse(await readFile(join(source, 'devin/config.json'), 'utf8'))).toEqual({ permissions: { saved: true } })
    expect(prepared.lease.servers).toEqual([])
    await prepared.lease.close()
    await prepared.lease.close()
    expect(close).toHaveBeenCalledTimes(1)
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'devin/mcp_config.json'), 'utf8')).toBe(original)
  } finally { await prepared?.lease.close(); await rm(source, { recursive: true, force: true }) }
})
