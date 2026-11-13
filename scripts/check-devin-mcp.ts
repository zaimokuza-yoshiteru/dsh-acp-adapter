/** Verify session-supplied MCP with real Devin. Only the local /mcp command runs; no login or inference. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import * as acp from '@agentclientprotocol/sdk'

const executable = process.argv[2]
assert.ok(executable, 'Pass the real Devin executable path')
const root = await mkdtemp(join(tmpdir(), 'dsh-real-devin-'))
const configRoot = process.platform === 'win32' ? process.argv[3] : join(root, 'config')
if (process.platform === 'win32') {
  // Windows resolves native profile folders independently of HOME/XDG overrides.
  assert.equal(userInfo().username, 'dsh-acp-ci', 'Windows discovery requires the disposable ordinary CI account')
  assert.ok(configRoot, 'Pass the disposable CI account native APPDATA directory')
  assert.equal(resolve(configRoot), resolve(process.env.APPDATA!), 'Use the actual disposable account APPDATA')
}
assert.ok(configRoot)
const configFile = join(configRoot, 'devin', 'config.json')
const nativeMcpFile = join(configRoot, 'devin', 'mcp_config.json')
const cwd = join(root, 'workspace')
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
const environment: NodeJS.ProcessEnv = {
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  XDG_CONFIG_HOME: configRoot,
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  APPDATA: configRoot,
  LOCALAPPDATA: join(root, 'data'),
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
  TERM: 'dumb',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key] !== undefined) environment[key] = process.env[key]
}
const exec = promisify(execFile)
const httpMethods: Array<{ path: string; method: string }> = []
let configCreated = false
let nativeMcpCreated = false
let toolCalls = 0
let slashCommands = 0

async function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const http = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end()
    return
  }
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 65_536) {
      response.writeHead(413).end()
      return
    }
  }
  const message = JSON.parse(body)
  httpMethods.push({ path: request.url ?? '', method: message.method })
  if (message.method === 'tools/call') toolCalls++
  if (message.id === undefined) {
    response.writeHead(202).end()
    return
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'isolated-mcp-discovery', version: '1' },
        }
      : message.method === 'tools/list'
        ? { tools: [{ name: `session_${(request.url ?? '').replaceAll('/', '')}`, inputSchema: { type: 'object' } }] }
        : undefined
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      ...(result === undefined
        ? { error: { code: -32601, message: 'Discovery fixture rejects this method' } }
        : { result }),
    }),
  )
})

async function inspect(phase: string, baseUrl: string, priorSessionId?: string): Promise<string> {
  const stdioLog = join(root, `${phase}-stdio.jsonl`)
  const stdioName = `wire_stdio_${phase}`
  const servers: acp.McpServer[] = [
    { type: 'http', name: 'dsh', url: `${baseUrl}/${phase}`, headers: [] },
    { name: stdioName, command: process.execPath, args: [join(root, 'mcp.mjs'), stdioLog], env: [] },
  ]
  const child = spawn(executable!, ['acp'], {
    cwd,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  let listing = ''
  let permissionRequests = 0
  const connection = acp
    .client()
    .onRequest('session/request_permission', () => {
      permissionRequests++
      return { outcome: { outcome: 'cancelled' } }
    })
    .onNotification('session/update', ({ params: { update } }) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        listing += update.content.text
      }
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      ),
    )
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once('error', reject)
    child.stdin.once('error', reject)
  })
  void spawnFailure.catch(() => {})
  child.stderr.resume()
  try {
    return await bounded(
      Promise.race([
        spawnFailure,
        (async () => {
          const init = await connection.agent.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'dsh-mcp-discovery-test', version: '2' },
          })
          assert.equal(init.agentCapabilities?.mcpCapabilities?.http, true)
          assert.equal(init.agentCapabilities?.loadSession, true)
          let sessionId = priorSessionId
          if (sessionId === undefined) {
            // Slash commands do not create conversation history. Persist the empty
            // fixture explicitly so a fresh process can exercise standard load.
            assert.equal(init.agentCapabilities?._meta?.['cognition.ai/persistOnCreate'], true)
            sessionId = (
              await connection.agent.request('session/new', {
                cwd,
                mcpServers: servers,
                _meta: { 'cognition.ai/persistOnCreate': true },
              })
            ).sessionId
          } else {
            await connection.agent.request('session/load', { sessionId, cwd, mcpServers: servers })
          }
          const deadline = Date.now() + 15_000
          while (true) {
            listing = ''
            slashCommands++
            // Official built-in status command, never an inference prompt.
            const answer: acp.PromptResponse = await connection.agent.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: '/mcp' }],
            })
            assert.equal(answer.stopReason, 'end_turn')
            const stdioMethods = await readFile(stdioLog, 'utf8').catch(() => '')
            if (
              listing.includes('`dsh` — Connected') &&
              listing.includes(`\`${stdioName}\` — Connected`) &&
              httpMethods.some((event) => event.path === `/${phase}` && event.method === 'initialize') &&
              stdioMethods.includes('"initialize"')
            ) {
              assert.equal(listing.match(/wire_stdio_/g)?.length, 1, 'Load must replace the old session MCP list')
              assert.equal(listing.match(/`dsh`/g)?.length, 1, 'The session must expose one current DSH connection')
              assert.ok(!stdioMethods.includes('"tools/call"'), 'Discovery must not execute tools')
              break
            }
            assert.ok(Date.now() < deadline, `${phase}: supplied MCP services did not connect`)
            await sleep(250)
          }
          assert.equal(permissionRequests, 0, 'Status inspection must not request permissions')
          console.log(JSON.stringify({ check: phase, httpConnected: true, stdioConnected: true, freshProcess: true }))
          return sessionId
        })(),
      ]),
      `Devin ${phase} discovery`,
    )
  } finally {
    connection.close()
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000 }).catch((error) => {
          if (child.exitCode === null && child.signalCode === null) throw error
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    try {
      await bounded(closed, 'Devin process cleanup', process.platform === 'win32' ? 10_000 : 2_000)
    } catch (error) {
      if (process.platform === 'win32' || child.pid === undefined) throw error
      // Terminate the same owned group if either Devin or its MCP child ignores TERM.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError
      }
      await bounded(closed, 'Devin process forced cleanup', 10_000)
    }
  }
}

try {
  await mkdir(dirname(configFile), { recursive: true })
  for (const path of [cwd, environment.HOME!, environment.XDG_DATA_HOME!, environment.XDG_CACHE_HOME!]) {
    await mkdir(path, { recursive: true })
  }
  assert.equal(await exists(configFile), false, 'Never overwrite an existing Devin configuration')
  assert.equal(await exists(nativeMcpFile), false, 'Never overwrite existing MCP registrations')
  await writeFile(
    configFile,
    JSON.stringify({
      read_config_from: Object.fromEntries(
        ['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed', 'cloud'].map((key) => [
          key,
          false,
        ]),
      ),
    }),
    { mode: 0o600, flag: 'wx' },
  )
  configCreated = true
  await writeFile(
    join(root, 'mcp.mjs'),
    `import {appendFileSync} from 'node:fs';import{createInterface}from'node:readline';
appendFileSync(process.argv[2],JSON.stringify({method:'process/start'})+'\\n');for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(process.argv[2],JSON.stringify({method:m.method})+'\\n');if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-stdio',version:'1'}}:m.method==='tools/list'?{tools:[]}:undefined;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(result===undefined?{error:{code:-32601,message:'Discovery only'}}:{result})})+'\\n')}`,
  )
  await new Promise<void>((done, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', done)
  })
  const address = http.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const sessionId = await inspect('new', baseUrl)
  await inspect('load', baseUrl, sessionId)
  assert.equal(await exists(nativeMcpFile), false, 'Session MCP must not create a native registration')

  const sentinel = join(root, 'stale-launcher-ran')
  const staleConfiguration = JSON.stringify({
    mcpServers: {
      dsh: {
        command: process.execPath,
        // Old registrations are inert without the removed DSH endpoint environment.
        // The CLI may prewarm one before session/new replaces it.
        args: [join(root, 'mcp.mjs'), sentinel],
      },
    },
  })
  await writeFile(nativeMcpFile, staleConfiguration, { mode: 0o600, flag: 'wx' })
  nativeMcpCreated = true
  const migrated = await inspect('stale_new', baseUrl)
  await inspect('stale_load', baseUrl, migrated)
  const staleMethods = await readFile(sentinel, 'utf8').catch(() => '')
  assert.ok(!staleMethods.includes('"tools/call"'), 'The stale registration must never execute a tool')
  assert.equal(
    await readFile(nativeMcpFile, 'utf8'),
    staleConfiguration,
    'Existing registrations must remain unchanged',
  )
  assert.equal(toolCalls, 0)
  console.log(
    JSON.stringify({
      check: 'modern-session-mcp',
      authenticated: false,
      modelPrompts: 0,
      slashCommands,
      staleLauncherPrewarmed: staleMethods.includes('"process/start"'),
      nativeConfigurationUnchanged: true,
    }),
  )
  console.log('PASS: real Devin session/new and session/load consume HTTP/stdio MCP without native registration')
} finally {
  if (http.listening) {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  }
  if (nativeMcpCreated) await rm(nativeMcpFile)
  if (configCreated) await rm(configFile)
  await rm(root, { recursive: true, force: true })
}
