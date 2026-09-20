/** Exercise configuration discovery in the real Devin executable, without an account or model call. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { prepareDevinTeamConfig } from '../src/host/teams/devin-config.ts'

const executable = process.argv[2]
assert.ok(executable, 'Pass the real Devin executable path')
const root = await mkdtemp(join(tmpdir(), 'dsh-real-devin-'))
let prepared: Awaited<ReturnType<typeof prepareDevinTeamConfig>> | undefined

async function initialize(env: NodeJS.ProcessEnv): Promise<{ _meta?: { mcpConfigPath?: string } }> {
  const child = spawn(executable!, ['acp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>(done => child.once('close', () => done()))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  try {
    return await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Devin initialize timed out')), 20_000)
      const finish = (error?: Error, value?: { _meta?: { mcpConfigPath?: string } }) => {
        clearTimeout(timeout)
        if (error) reject(error)
        else done(value!)
      }
      child.once('error', error => finish(error))
      child.stdin.once('error', error => finish(error))
      child.once('exit', code => finish(new Error(`Devin exited before initialize: ${code}`)))
      lines.on('line', line => {
        let message
        try { message = JSON.parse(line) } catch { return }
        if (message.id !== 1) return
        if (message.error) finish(new Error(`Devin initialize error: ${JSON.stringify(message.error)}`))
        else finish(undefined, message.result)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-mcp-discovery-test', version: '1' },
      } }) + '\n')
    })
  } finally {
    child.kill('SIGKILL')
    await closed
    lines.close()
  }
}

try {
  const source = join(root, 'config')
  await mkdir(join(source, 'devin'), { recursive: true })
  await writeFile(join(source, 'devin', 'config.json'), '{}')
  const sourceEnv = {
    XDG_CONFIG_HOME: source, APPDATA: source,
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  }
  const baseline = await initialize({ ...process.env, ...sourceEnv })
  prepared = await prepareDevinTeamConfig(sourceEnv, {
    signal: new AbortController().signal,
    servers: [{ type: 'http', name: 'dshteam_discovery_test', url: 'http://127.0.0.1:43210/test', headers: [] }],
    beginPrompt() {}, endPrompt() {}, permission: () => undefined, async close() {},
  })
  const result = await initialize({ ...process.env, ...prepared.env })
  const expected = join(prepared.env.XDG_CONFIG_HOME!, 'devin', 'mcp_config.json')
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch,
    sourceConfigHome: source,
    baseline: baseline._meta?.mcpConfigPath,
    overlayConfigHome: prepared.env.XDG_CONFIG_HOME,
    expected, discovered: result._meta?.mcpConfigPath,
    scope: 'ACP initialize only; no authentication, model request, or MCP tool call',
  }))
  assert.ok(result._meta?.mcpConfigPath, 'Real Devin must report its MCP config path')
  assert.equal(resolve(result._meta?.mcpConfigPath ?? ''), resolve(expected), 'Real Devin must load the injected MCP file')
  console.log('PASS: real Devin ACP reports the isolated MCP config')
} finally {
  await prepared?.lease.close()
  await rm(root, { recursive: true, force: true })
}
