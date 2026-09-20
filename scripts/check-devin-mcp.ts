/** Verify real Devin config contents via ACP's built-in /mcp command. No login or model call. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { prepareDevinTeamConfig } from '../src/host/teams/devin-config.ts'

const executable = process.argv[2]
assert.ok(executable, 'Pass the real Devin executable path')
const root = await mkdtemp(join(tmpdir(), 'dsh-real-devin-'))
let prepared: Awaited<ReturnType<typeof prepareDevinTeamConfig>> | undefined
let nativeFile: string | undefined
let originalNativeFile: Buffer | undefined
let nativeFileWritten = false

interface Inspection { _meta?: { mcpConfigPath?: string }; mcpListing: string }

async function inspectMcp(env: NodeJS.ProcessEnv): Promise<Inspection> {
  const child = spawn(executable!, ['acp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>(done => child.once('close', () => done()))
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  try {
    return await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Devin config inspection timed out')), 30_000)
      const result: Inspection = { mcpListing: '' }
      const send = (id: number, method: string, params: object) => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      }
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        if (error) reject(error)
        else done(result)
      }
      child.once('error', error => finish(error))
      child.stdin.once('error', error => finish(error))
      child.once('exit', code => finish(new Error(`Devin exited before inspection: ${code}`)))
      lines.on('line', line => {
        let message
        try { message = JSON.parse(line) } catch { return }
        if (message.method === 'session/update') {
          const update = message.params?.update
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') result.mcpListing += update.content.text
          return
        }
        if (![1, 2, 3].includes(message.id) || message.method !== undefined) return
        if (message.error) { finish(new Error(`Devin config inspection error: ${JSON.stringify(message.error)}`)); return }
        if (message.id === 1) {
          result._meta = message.result._meta
          send(2, 'session/new', { cwd: root, mcpServers: [] })
        } else if (message.id === 2) {
          send(3, 'session/prompt', { sessionId: message.result.sessionId, prompt: [{ type: 'text', text: '/mcp' }] })
        } else finish()
      })
      send(1, 'initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dsh-mcp-discovery-test', version: '1' },
      })
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
  // Windows cannot be isolated through XDG/APPDATA. Only write its real profile
  // in the disposable ordinary-user CI account, never in a developer's profile.
  const windowsNativeRoot = process.argv[3]
  if (process.platform === 'win32') {
    assert.ok(windowsNativeRoot, 'Pass the disposable CI account native APPDATA directory')
    assert.equal(userInfo().username, 'dsh-acp-ci', 'Native Windows config test requires the disposable CI account')
    assert.equal(resolve(windowsNativeRoot), resolve(process.env.APPDATA!), 'Use the actual profile APPDATA before overriding it')
  }
  nativeFile = join(process.platform === 'win32' ? windowsNativeRoot! : source, 'devin', 'mcp_config.json')
  await mkdir(dirname(nativeFile), { recursive: true })
  try { originalNativeFile = await readFile(nativeFile) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const nativeServer = `dshteam_native_config_probe_${randomUUID().replaceAll('-', '')}`
  await writeFile(nativeFile, JSON.stringify({ mcpServers: {
    [nativeServer]: { url: 'http://127.0.0.1:43210/native-config-probe', transport: 'http' },
  } }), { mode: 0o600 })
  nativeFileWritten = true
  const nativeEnv = process.platform === 'win32' ? process.env : { ...process.env, ...sourceEnv }
  const baseline = await inspectMcp(nativeEnv)
  assert.equal(resolve(baseline._meta?.mcpConfigPath ?? ''), resolve(nativeFile), 'Devin must report the documented native MCP file')
  assert.ok(baseline.mcpListing.includes(nativeServer), 'ACP /mcp must list the server written to the documented native file')
  console.log(JSON.stringify({ check: 'native-config-content', platform: process.platform, file: nativeFile, serverVisibleInAcp: true }))
  console.log('PASS: ACP /mcp reads the server from the documented native MCP config')
  // Let Devin itself locate and update its native config, including the fixed
  // stdio entry proposed for Windows. This does not start the MCP launcher.
  const runMcp = async (...args: string[]) => await promisify(execFile)(executable!, ['mcp', ...args], {
    cwd: root, env: nativeEnv, timeout: 30_000,
  })
  const httpName = `http_probe_${randomUUID().replaceAll('-', '')}`
  const stdioName = `stdio_probe_${randomUUID().replaceAll('-', '')}`
  const launcher = fileURLToPath(new URL('../src/runtime/session/team-mcp-stdio.ts', import.meta.url))
  await runMcp('add', '--scope', 'user', httpName, 'http://127.0.0.1:43210/add-command-probe')
  await runMcp('add', '--scope', 'user', stdioName, '--', process.execPath, launcher)
  const added = JSON.parse(await readFile(nativeFile, 'utf8')).mcpServers
  assert.equal(added[httpName].url, 'http://127.0.0.1:43210/add-command-probe')
  assert.equal(added[stdioName].command, process.execPath)
  assert.deepEqual(added[stdioName].args, [launcher])
  assert.equal(added[nativeServer].url, 'http://127.0.0.1:43210/native-config-probe', 'mcp add must preserve existing servers')
  const addedInspection = await inspectMcp(nativeEnv)
  assert.ok(addedInspection.mcpListing.includes(httpName), 'ACP must discover the HTTP server registered by mcp add')
  assert.ok(addedInspection.mcpListing.includes(stdioName), 'ACP must discover the stdio server registered by mcp add')
  await runMcp('remove', '--scope', 'user', httpName)
  await runMcp('remove', '--scope', 'user', stdioName)
  const removed = JSON.parse(await readFile(nativeFile, 'utf8')).mcpServers
  assert.equal(removed[httpName], undefined)
  assert.equal(removed[stdioName], undefined)
  assert.equal(removed[nativeServer].url, 'http://127.0.0.1:43210/native-config-probe', 'mcp remove must preserve other servers')
  console.log(JSON.stringify({ check: 'native-mcp-cli', platform: process.platform, httpAdd: true, stdioAdd: true, visibleInFreshAcp: true, remove: true, existingServerPreserved: true }))
  console.log('PASS: native mcp add/remove and ACP discovery for HTTP and stdio entries')
  prepared = await prepareDevinTeamConfig(sourceEnv, {
    signal: new AbortController().signal,
    servers: [{ type: 'http', name: 'dshteam_discovery_test', url: 'http://127.0.0.1:43210/test', headers: [] }],
    beginPrompt() {}, endPrompt() {}, permission: () => undefined, async close() {},
  })
  const result = await inspectMcp({ ...process.env, ...prepared.env })
  const expected = join(prepared.env.XDG_CONFIG_HOME!, 'devin', 'mcp_config.json')
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch,
    sourceConfigHome: source,
    baseline: baseline._meta?.mcpConfigPath,
    overlayConfigHome: prepared.env.XDG_CONFIG_HOME,
    expected, discovered: result._meta?.mcpConfigPath,
    nativeServerVisible: result.mcpListing.includes(nativeServer),
    injectedServerVisible: result.mcpListing.includes('dshteam_discovery_test'),
    scope: 'ACP initialize + session/new + built-in /mcp; no authentication, model request, or MCP tool call',
  }))
  assert.ok(result._meta?.mcpConfigPath, 'Real Devin must report its MCP config path')
  assert.equal(resolve(result._meta?.mcpConfigPath ?? ''), resolve(expected), 'Real Devin must load the injected MCP file')
  assert.ok(result.mcpListing.includes('dshteam_discovery_test'), 'ACP /mcp must list the server injected into the overlay')
  console.log('PASS: real Devin ACP reads the isolated MCP config contents')
} finally {
  await prepared?.lease.close()
  if (nativeFileWritten && nativeFile !== undefined) {
    if (originalNativeFile === undefined) await rm(nativeFile, { force: true })
    else await writeFile(nativeFile, originalNativeFile)
  }
  await rm(root, { recursive: true, force: true })
}
