import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, stat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'This check must run on Windows')
const { prepareDevinTeamConfig } = await import(pathToFileURL(resolve(process.argv[2])).href)
const root = await mkdtemp(join(process.cwd(), 'ordinary-user-'))
let prepared
let closed = 0
try {
  const source = join(root, 'config')
  await mkdir(join(source, 'devin', 'data'), { recursive: true })
  const settings = join(source, 'devin', 'config.json')
  await writeFile(settings, '{"permissions":{}}')
  await writeFile(join(source, 'devin', '.devin-migration-complete'), 'done')
  const mcp = '{"mcpServers":{"existing":{"command":"fixture"}}}'
  await writeFile(join(source, 'devin', 'mcp_config.json'), mcp)
  // Prove this process cannot create file symlinks; an elevated runner passing
  // the functional checks alone must not count as ordinary-user coverage.
  await assert.rejects(symlink(settings, join(root, 'must-be-denied'), 'file'), error => ['EPERM', 'EACCES'].includes(error.code))
  prepared = await prepareDevinTeamConfig({ XDG_CONFIG_HOME: source }, {
    signal: new AbortController().signal,
    servers: [{ name: 'team', type: 'http', url: 'http://127.0.0.1:43210/fixture', headers: [] }],
    beginPrompt() {}, endPrompt() {}, permission() {}, async close() { closed++ },
  })
  const overlay = prepared.env.XDG_CONFIG_HOME
  const linked = join(overlay, 'devin', 'config.json')
  assert.equal((await lstat(linked)).isSymbolicLink(), false)
  assert.equal((await stat(settings)).nlink, 2)
  await writeFile(linked, '{"permissions":{"saved":true}}')
  assert.equal(await readFile(settings, 'utf8'), '{"permissions":{"saved":true}}')
  await writeFile(join(overlay, 'devin', 'data', 'saved'), 'persisted')
  assert.equal(await readFile(join(source, 'devin', 'data', 'saved'), 'utf8'), 'persisted')
  assert.equal(await readFile(join(source, 'devin', 'mcp_config.json'), 'utf8'), mcp)
  assert.ok(JSON.parse(await readFile(join(overlay, 'devin', 'mcp_config.json'), 'utf8')).mcpServers.team)
  await prepared.lease.close()
  await prepared.lease.close()
  assert.equal(closed, 1)
  await assert.rejects(stat(overlay), { code: 'ENOENT' })
  assert.equal((await stat(settings)).nlink, 1)
  assert.equal(await readFile(join(source, 'devin', 'data', 'saved'), 'utf8'), 'persisted')
  console.log('PASS: file symlinks denied; hard-link fallback, directory junctions, MCP isolation and cleanup verified')
} finally {
  await prepared?.lease.close()
  await rm(root, { recursive: true, force: true })
}
