import { treeMembers } from './subagent-tree.ts'
import { required } from './required.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ObservedEvent } from './types.ts'
import type { AdapterWorld } from './scaffold.ts'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeComposerDraft } from '#host-support'
import { closeNativeMembers, openNativeMembers } from './native-team-ui.ts'
import { createLiveTeamProgress } from './live-team-progress.ts'
import { installLiveDevinTeamApprovals, type DevinManualApprovalContext } from './live-devin-team-approval.ts'

/** Small real-Agent check. It cannot pass by merely describing a teammate. */
export async function verifyLiveTeam({
  host,
  page,
  provider,
  model,
  selectChildModel = false,
  evidence,
  evidenceDirectory,
  devinManualApproval,
  memberName = 'calculator',
  expectedMembers = 2,
}: {
  host: AdapterWorld
  page: Page
  provider: string
  model: string
  selectChildModel?: boolean
  evidence: Record<string, unknown>
  evidenceDirectory: string
  devinManualApproval?: DevinManualApprovalContext | undefined
  memberName?: string
  expectedMembers?: number
}) {
  const token = `TEAM_${randomUUID().slice(0, 8)}`
  const progress = createLiveTeamProgress()
  let taskRoot: SessionId | undefined
  const executions: { name: string; sessionId: SessionId; isError: boolean; error: unknown }[] = []
  const messages: (ObservedEvent | { sessionId: SessionId; type: 'assistant/message'; seq: number; text: string })[] =
    []
  const disposeResults = host.ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider === provider)
      executions.push({
        name: execution.name,
        sessionId: execution.agent.id,
        isError: result.isError,
        error: result.error,
      })
  })
  const disposeEvents = host.ctx.on('session/event', (session, event) => {
    if (
      taskRoot === undefined &&
      event.type === 'user/message' &&
      event.data.source.kind === 'user' &&
      event.data.content.some((block) => block.type === 'text' && block.text.includes(token))
    ) {
      const candidate = host.ctx.agents.get(session.id)
      if (
        candidate?.options.provider === provider &&
        session.header.origin !== 'subagent' &&
        host.ctx.subagents.rootOf(candidate) === candidate
      )
        taskRoot = session.id
    }
    if (event.type === 'turn/end' && taskRoot !== undefined) {
      const agent = host.ctx.agents.get(session.id)
      if (session.id === taskRoot || (agent !== undefined && host.ctx.subagents.rootOf(agent).id === taskRoot))
        progress.observe(event.data.reason)
    }
    if (event.type === 'agent/inbox/spliced' || event.type === 'user/message' || event.type === 'turn/end')
      messages.push({ sessionId: session.id, ...event })
    if (event.type === 'assistant/message')
      messages.push({
        sessionId: session.id,
        type: event.type,
        seq: event.seq,
        text: event.data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      })
  })
  Object.assign(evidence, { token, executions, messages })
  const approvals =
    provider === 'acp-devin'
      ? installLiveDevinTeamApprovals({
          host,
          page,
          token,
          memberName,
          model,
          evidence,
          directory: evidenceDirectory,
          manualTitle: devinManualApproval,
          getLead: () => (taskRoot === undefined ? undefined : host.ctx.agents.get(taskRoot)),
        })
      : undefined
  const wait: typeof progress.wait = (check, options) => progress.wait(check, options, approvals?.answerPending)
  // Observe the real admitted view: plain agents.create() does not mount the
  // session-controller's preset, so its registry cannot certify this tool set.
  const definitions: Record<string, string[]> = {}
  if (provider === 'acp-devin') evidence.toolDefinitions = { source: 'admitted-native-toolset', sessions: definitions }
  const stopDefinitions =
    provider === 'acp-devin'
      ? host.ctx.systemPrompt.section({
          name: `live-team-definitions-${token}`,
          order: 0,
          interpolate: false,
          text: ({ agent, scope, toolSet }) => {
            if (
              agent === undefined ||
              host.ctx.agents.get(agent.id) !== agent ||
              agent.options.provider !== provider ||
              toolSet === undefined
            )
              return ''
            const names =
              agent.session.header.origin === 'subagent'
                ? ['team_task_get', 'team_task_update', 'send_message']
                : [
                    'team_task_create',
                    'team_task_get',
                    'team_task_update',
                    'team_task_list',
                    'subagent',
                    'send_message',
                    'list_agents',
                    'wait_agent',
                  ]
            const schemas = host.ctx.tools.schemas(scope, toolSet)
            const selected = names.map((name) => {
              const schema = schemas.find((tool) => tool.name === name)
              expect(schema, `Admitted test tool ${name} must be available`).toBeDefined()
              return { name, parameters: schema!.parameters }
            })
            definitions[agent.id] = names
            return `For this isolated Teams execution test, these are your current DSH tool definitions: ${JSON.stringify(selected)}. Use them on your own DSH MCP connection. Do not request the full catalog or read overflow files; if your CLI automatically lists the server, continue using these definitions. They do not grant permission to perform other work.`
          },
        })
      : undefined
  try {
    const discovery =
      provider === 'acp-devin'
        ? "The host supplies the required current tool definitions in each session's instructions. Use those definitions directly on your own MCP connection, including in the child; do not read overflow files."
        : 'Use the exact names and schemas supplied by your MCP client. Each teammate uses its own connection; never pass connection identities to it.'
    const prompt =
      `Start a NEW independent Agent Teams task now. Earlier completed tasks and teammates do not satisfy this request: create the new tasks and the new teammate named below. Do the actual MCP tool calls before answering; a calculation or token-only reply is not completion. This is explicitly authorized in an empty temporary workspace. Use ONLY the current DSH tools MCP connection identified in the latest host instructions; do not use your own subagent tools, shell, web or files. ${discovery}
Create a shared task with subject "Compute ${token}" and a second task "Review ${token}" blocked_by the compute task. Use DSH subagent to create exactly one fresh child named ${memberName}.${selectChildModel ? ` Set that new child's provider to ${JSON.stringify(provider)} and model to ${JSON.stringify(model)}; do not change the Lead's model or any existing child's model.` : ''} Give it the compute task ID and ask it to get the task, claim it with its current revision, calculate 1+1, get the latest revision and complete the task, then use DSH send_message with agent "lead" to send the lead the result and token ${token}, and end its response.
Wait for its message. If using wait_agent, omit timeout_ms or set it to at most 300000; new input wakes the wait early. Get/list the shared tasks, confirm the compute task is completed and the review task unblocked, claim and complete the review task yourself using current revisions. Reply with the token and result. Do not claim or complete the member's compute task yourself. If a tool says DSH has pending input, end the current response with a brief progress update so DSH can deliver the message; the host will continue automatically. Do not resend accepted messages. Stop after both tasks are completed.`.replaceAll(
        '\n',
        ' ',
      )
    await closeNativeMembers(page)
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await wait(() => expect(executions.some((item) => item.name === 'subagent' && !item.isError)).toBe(true), {
      timeout: 120_000,
      interval: 500,
    })
    const lead = required(host.ctx.agents.get(required(executions.find((item) => item.name === 'subagent')).sessionId))
    const roster = await treeMembers(host.ctx, lead)
    Object.assign(evidence, { roster })
    expect(roster).toHaveLength(expectedMembers)
    const member = required(roster.find((member) => member.name === memberName))
    const child = required(host.ctx.agents.get(member.id))
    expect(child.session.header).toMatchObject({ origin: 'subagent', parentSession: lead.id })
    expect(host.ctx.subagents.rootOf(child)).toBe(lead)
    expect(host.ctx.subagents.namesOf(child).self).toBe(memberName)
    expect(child.options).toMatchObject({ provider, model })
    expect(child.session.header.cwd).toBe(lead.session.header.cwd)
    await wait(
      async () => {
        const receipt = required(
          messages
            .filter((event) => event.type === 'user/message')
            .find(
              (event) =>
                event.sessionId === lead.id &&
                event.data.source.kind === 'agent-message' &&
                event.data.source.form === 'relay' &&
                event.data.source.senderSessionId === child.id &&
                event.data.content.some((block) => block.type === 'text' && block.text.includes(token)),
            ),
          'Expected the Lead to receive the new teammate relay',
        )
        const accepted = required(
          messages
            .filter((event) => event.type === 'agent/inbox/spliced')
            .find(
              (event) =>
                event.sessionId === lead.id && event.data.inserted.some((message) => message.id === receipt.data.id),
            ),
          'Expected the relay to be accepted into the Lead inbox',
        )
        expect(accepted.seq).toBeLessThan(receipt.seq)
        expect((await treeMembers(host.ctx, lead)).every((member) => member.status === 'inactive')).toBe(true)
      },
      { timeout: 180_000, interval: 500 },
    )
    expect(
      executions.some((item) => item.name === 'send_message' && item.sessionId === child.id && !item.isError),
    ).toBe(true)
    await wait(
      () => {
        const tasks = host.ctx.agentTeams.listTasks(lead).filter((task) => task.subject.includes(token))
        evidence.tasks = tasks
        expect(tasks).toHaveLength(2)
        expect(tasks.every((task) => task.status === 'completed')).toBe(true)
        expect(required(tasks.find((task) => task.subject === `Compute ${token}`)).ownerName).toBe(memberName)
        expect(required(tasks.find((task) => task.subject === `Review ${token}`)).ownerName).toBe('lead')
      },
      { timeout: 120_000, interval: 500 },
    )
    // The task permits get OR list; a successful exact get must not require a redundant list call.
    for (const name of ['team_task_create', 'team_task_get', 'team_task_update']) {
      expect(executions.some((item) => item.name === name && !item.isError)).toBe(true)
    }
    expect(child.session.requestHeader()?.config).toMatchObject({ provider, model })
    expect(
      executions.some((item) => item.name === 'team_task_update' && item.sessionId === child.id && !item.isError),
    ).toBe(true)
    // Devin's independent Ask choices were answered once; no question may remain pending.
    expect(await page.locator('[data-approval-key], [data-question-key]').count()).toBe(0)
    const handle = await host.ctx.sessionPersistence.open(lead.id, 'read')
    try {
      // Idle can be momentary between native steps; wait for the actual message-driven response.
      await wait(
        async () => {
          const events = (await handle.read()).events
          const receipt = required(
            events
              .filter((event) => event.type === 'user/message')
              .find(
                (event) =>
                  event.data.source.kind === 'agent-message' &&
                  event.data.source.form === 'relay' &&
                  event.data.source.senderSessionId === child.id &&
                  event.data.content.some((block) => block.type === 'text' && block.text.includes(token)),
              ),
            'Expected the received teammate relay in the durable Lead history',
          )
          const final = events.findLast((event) => event.type === 'assistant/message')
          const reply = final?.data.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
          evidence.reply = reply
          expect(required(final, 'Expected a Lead model response after the relay').seq).toBeGreaterThan(receipt.seq)
          expect(reply).toContain(token)
          expect(reply).toContain('2')
        },
        { timeout: 90_000, interval: 500 },
      )
    } finally {
      await handle.close()
    }
    const panel = await openNativeMembers(page)
    await panel.getByRole('treeitem').filter({ hasText: memberName }).first().waitFor()
    for (const [subject, owner] of [
      [`Compute ${token}`, memberName],
      [`Review ${token}`, 'lead'],
    ] as const) {
      const task = panel.locator('[data-team-task]').filter({ hasText: subject })
      await task.waitFor()
      expect(await task.getAttribute('data-status')).toBe('completed')
      const toggle = task.getByRole('button').first()
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      expect(await task.locator('[data-team-task-owner]').innerText()).toContain(owner)
    }
    await approvals?.answerPending()
    approvals?.assertComplete()
    return { lead, child }
  } finally {
    stopDefinitions?.()
    approvals?.dispose()
    disposeResults()
    disposeEvents()
  }
}
