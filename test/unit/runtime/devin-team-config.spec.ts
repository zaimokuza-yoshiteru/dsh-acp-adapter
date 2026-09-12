import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareDevinTeamConfig } from '../../../src/host/teams/devin-config.ts'

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
