/** Authenticated real Devin + published DSH AgentLoop/Teams. Logs only assertions, never wire transcripts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readLiveActivitySummary, safeLiveDiagnostic, safeSpawnDiagnostic } from './live-diagnostics.ts'
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
const received: Array<{ id: string; senderId: string; targetId: string; text: string }> = []
const receipts = new Map<string, { sessionId: string; seq: number }>()
const expectedReplyMarkers = new Map<string, Set<string>>()
const replyEvidence = new Map<string, Map<string, { echoSeq?: number; exactSeq?: number; exactTurn?: number }>>()
const created = new Map<string, string>()
const roles = new Map<string, string>()
const completedTurns = new Map<string, number>()
const completedTurnIds = new Map<string, Set<number>>()
const assistantMessageCounts = new Map<string, number>()
const hostToolResultCounts = new Map<string, number>()
const failures: Array<{ actor: string; diagnostic: ReturnType<typeof safeLiveDiagnostic> }> = []
// The CI job also installs/builds before this script; keep the live check
// bounded so host shutdown and CI cleanup fit inside the job's 20 minute cap.
const overallDeadline = Date.now() + 12 * 60_000
const wait = async (condition: () => boolean, label: string) => {
  const deadline = Math.min(Date.now() + 300_000, overallDeadline)
  while (!condition()) {
    assert.equal(failures.length, 0, JSON.stringify(failures))
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}; completed tools: ${JSON.stringify(executions.map(e => ({ name: e.name, success: e.success })))}`)
    await delay(250)
  }
}
const expectReplyMarker = (sessionId: string, marker: string) => {
  const markers = expectedReplyMarkers.get(sessionId) ?? new Set<string>()
  markers.add(marker)
  expectedReplyMarkers.set(sessionId, markers)
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
  ctx.on('agent/created', ({ agent }) => {
    if (agent.options.provider !== undefined) created.set(agent.id, agent.options.provider)
    // Team membership is journaled before the child Agent is started. Resolve
    // the parent Lead here so a fast teammate tool call is labeled correctly.
    const parentRole = agent.session.header.parentSession === undefined ? undefined : roles.get(agent.session.header.parentSession)
    if (parentRole?.startsWith('lead-')) roles.set(agent.id, `member-${parentRole.slice('lead-'.length)}`)
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider === 'acp-devin') {
      const marker = expectedReplyMarkers.get(execution.agent.id)?.values().next().value
      const spawn = execution.name === 'spawn_teammate' ? safeSpawnDiagnostic(execution.arguments, marker) : undefined
      const errorCode = result.isError ? safeLiveDiagnostic(result.error).toolCode : undefined
      hostToolResultCounts.set(execution.agent.id, (hostToolResultCounts.get(execution.agent.id) ?? 0) + 1)
      executions.push({ name: execution.name, sessionId: execution.agent.id, success: !result.isError })
      console.log(JSON.stringify({ actor: roles.get(execution.agent.id) ?? 'member', session: execution.agent.id,
        tool: execution.name, success: !result.isError,
        ...(errorCode === undefined ? {} : { errorCode }), ...(spawn === undefined ? {} : { spawn }) }))
    }
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'team/message/queued') {
      const message = event.data.message
      received.push({ id: message.id, senderId: message.senderId, targetId: message.targetId, text: message.content.filter(c => c.type === 'text').map(c => c.text).join('') })
      console.log('PASS: native team message queued')
    }
    if (event.type === 'user/message' && event.data.source.kind === 'team-message') {
      receipts.set(event.data.source.messageId, { sessionId: _session.id, seq: event.seq })
    }
    if (event.type === 'assistant/message' && event.data.interrupted !== true) {
      assistantMessageCounts.set(_session.id, (assistantMessageCounts.get(_session.id) ?? 0) + 1)
      const text = event.data.message.content.filter(c => c.type === 'text').map(c => c.text).join('')
      for (const marker of expectedReplyMarkers.get(_session.id) ?? []) {
        if (!text.includes(marker)) continue
        const byMarker = replyEvidence.get(_session.id) ?? new Map<string, { echoSeq?: number; exactSeq?: number; exactTurn?: number }>()
        const evidence = byMarker.get(marker) ?? {}
        evidence.echoSeq = event.seq
        if (text.trim() === marker) {
          evidence.exactSeq = event.seq
          evidence.exactTurn = event.data.turn
        }
        byMarker.set(marker, evidence)
        replyEvidence.set(_session.id, byMarker)
      }
    }
    if (event.type === 'turn/end') {
      const actor = roles.get(_session.id) ?? 'member'
      const reason = event.data.reason
      if (reason.kind === 'error') failures.push({ actor, diagnostic: safeLiveDiagnostic(reason.error) })
      else if (reason.kind === 'completed') {
        completedTurns.set(_session.id, (completedTurns.get(_session.id) ?? 0) + 1)
        const turns = completedTurnIds.get(_session.id) ?? new Set<number>()
        turns.add(event.data.turn)
        completedTurnIds.set(_session.id, turns)
      }
      console.log(JSON.stringify({ actor, session: _session.id, event: 'turn/end', reason: reason.kind,
        ...(actor.startsWith('member-') ? {
          assistantMessages: assistantMessageCounts.get(_session.id) ?? 0,
          hostToolResults: hostToolResultCounts.get(_session.id) ?? 0,
        } : {}) }))
      assistantMessageCounts.delete(_session.id)
      hostToolResultCounts.delete(_session.id)
    }
  })
  // Two independent leads exercise a single shared native MCP entry concurrently.
  const leads = await Promise.all([0, 1].map(async index => {
    const handle = await ctx.agents.create({ sessionId: randomUUID() as SessionId, meta: { cwd: workspace }, agentOptions: { provider: 'acp-devin', model } })
    roles.set(handle.agent.id, `lead-${index}`)
    const marker = `CI_${index}_${randomUUID().slice(0, 8)}`
    expectReplyMarker(handle.agent.id, marker)
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
      `This is an explicitly authorized DSH Agent Teams test. Use only tools on the DSH MCP server named dsh. Do not use shell, files, web or native subagent tools. Create exactly one fresh DSH teammate named checker using spawn_teammate. Ask it to send_message to the lead with the text ${marker}, then end its response. After creating the teammate end your response so DSH can deliver its reply. Once its reply arrives, acknowledge it by echoing the exact marker ${marker}, then stop. Do not create any further teammates.` }] }))
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
    // A teammate reply can enter the Lead's next step before its first turn
    // closes. Verify target-side consumption and a subsequent reply, not a
    // timing-dependent requirement that delivery creates a second turn.
    await wait(() => received.some(message => {
      const receipt = receipts.get(message.id)
      const answer = replyEvidence.get(lead.id)?.get(marker)
      return message.senderId === member.id && message.targetId === lead.id && message.text.includes(marker)
        && receipt?.sessionId === lead.id && answer?.echoSeq !== undefined && answer.echoSeq > receipt.seq
    }), `lead ${index} consumes teammate message and replies`)
    await wait(() => ctx.agentTeams.listMembers(lead).every(m => m.status === 'inactive'), `team ${index} idle`)
    assert.ok(!received.some(m => m.senderId === member.id && m.targetId !== lead.id), 'Teammate must not send to another lead')
  }
  // Independently require an explicit follow-up after both teams have settled.
  // This exercises established ACP bindings even when mailbox delivery stayed
  // within the first native turn. Responses remain in memory and are not logged.
  await Promise.all(leads.map(async ({ handle, index }) => {
    const before = completedTurns.get(handle.agent.id) ?? 0
    assert.ok(before >= 1, 'Initial Lead turn must have completed')
    const marker = `FOLLOWUP_${index}_${randomUUID().slice(0, 8)}`
    expectReplyMarker(handle.agent.id, marker)
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
      `Reply with exactly ${marker}. Do not call any tools or send any team messages.` }] }))
    await wait(() => {
      const reply = replyEvidence.get(handle.agent.id)?.get(marker)
      return (completedTurns.get(handle.agent.id) ?? 0) > before
        && reply?.exactSeq !== undefined
        && reply.exactTurn !== undefined
        && completedTurnIds.get(handle.agent.id)?.has(reply.exactTurn) === true
      }, `lead ${index} explicit follow-up`)
  }))
  for (const { handle, index } of leads) {
    const lead = handle.agent
    const member = ctx.agentTeams.listMembers(lead).find(candidate => candidate.role === 'teammate')!
    assert.ok(!received.some(message => message.senderId === member.id && message.targetId !== lead.id), `Teammate ${index} must not message another Team`)
  }
  assert.equal(failures.length, 0, JSON.stringify(failures))
  assert.notEqual(ctx.agentTeams.listMembers(leads[0]!.handle.agent)[1]!.id, ctx.agentTeams.listMembers(leads[1]!.handle.agent)[1]!.id)
  console.log(JSON.stringify({ check: 'real-devin-dsh-teams', platform: process.platform, leads: 2, teammates: 2, successfulTools: executions.filter(e => e.success).length, result: 'PASS' }))
  for (const { handle } of leads) await handle.dispose()
} catch (error) {
  // No model output, ACP frames, settings, exception causes or secret-bearing env in evidence.
  const message = error instanceof Error ? error.message : 'Unknown failure'
  console.error(message.replaceAll(token, '<redacted>'))
  process.exitCode = 1
} finally {
  for (const [sessionId, actor] of roles) {
    try {
      console.log(JSON.stringify({ check: 'real-devin-activity-diagnostic', source: 'persistent-acp-projection', actor,
        activity: readLiveActivitySummary(join(home, 'dsh-acp', 'sidecar.sqlite'), sessionId) }))
    } catch (diagnosticError) {
      // Best-effort diagnostics must not replace the original test result.
      void diagnosticError
    }
  }
  await host?.shutdown.shutdown(process.exitCode === 1 ? 1 : 0)
  process.chdir(originalCwd)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
