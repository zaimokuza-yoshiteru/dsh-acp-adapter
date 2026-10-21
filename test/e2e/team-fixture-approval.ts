import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect } from 'vitest'
import { summarizeRawInputForAudit } from '../../src/domain/policy/events.ts'
import { acpPermissionAudit } from './acp-permission-audit.ts'
import { required } from './required.ts'
import type { AdapterWorld } from './scaffold.ts'

export interface TeamFixtureApprovalStep {
  readonly owner: 'lead' | (string & {})
  readonly callId: string
  readonly tool: string
  readonly args: Record<string, unknown> | ((agent: Agent) => Record<string, unknown>)
  /** A separately delivered child-settled notice may follow the explicit relay. */
  readonly optional?: boolean
}

/** Explicit, finite setup decisions; never answers the member-shell request under test. */
export function installTeamFixtureApprovals(
  host: AdapterWorld,
  options: {
    readonly root?: Agent
    readonly initialPrompt?: string
    readonly entries: readonly TeamFixtureApprovalStep[]
  },
) {
  let root = options.root
  const owners = new Map<string, Agent>()
  const used = new Set<TeamFixtureApprovalStep>()
  const answers: { sessionId: string; requestId: string; toolCallId: string }[] = []
  const requestIds = new Set<string>()
  const stop = host.ctx.on(
    'approval/request',
    async (request, next) => {
      const agent = request.agent
      if (
        request.signal?.aborted ||
        host.ctx.agents.get(agent.id) !== agent ||
        agent.options.provider !== 'acp-devin' ||
        !/^team-\d+$/.test(request.callId ?? '')
      )
        return next()
      let owner: string
      if (host.ctx.agents.roots().includes(agent)) {
        if (root === undefined) {
          if (options.initialPrompt === undefined) return next()
          const matches = host.ctx.agents
            .roots()
            .filter(
              (candidate) =>
                candidate.options.provider === 'acp-devin' &&
                candidate.session
                  .snapshotEvents()
                  .some(
                    (event) =>
                      event.type === 'user/message' &&
                      event.data.source.kind === 'user' &&
                      event.data.content.length === 1 &&
                      event.data.content[0]?.type === 'text' &&
                      event.data.content[0].text === options.initialPrompt,
                  ),
            )
          if (matches.length !== 1 || matches[0] !== agent) return next()
          root = agent
        }
        if (root !== agent) return next()
        owner = 'lead'
      } else {
        if (root === undefined || host.ctx.agents.get(root.id) !== root) return next()
        const membership = host.ctx.agentTeams.tryMembership(agent)
        if (
          membership?.role !== 'teammate' ||
          membership.root !== root ||
          !host.ctx.agents.isOwnedBy(agent.id, root) ||
          !host.ctx.agentTeams
            .listMembers(root)
            .some((member) => member.id === agent.id && member.name === membership.name)
        )
          return next()
        owner = membership.name
        expect(host.ctx.approval.overrideOf(agent.session)).toBe('never')
      }
      const bound = owners.get(owner)
      if (bound !== undefined && bound !== agent) return next()
      const step = options.entries.find((entry) => entry.owner === owner && !used.has(entry))
      if (step === undefined || step.callId !== request.callId) return next()
      const asked = acpPermissionAudit(host, 'asked').findLast(
        (entry) => entry.sessionId === agent.id && entry.data.toolCall.toolCallId === request.callId,
      )
      if (asked === undefined || requestIds.has(asked.data.requestId)) return next()
      expect(asked.data.toolCall.title).toBe(step.tool)
      expect(asked.data.options).toEqual([
        { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
      ])
      const args = typeof step.args === 'function' ? step.args(agent) : step.args
      expect(asked.data.toolCall.rawInputHash).toBe(summarizeRawInputForAudit(args).hash)
      owners.set(owner, agent)
      used.add(step)
      requestIds.add(asked.data.requestId)
      answers.push({ sessionId: agent.id, requestId: asked.data.requestId, toolCallId: required(request.callId) })
      return 'allowed-once'
    },
    { prepend: true },
  )
  return {
    answers,
    requestIds,
    root: () => required(root),
    dispose: stop,
    finish() {
      stop()
      expect(options.entries.filter((entry) => !entry.optional && !used.has(entry))).toEqual([])
      const decisions = acpPermissionAudit(host, 'decided').filter((entry) => requestIds.has(entry.data.requestId))
      expect(decisions).toHaveLength(answers.length)
      for (const answer of answers) {
        const decided = required(decisions.find((entry) => entry.data.requestId === answer.requestId))
        expect(decided.sessionId).toBe(answer.sessionId)
        expect(decided.data).toMatchObject({
          outcome: 'selected',
          toolCallId: answer.toolCallId,
          optionId: 'allow',
          selectedOptionKind: 'allow_once',
          decisionVia: 'native-approval',
        })
      }
    },
  }
}

export function teamMemberSetupSteps(owner: string): TeamFixtureApprovalStep[] {
  return [
    { owner, callId: 'team-1', tool: 'list_agents', args: {} },
    {
      owner,
      callId: 'team-2',
      tool: 'spawn_teammate',
      args: { name: 'nested', description: 'Denied nested spawn', prompt: 'do nothing' },
    },
  ]
}

export function teamStartSteps(host: AdapterWorld): TeamFixtureApprovalStep[] {
  let task: { id: string; revision: number } | undefined
  let blocked: { id: string; revision: number } | undefined
  const originalTask = (agent: Agent) => {
    task ??= { ...required(host.ctx.agentTeams.listTasks(agent).find((entry) => entry.subject === 'Compute fixture')) }
    return task
  }
  const blockedTask = (agent: Agent) => {
    blocked ??= {
      ...required(host.ctx.agentTeams.listTasks(agent).find((entry) => entry.subject === 'Blocked fixture')),
    }
    return blocked
  }
  const calls: Omit<TeamFixtureApprovalStep, 'owner' | 'callId'>[] = [
    { tool: 'list_agents', args: {} },
    { tool: 'wait_agent', args: { timeout_ms: 10_000 } },
    { tool: 'team_task_create', args: { subject: 'Compute fixture', description: 'Return 2' } },
    { tool: 'team_task_get', args: (agent) => ({ task_id: originalTask(agent).id }) },
    {
      tool: 'team_task_update',
      args: (agent) => ({
        task_id: originalTask(agent).id,
        expected_revision: originalTask(agent).revision,
        action: 'claim',
      }),
    },
    { tool: 'team_task_list', args: {} },
    {
      tool: 'team_task_update',
      args: (agent) => ({
        task_id: originalTask(agent).id,
        expected_revision: originalTask(agent).revision,
        action: 'complete',
      }),
    },
    {
      tool: 'team_task_create',
      args: (agent) => ({
        subject: 'Blocked fixture',
        description: 'Wait for compute',
        blocked_by: [originalTask(agent).id],
      }),
    },
    {
      tool: 'team_task_update',
      args: (agent) => ({
        task_id: blockedTask(agent).id,
        expected_revision: blockedTask(agent).revision,
        action: 'claim',
      }),
    },
    { tool: 'send_message', args: { target: 'missing-member', message: 'must not deliver' } },
    ...[{ context: 'fork' }, { model: 'mock-model-b' }, { agent: 'other' }, { provider: 'acp-other' }].map(
      (override) => ({
        tool: 'spawn_teammate',
        args: { name: 'invalid', description: 'Must not create', prompt: 'do nothing', ...override },
      }),
    ),
    {
      tool: 'spawn_teammate',
      args: {
        name: 'calculator',
        description: 'Compute fixture',
        prompt: 'E2E_TEAM_MEMBER calculate 1+1',
        context: 'fresh',
      },
    },
  ]
  return calls.map((entry, index) => ({ ...entry, owner: 'lead', callId: `team-${index + 1}` }))
}

/** One explicit child relay and, at most, its separately delivered settlement notice. */
export function teamReplySteps(): TeamFixtureApprovalStep[] {
  return [
    { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {} },
    { owner: 'lead', callId: 'team-1', tool: 'list_agents', args: {}, optional: true },
  ]
}
