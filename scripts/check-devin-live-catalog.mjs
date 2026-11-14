/** Zero inference: inspect a native Standard session's resolved tools over both MCP transports. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { devinLiveProfilePatch } from './devin-live-profile.ts'
import { assertDevinLiveCatalog } from './devin-live-catalog.ts'

// Inspect the exact built bridge and generic stdio transport used by the mounted plugin.
const { createDshToolBridge } = await import(new URL('../lib/host/tools/bridge.js', import.meta.url).href)

const root = await mkdtemp(join(tmpdir(), 'dsh-devin-catalog-'))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const originalCwd = process.cwd()
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const profileDir = join(home, 'profiles', 'devin-e2e')
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const requireHost = createRequire(installAnchor)
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@zaimokuza/dsh-acp-adapter']
let host
let lease
let tools
let client
try {
  await mkdir(workspace, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DSH_SKILL_ROOTS = join(root, 'skills')
  process.chdir(workspace)
  initProfile(profileDir, bundles)
  for (const name of bundles) {
    const directory = name.startsWith('@zaimokuza/')
      ? packageRoot
      : dirname(requireHost.resolve(`${name}/package.json`))
    const link = join(profileDir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(directory, link, 'junction')
  }
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    JSON.stringify([
      ...devinLiveProfilePatch(workspace),
      { id: 'agent-default-model', config: { provider: 'catalog-only', model: 'no-inference' } },
      { id: 'workspace-controller', config: { documentsDirectory: join(workspace, 'Documents') } },
      { id: 'session-log-deepseek', config: { enabled: false } },
    ]),
  )
  const profile = loadProfileDirectory('devin-e2e', profileDir, installAnchor)
  host = await runProfile({
    environment: loadLayeredEnv('devin-e2e'),
    profile: 'devin-e2e',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  })
  const ctx = host.ctx
  const created = await ctx.sessionController.create({ cwd: workspace, agentPreset: 'standard' })
  const resolved = await ctx.sessionController.resolveAgent(created.sessionId)
  assert.ok(!('error' in resolved), 'LIVE_CATALOG_NATIVE_SESSION_UNAVAILABLE')
  const agent = resolved.agent
  assert.equal(ctx.agentPresets.presetForSession(agent.session), 'standard')
  assert.equal(agent.status, 'idle')
  const signal = new AbortController().signal
  tools = await ctx.tools.resolve({
    agent,
    signal,
    modelSelection: { provider: 'catalog-only', model: 'no-inference' },
  })
  const schemas = ctx.tools.schemas(agent, tools)
  // These preset-scoped tools were absent from the old bare-Agent preflight.
  for (const name of ['workflow', 'plugin_manager', 'schedule_create', 'ask_user_question', 'list_subagent_models'])
    assert.equal(schemas.filter((tool) => tool.name === name).length, 1, `LIVE_CATALOG_STANDARD_${name}`)
  const admission = {
    agent,
    toolSet: tools,
    definitions: new Map(tools.view(agent)),
    signal,
    turn: 0,
    step: 0,
    isActive: () => false,
  }
  const transports = []
  for (const http of [true, false]) {
    lease = await createDshToolBridge(
      ctx,
      agent.id,
      { mcpCapabilities: { http } },
      'devin',
      async () => 'auto',
      undefined,
      schemas,
      () => admission,
    )
    assert.ok(lease, 'LIVE_CATALOG_BRIDGE_UNAVAILABLE')
    const server = lease.servers[0]
    assert.equal(server?.name, 'dsh')
    assert.equal(lease.servers.length, 1)
    client = new Client({ name: 'devin-session-catalog-audit', version: '1' })
    const transport =
      server.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url))
        : new StdioClientTransport({
            command: server.command,
            args: server.args,
            cwd: workspace,
            env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            stderr: 'pipe',
          })
    await client.connect(transport)
    const remote = await client.listTools()
    assertDevinLiveCatalog(
      schemas.map((tool) => ({ name: tool.name, schema: tool.parameters })),
      remote.tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema })),
    )
    for (const tool of schemas)
      assert.equal(
        remote.tools.find((candidate) => candidate.name === tool.name)?.description,
        tool.description,
        'LIVE_CATALOG_DESCRIPTION_MISMATCH',
      )
    transports.push({
      type: http ? 'http' : 'stdio',
      mcpTools: remote.tools.length,
      toolsListBytes: Buffer.byteLength(JSON.stringify(remote)),
      devinPrettyCatalogBytes: Buffer.byteLength(
        JSON.stringify([{ server_name: server.name, tools: remote.tools, resources: [] }], null, 2),
      ),
    })
    await client.close()
    client = undefined
    await lease.close()
    lease = undefined
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      inferenceRequests: 0,
      authenticatedAgentProcesses: 0,
      setupRoute: 'sessionController.create',
      agentPreset: 'standard',
      nativeTools: schemas.length,
      toolNames: schemas.map((tool) => tool.name).sort(),
      transports,
      nativeConfigWrites: 0,
    }),
  )
} finally {
  try {
    await client?.close()
  } finally {
    try {
      await lease?.close()
    } finally {
      tools?.dispose()
      try {
        await host?.shutdown.shutdown(0)
      } finally {
        process.chdir(originalCwd)
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
