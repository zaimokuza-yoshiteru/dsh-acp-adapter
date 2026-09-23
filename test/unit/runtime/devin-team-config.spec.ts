import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDevinMcp } from '../../../src/host/teams/devin-config.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) => String(args[0]).replaceAll('\\', '/').includes('/lib/runtime/session/dsh-mcp-launcher.mjs')
    ? Promise.resolve(Buffer.from('// bundled launcher fixture')) : fs.readFile(...args) }
})
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'devin-registration-')); roots.push(home)
  let entry: string | undefined
  let effectiveOverride: string | undefined
  const argv: string[][] = []
  const subprocess: SubprocessSeam = {
    resolveExecutable: async command => command,
    spawn(spec) {
      argv.push([...spec.argv])
      const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough()
      const done = new Promise<{ exitCode: number; signal: null }>(resolve => setTimeout(() => {
        let exitCode = 0
        if (spec.argv.includes('get')) {
          if (entry === undefined) { stderr.write("Error: Server 'dsh' not found"); exitCode = 1 }
          else stdout.write(effectiveOverride ?? entry)
        } else {
          entry = `Server: dsh\n    Command: ${spec.argv.slice(spec.argv.indexOf('--') + 1).join(' ')}\n    Env: ELECTRON_RUN_AS_NODE=<redacted>\n`
        }
        stdout.end(); stderr.end(); resolve({ exitCode, signal: null })
      }, 5))
      return { stdin, stdout, stderr, done, terminate() {}, waitForExit: async () => { await done; return true } }
    },
  }
  const lease = {
    signal: new AbortController().signal,
    servers: [{ name: 'dsh', type: 'http' as const, url: 'http://127.0.0.1:1234/private', headers: [] }],
    instructions: 'Tools belong to this session',
    beginPrompt: vi.fn(), endPrompt: vi.fn(), permission: vi.fn(), presentTool: vi.fn(),
    close: vi.fn(async () => {}),
  }
  const options = { subprocess, command: 'devin', args: ['acp'], cwd: home, env: { HOME: home }, lease }
  return { home, argv, lease, options, setEntry: (value: string) => { entry = value },
    overrideAfterWrite: (value: string) => { effectiveOverride = value } }
}

it('refuses a higher-priority effective server after user-scope registration', async () => {
  const { options, lease, overrideAfterWrite } = await setup()
  overrideAfterWrite('Server: dsh\n    Command: other-server\n')
  await expect(prepareDevinMcp(options)).rejects.toThrow('effective dsh MCP entry conflicts')
  expect(lease.close).toHaveBeenCalledOnce()
})

it('refuses an effective entry that hardcodes another connection address', async () => {
  const { options, home, overrideAfterWrite } = await setup()
  overrideAfterWrite(`Server: dsh\n    Command: ${process.execPath} ${join(home, '.dsh/acp/mcp/dsh-mcp-launcher.mjs')}\n    Env: DSH_ACP_TEAM_MCP_URL=<redacted>\n`)
  await expect(prepareDevinMcp(options)).rejects.toThrow('effective dsh MCP entry conflicts')
})

it('registers one persistent entry and keeps session endpoint out of native config and CLI argv', async () => {
  const { options, argv, lease, home } = await setup()
  const prepared = await prepareDevinMcp(options)
  expect(argv.find(args => args.includes('add'))).toEqual(['devin', 'mcp', 'add', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', 'dsh', '--', process.execPath, join(home, '.dsh/acp/mcp/dsh-mcp-launcher.mjs')])
  expect(JSON.stringify(argv)).not.toContain('/private')
  expect(prepared.env).toEqual({ HOME: home, DSH_ACP_TEAM_MCP_URL: lease.servers[0]!.url })
  expect(prepared.lease.servers).toEqual([])
  expect(prepared.lease.beginPrompt).toBe(lease.beginPrompt)
  expect(prepared.lease.permission).toBe(lease.permission)
  expect(prepared.lease.presentTool).toBe(lease.presentTool)
  await prepared.lease.close(); await prepared.lease.close()
  expect(lease.close).toHaveBeenCalledOnce()
  expect(await readFile(join(home, '.dsh/acp/mcp/dsh-mcp-launcher.mjs'), 'utf8')).toContain('launcher')
})

it('serializes concurrent sessions updating the same entry without mixing their endpoints', async () => {
  const { options, argv } = await setup()
  const sessions = await Promise.all(Array.from({ length: 10 }, (_, index) => prepareDevinMcp({ ...options, lease: { ...options.lease, servers: [{ ...options.lease.servers[0]!, url: `http://127.0.0.1:1234/session-${index}` }] } })))
  const registrations = argv.filter(args => args.includes('add'))
  expect(registrations).toHaveLength(10)
  expect(new Set(registrations.map(args => JSON.stringify(args))).size).toBe(1)
  expect(new Set(sessions.map(item => item.env.DSH_ACP_TEAM_MCP_URL)).size).toBe(10)
})

it.each(['', '    Env: ELECTRON_RUN_AS_NODE=<redacted>\n'])('reapplies Node mode when the command already matches and env is absent or redacted (%j)', async envOutput => {
  const { options, argv, home, setEntry } = await setup()
  setEntry(`Server: dsh\n    Command: ${process.execPath} ${join(home, '.dsh/acp/mcp/dsh-mcp-launcher.mjs')}\n${envOutput}`)
  await prepareDevinMcp(options)
  const registrations = argv.filter(args => args.includes('add'))
  expect(registrations).toHaveLength(1)
  expect(registrations[0]).toContain('ELECTRON_RUN_AS_NODE=1')
})

it('does not overwrite an unrelated dsh server and closes a failed lease', async () => {
  const { options, argv, lease, setEntry } = await setup()
  setEntry('Server: dsh\n    URL: https://example.org/mcp\n')
  await expect(prepareDevinMcp(options)).rejects.toThrow('unrelated MCP server')
  expect(argv.some(args => args.includes('add'))).toBe(false)
  expect(lease.close).toHaveBeenCalledOnce()
})

it('updates its Node executable after an installation changes, retaining one entry', async () => {
  const { options, argv, home, setEntry } = await setup()
  setEntry(`Server: dsh\n    Command: /old/node ${join(home, '.dsh/acp/mcp/dsh-mcp-launcher.mjs')}\n`)
  await prepareDevinMcp(options)
  expect(argv.filter(args => args.includes('add'))).toHaveLength(1)
})

it('waits for another process and recovers its registration lock after a crash', async () => {
  const { options, argv, home } = await setup()
  const directory = join(home, '.dsh/acp/mcp')
  await mkdir(directory, { recursive: true })
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    join(directory, 'registration.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(child, 'close')
  try {
    await once(child.stdout!, 'data')
    const pending = prepareDevinMcp(options)
    await delay(150)
    expect(argv).toHaveLength(0)
    child.kill('SIGKILL')
    await closed
    const prepared = await pending
    expect(argv.filter(args => args.includes('add'))).toHaveLength(1)
    await prepared.lease.close()
  } finally { child.kill('SIGKILL'); await closed }
})
