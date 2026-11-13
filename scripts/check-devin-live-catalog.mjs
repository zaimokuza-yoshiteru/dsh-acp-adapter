/** Zero inference: boot the exact Teams profile and inspect both standard session MCP transports. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { DEVIN_LIVE_BUNDLES, devinLiveProfilePatch } from './devin-live-profile.ts'
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
let host
let handle
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
  initProfile(profileDir, DEVIN_LIVE_BUNDLES)
  for (const name of DEVIN_LIVE_BUNDLES) {
    const directory = name.startsWith('@zaimokuza/')
      ? packageRoot
      : dirname(requireHost.resolve(`${name}/package.json`))
    const link = join(profileDir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(directory, link, 'junction')
  }
  await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify(devinLiveProfilePatch(workspace)))
  const profile = loadProfileDirectory('devin-e2e', profileDir, installAnchor)
  host = await runProfile({
    environment: loadLayeredEnv('devin-e2e'),
    profile: 'devin-e2e',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [],
  })
  const ctx = host.ctx
  handle = await ctx.agents.create({
    sessionId: SessionId('catalog-only'),
    meta: { cwd: workspace },
    agentOptions: { provider: 'catalog-only', model: 'no-inference' },
  })
  const agent = handle.agent
  const signal = new AbortController().signal
  tools = await ctx.tools.resolve({
    agent,
    signal,
    modelSelection: { provider: 'catalog-only', model: 'no-inference' },
  })
  const schemas = ctx.tools.schemas(agent, tools)
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
    transports.push({ type: http ? 'http' : 'stdio', mcpTools: remote.tools.length })
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
      nativeTools: schemas.length,
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
        await handle?.dispose()
      } finally {
        try {
          await host?.shutdown.shutdown(0)
        } finally {
          process.chdir(originalCwd)
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }
}
