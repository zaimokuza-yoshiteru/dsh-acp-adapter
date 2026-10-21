/** Real Loader, native subagent lifecycle and MCP tools; only model inference is scripted. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  OPTIONAL_TOOL_PLAN,
  type OptionalToolPlan,
  type OptionalToolRecord,
} from '../mock-agent/optional-tools-turn.ts'
import { callResult } from './optional-tool-world.ts'
import { launchAdapterWorld, root, type AdapterWorld } from './scaffold.ts'
import { required } from './required.ts'

class NativeParent extends LlmAdapter {
  readonly requests: Parameters<LlmAdapter['stream']>[0][] = []
  providerInfo(id: string) {
    return { id, name: 'Native keyless parent' }
  }
  async listModels(provider: string) {
    return [{ provider, id: 'fixture', name: 'Fixture' }]
  }
  async *stream(options: Parameters<LlmAdapter['stream']>[0]): ReturnType<LlmAdapter['stream']> {
    this.requests.push(options)
    const text = 'NATIVE_PARENT_COMPLETED'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(teams: boolean) {
  const host = await launchAdapterWorld({
    optionalBundles: teams ? ['agent-team-profile'] : [],
    toolsMode: 'native',
  })
  try {
    const log = join(host.workspaceCwd, 'subagent-protocol.log')
    const recordsPath = join(host.workspaceCwd, 'subagent-mcp.jsonl')
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'ask',
      agents: {
        'subagent-fixture': {
          name: 'Native subagent contract fixture',
          command: process.execPath,
          args: [join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: 'devin',
            MOCK_MCP_HTTP: '1',
            MOCK_ADVERTISE_FORK: '1',
            MOCK_LOG: log,
            MOCK_OPTIONAL_TOOL_RESULTS: recordsPath,
          },
        },
      },
    })
    await vi.waitFor(() =>
      expect(host.ctx.llm.listProviders().some((entry) => entry.id === 'acp-subagent-fixture')).toBe(true),
    )
    const native = new NativeParent()
    host.ctx.effect(() => host.ctx.llm.registerAdapter(['contract-native'], native))
    const records = (): OptionalToolRecord[] =>
      existsSync(recordsPath)
        ? readFileSync(recordsPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as OptionalToolRecord)
        : []
    const wire = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    const evidence = (label: string, details: unknown) => {
      const directory = join(root, '.local/native-agent-fix/identity/host')
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, `${label}.json`),
        JSON.stringify({ details, records: records(), wire: wire() }, null, 2),
      )
    }
    const create = async (provider: string, model: string) => {
      await host.ctx.agentDefaultModel.saveSelection({ provider, model })
      const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
      const resolved = await host.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      return resolved.agent
    }
    return { ...host, native, records, wire, evidence, create }
  } catch (error) {
    await host.close()
    throw error
  }
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
function turns(agent: Agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length
}
async function settled(agent: Agent, before: number) {
  await vi.waitFor(() => expect(turns(agent)).toBeGreaterThan(before), { timeout: 30_000 })
  await agent.whenIdle()
}
function start(host: AdapterWorld, parent: Agent, provider: string, text: string, cwd?: string) {
  return host.ctx.subagents.startActivation({
    provider,
    label: 'native contract child',
    delivery: 'caller',
    request: {
      parent,
      prompt: [{ type: 'text', text }],
      agentOptions: { provider: 'acp-subagent-fixture', model: 'mock-model-a' },
      ...(cwd === undefined ? {} : { cwd }),
    },
    signal: new AbortController().signal,
  })
}

it.each([false, true])(
  'preserves independent native child tools, approvals and directory with Teams=%s',
  async (teams) => {
    const host = await fixture(teams)
    let activation: SubagentActivation | undefined
    let child: Agent | undefined
    const answers: string[] = []
    try {
      host.ctx.on('subagent/start', (entry) => {
        child = host.ctx.agents.get(entry.id)
      })
      host.ctx.on(
        'approval/request',
        async (request) => {
          answers.push(request.toolName)
          return 'allowed-once' as const
        },
        { prepend: true },
      )
      // Exercise native ToolRuntime's real ask -> never gate without an OS-specific
      // sandbox escape. This fixture-owned preflight requests approval for one write.
      host.ctx.on(
        'tools/pre-execute',
        async (exec, next) => {
          const args = exec.arguments as { content?: string }
          return exec.name === 'write' && args.content === 'MUST_NOT_EXECUTE'
            ? { kind: 'ask' as const, reason: 'Native fixture write needs approval' }
            : next()
        },
        { prepend: true },
      )
      const parent = await host.create('contract-native', 'fixture')
      host.ctx.permissionPresets.set(parent.session, 'workspace-write')
      send(parent, 'native parent initial turn')
      await settled(parent, 0)
      const cwd = join(host.workspaceCwd, 'independent-child')
      mkdirSync(cwd)
      const allowed = join(cwd, 'allowed.txt')
      const denied = join(cwd, 'denied.txt')
      const plan: OptionalToolPlan = {
        label: `native-child-${teams}`,
        calls: [
          { name: 'list_agents', arguments: {} },
          { name: 'send_message', arguments: { agent_id: parent.id, message: 'CHILD_TO_NATIVE_PARENT' } },
          { name: 'write', arguments: { file_path: allowed, content: 'NATIVE_CHILD_WRITE' } },
          { name: 'write', arguments: { file_path: denied, content: 'MUST_NOT_EXECUTE' } },
        ],
      }
      activation = await start(host, parent, 'spawn', `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}`, cwd)
      const result = await activation.result
      expect(result.stopReason).toBe('completed')
      expect(JSON.stringify(result.output)).toContain(`E2E_OPTIONAL_DONE ${plan.label}`)
      const owner = required(child)
      expect(owner.session.header).toMatchObject({ origin: 'subagent', isSeeded: false, parentSession: parent.id })
      expect(host.ctx.get('agentTeams', false)?.tryMembership(owner)).toBeUndefined()
      expect(host.ctx.approval.overrideOf(owner.session)).toBe('never')
      expect(host.ctx.sandboxPolicy.resolve({ session: owner.session }).mode).toBe('workspace-write')
      const records = host.records()
      expect(records.filter((entry) => entry.kind === 'failure')).toEqual([])
      expect(required(records.find((entry) => entry.kind === 'directory')).names).toEqual(
        expect.arrayContaining(['send_message', 'list_agents', 'interrupt_agent', 'write']),
      )
      expect(callResult(records, 'list_agents').isError).toBe(false)
      expect(callResult(records, 'send_message').isError).toBe(false)
      const writes = records.filter((entry) => entry.kind === 'call' && entry.name === 'write')
      expect(writes.map((entry) => (entry.result as { isError?: boolean }).isError === true)).toEqual([false, true])
      expect(readFileSync(allowed, 'utf8')).toBe('NATIVE_CHILD_WRITE')
      expect(existsSync(denied)).toBe(false)
      expect(records.every((entry) => entry.cwd === cwd)).toBe(true)
      expect(records.filter((entry) => entry.kind === 'permission')).toHaveLength(4)
      expect(answers).toHaveLength(4)
      await vi.waitFor(() => expect(JSON.stringify(host.native.requests)).toContain('CHILD_TO_NATIVE_PARENT'))
      await parent.whenIdle()
      host.evidence(`teams-${teams}`, {
        result,
        permissions: owner.session
          .snapshotEvents()
          .filter((event) => event.type === 'approval/policy' || event.type === 'sandbox/mode'),
        answers,
      })
    } catch (error) {
      host.evidence(`teams-${teams}-failure`, {
        error: String(error),
        childEvents: child?.session.snapshotEvents(),
        answers,
      })
      throw error
    } finally {
      try {
        await activation?.dispose()
      } finally {
        await host.close()
      }
    }
  },
)

it('rejects a seeded delegated fork while its ACP parent runs, without a blank child dispatch', async () => {
  const host = await fixture(false)
  let activation: SubagentActivation | undefined
  let parent: Agent | undefined
  let child: Agent | undefined
  try {
    host.ctx.on('subagent/start', (entry) => {
      child = host.ctx.agents.get(entry.id)
    })
    parent = await host.create('acp-subagent-fixture', 'mock-model-a')
    const plan: OptionalToolPlan = { label: 'fork-parent-seed', calls: [] }
    send(parent, `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}`)
    await settled(parent, 0)
    expect(
      required(parent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).data.reason.kind,
    ).toBe('completed')
    send(parent, 'E2E_STEERING_HOLD')
    // Streaming output is not a committed assistant message yet. The fixture
    // records this barrier only after entering its cancellable held prompt.
    await vi.waitFor(() => expect(host.wire()).toContain('regression steering-held session='), {
      timeout: 30_000,
    })
    expect(parent.status).toBe('running')
    const before = host
      .wire()
      .split('\n')
      .filter((line) => /--> session\/(?:new|fork|prompt) /.test(line))
    activation = await start(host, parent, 'fork', 'SEEDED_CHILD_MUST_NOT_START_BLANK')
    const result = await activation.result
    expect(required(child).session.header).toMatchObject({
      origin: 'subagent',
      isSeeded: true,
      parentSession: parent.id,
    })
    expect(required(child).session.inheritedEventCount).toBeGreaterThan(0)
    expect(result.stopReason).toBe('error')
    expect(JSON.stringify(required(child).session.snapshotEvents())).toContain('ACP_DELEGATED_FORK_UNAVAILABLE')
    expect(
      host
        .wire()
        .split('\n')
        .filter((line) => /--> session\/(?:new|fork|prompt) /.test(line)),
    ).toEqual(before)
    expect(parent.status).toBe('running')
    host.evidence('seeded-fork-running', { result, childEvents: required(child).session.snapshotEvents(), before })
  } catch (error) {
    host.evidence('seeded-fork-running-failure', {
      error: String(error),
      childEvents: child?.session.snapshotEvents(),
      parentEvents: parent?.session.snapshotEvents(),
    })
    throw error
  } finally {
    try {
      await activation?.dispose()
    } finally {
      try {
        parent?.cancel({ kind: 'user' })
        await parent?.whenIdle()
      } finally {
        await host.close()
      }
    }
  }
})
