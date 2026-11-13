/** Zero inference: boot the exact Teams profile and inspect its isolated registered MCP launcher. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { DEVIN_LIVE_BUNDLES, devinLiveProfilePatch } from './devin-live-profile.ts'
import { assertDevinLiveCatalog } from './devin-live-catalog.ts'

// Inspect the exact built bridge/launcher used by the mounted plugin.
const { createDshToolBridge } = await import(new URL('../lib/host/tools/bridge.js', import.meta.url).href)
const { prepareDevinMcp } = await import(new URL('../lib/host/tools/devin-config.js', import.meta.url).href)
const { resolveSubprocessSeam } = await import(new URL('../lib/host/composition/subprocess.js', import.meta.url).href)

const executable = process.argv[2]
assert.ok(executable, 'Pass the Devin executable; only isolated mcp registration commands are run')
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
  lease = await createDshToolBridge(
    ctx,
    agent.id,
    { mcpCapabilities: { http: true } },
    'devin',
    async () => 'auto',
    undefined,
    schemas,
    () => admission,
  )
  assert.ok(lease, 'LIVE_CATALOG_BRIDGE_UNAVAILABLE')
  assert.equal(lease.servers[0]?.name, 'dsh')
  const seam = resolveSubprocessSeam(ctx)
  assert.ok(seam.ok, 'LIVE_CATALOG_SUBPROCESS_UNAVAILABLE')
  const env = {
    HOME: join(root, 'native-home'),
    XDG_CONFIG_HOME: join(root, 'native-config'),
    XDG_DATA_HOME: join(root, 'native-data'),
    XDG_CACHE_HOME: join(root, 'native-cache'),
    APPDATA: join(root, 'native-data'),
    LOCALAPPDATA: join(root, 'native-cache'),
    USERPROFILE: join(root, 'native-home'),
  }
  const prepared = await prepareDevinMcp({
    subprocess: seam.seam,
    command: executable,
    args: ['acp'],
    cwd: workspace,
    env,
    lease,
  })
  lease = prepared.lease
  client = new Client({ name: 'devin-isolated-catalog-audit', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(env.HOME, '.dsh', 'acp', 'mcp', 'dsh-mcp-launcher.mjs')],
      cwd: workspace,
      env: { ...prepared.env, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    }),
  )
  const remote = await client.listTools()
  assertDevinLiveCatalog(
    schemas.map((tool) => ({ name: tool.name, schema: tool.parameters })),
    remote.tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema })),
  )
  console.log(
    JSON.stringify({
      status: 'passed',
      inferenceRequests: 0,
      authenticatedAgentProcesses: 0,
      nativeTools: schemas.length,
      mcpTools: remote.tools.length,
      isolatedRegistration: true,
      exactDevinLauncher: true,
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
