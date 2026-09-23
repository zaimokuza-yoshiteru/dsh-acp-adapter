/** Authenticated real Devin + published DSH AgentLoop/Teams. Logs only assertions, never wire transcripts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { initProfile, loadProfileDirectory, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'

const executable = process.argv[2]
assert.ok(executable, 'Pass the real Devin executable')
assert.ok(process.env.WINDSURF_API_KEY, 'Missing DEVIN_CLI_TOKEN Secret')
if (process.platform === 'win32') assert.equal(userInfo().username, 'dsh-acp-ci', 'Use the disposable ordinary Windows CI user')
const token = process.env.WINDSURF_API_KEY
const originalCwd = process.cwd()
const root = await mkdtemp(join(tmpdir(), 'dsh-devin-live-'))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const requireHost = createRequire(installAnchor)
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const profileDir = join(home, 'profiles', 'devin-e2e')
let host: Awaited<ReturnType<typeof runProfile>> | undefined
const executions: Array<{ name: string; sessionId: string; success: boolean }> = []
const received: Array<{ senderId: string; targetId: string; text: string }> = []
const created = new Map<string, string>()
const roles = new Map<string, string>()
const completedTurns = new Map<string, number>()
const failures: string[] = []
const deadline = Date.now() + 300_000
const wait = async (condition: () => boolean, label: string) => {
  while (!condition()) {
    assert.equal(failures.length, 0, failures.join('; '))
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}; completed tools: ${JSON.stringify(executions.map(e => ({ name: e.name, success: e.success })))}`)
    await delay(250)
  }
}
try {
  await mkdir(workspace, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DSH_SKILL_ROOTS = join(root, 'skills')
  process.chdir(workspace)
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-agent-team-profile', '@zaimokuza/dsh-acp-adapter']
  initProfile(profileDir, bundles)
  for (const name of bundles) {
    const directory = name.startsWith('@zaimokuza/') ? packageRoot : dirname(requireHost.resolve(`${name}/package.json`))
    const link = join(profileDir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(directory, link, 'junction')
  }
  // All services are native. Disable unrelated model calls, telemetry and workspace instruction discovery.
  await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([
    ...['session-title-llm', 'llm-deepseek', 'llm-pi-ai', 'agent-instructions', 'skill-filesystem', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
    { id: 'agent-team', config: { maxMembers: 2, maxTasks: 8 } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
  ]))
  const profile = loadProfileDirectory('devin-e2e', profileDir, installAnchor)
  host = await runProfile({ environment: loadLayeredEnv('devin-e2e'), profile: 'devin-e2e', resolvedProfile: { profile, installAnchor }, patchFiles: [], args: [] })
  console.log('PASS: published DSH AgentLoop and Teams host booted')
  const ctx = host.ctx
  const env = {
    WINDSURF_API_KEY: token,
    HOME: join(root, 'native-home'),
    XDG_CONFIG_HOME: join(root, 'native-config'),
    XDG_DATA_HOME: join(root, 'native-data'),
    XDG_CACHE_HOME: join(root, 'native-cache'),
  }
  await ctx.settings.replace('dsh-acp-adapter', { agents: { devin: { name: 'Devin CI', command: executable, args: ['acp'], env } } })
  await wait(() => ctx.llm.listProviders().some(p => p.id === 'acp-devin'), 'provider registration')
  console.log('PASS: ACP provider registered')
  const models = await ctx.llm.listModels('acp-devin')
  assert.ok(models.length, 'Authenticated Devin must expose models')
  const model = models.find(m => m.id === 'fast')?.id ?? models[0]!.id
  console.log('PASS: real Devin model discovery')
  ctx.on('agent/created', ({ agent }) => { if (agent.options.provider !== undefined) created.set(agent.id, agent.options.provider) })
  ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider === 'acp-devin') {
      executions.push({ name: execution.name, sessionId: execution.agent.id, success: !result.isError })
      console.log(JSON.stringify({ actor: roles.get(execution.agent.id) ?? 'member', session: execution.agent.id,
        tool: execution.name, success: !result.isError }))
    }
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'team/message/queued') {
      const message = event.data.message
      received.push({ senderId: message.senderId, targetId: message.targetId, text: message.content.filter(c => c.type === 'text').map(c => c.text).join('') })
      console.log('PASS: native team message queued')
    }
    if (event.type === 'turn/end') {
      const actor = roles.get(_session.id) ?? 'member'
      const reason = event.data.reason
      if (reason.kind === 'error') failures.push(`${actor}: turn failed (${reason.error.code ?? 'unclassified'})`)
      else if (reason.kind === 'completed') completedTurns.set(_session.id, (completedTurns.get(_session.id) ?? 0) + 1)
      console.log(JSON.stringify({ actor, session: _session.id, event: 'turn/end', reason: reason.kind }))
    }
  })
  // Two independent leads exercise a single shared native MCP entry concurrently.
  const leads = await Promise.all([0, 1].map(async index => {
    const handle = await ctx.agents.create({ sessionId: randomUUID() as SessionId, meta: { cwd: workspace }, agentOptions: { provider: 'acp-devin', model } })
    roles.set(handle.agent.id, `lead-${index}`)
    const marker = `CI_${index}_${randomUUID().slice(0, 8)}`
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
      `This is an explicitly authorized DSH Agent Teams test. Use only tools on the DSH MCP server named dsh. Do not use shell, files, web or native subagent tools. Create exactly one fresh DSH teammate named checker using spawn_teammate. Ask it to send_message to the lead with the text ${marker}, then end its response. After creating the teammate end your response so DSH can deliver its reply. Once its reply arrives, acknowledge it and stop. Do not create any further teammates.` }] }))
    return { handle, marker, index }
  }))
  for (const { handle, index, marker } of leads) {
    const lead = handle.agent
    await wait(() => executions.some(e => e.sessionId === lead.id && e.name === 'spawn_teammate' && e.success), `lead ${index} spawn`)
    const members = ctx.agentTeams.listMembers(lead)
    assert.equal(members.length, 2, 'Exactly one real teammate per lead')
    const member = members.find(m => m.role === 'teammate')!
    roles.set(member.id, `member-${index}`)
    assert.equal(member.name, 'checker', 'Same member name must resolve within its own Team')
    assert.equal(created.get(member.id), 'acp-devin', 'Native DSH must create a real ACP teammate')
    await wait(() => executions.some(e => e.sessionId === member.id && e.name === 'send_message' && e.success), `teammate ${index} real call`)
    await wait(() => received.some(m => m.senderId === member.id && m.targetId === lead.id && m.text.includes(marker)), `team ${index} exact delivery`)
    await wait(() => (completedTurns.get(lead.id) ?? 0) >= 2, `lead ${index} native continuation`)
    await wait(() => ctx.agentTeams.listMembers(lead).every(m => m.status === 'inactive'), `team ${index} idle`)
    assert.ok(!received.some(m => m.senderId === member.id && m.targetId !== lead.id), 'Teammate must not send to another lead')
  }
  assert.notEqual(ctx.agentTeams.listMembers(leads[0]!.handle.agent)[1]!.id, ctx.agentTeams.listMembers(leads[1]!.handle.agent)[1]!.id)
  console.log(JSON.stringify({ check: 'real-devin-dsh-teams', platform: process.platform, leads: 2, teammates: 2, successfulTools: executions.filter(e => e.success).length, result: 'PASS' }))
  for (const { handle } of leads) await handle.dispose()
} catch (error) {
  // No model output, ACP frames, settings, exception causes or secret-bearing env in evidence.
  const message = error instanceof Error ? error.message : 'Unknown failure'
  console.error(message.replaceAll(token, '<redacted>'))
  process.exitCode = 1
} finally {
  await host?.shutdown.shutdown(process.exitCode === 1 ? 1 : 0)
  process.chdir(originalCwd)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
