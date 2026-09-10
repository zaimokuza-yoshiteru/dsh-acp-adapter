import { expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeComposerDraft } from '#host-support'

/** Small real-Agent check. It cannot pass by merely describing a teammate. */
export async function verifyLiveTeam({ host, page, provider, model, evidence, memberName = 'calculator', expectedMembers = 2 }) {
  const token = `TEAM_${randomUUID().slice(0, 8)}`
  const executions = []
  const messages = []
  host.ctx.on('tools/result', (execution, result) => {
    if (execution.agent?.options.provider === provider) executions.push({ name: execution.name, sessionId: execution.agent.id, isError: result.isError, error: result.error })
  })
  host.ctx.on('session/event', (session, event) => {
    if (event.type.startsWith('team/message/') || event.type === 'agent/error') messages.push({ sessionId: session.id, ...event })
    if (event.type === 'turn/end') messages.push({ sessionId: session.id, ...event })
    if (event.type === 'assistant/message') messages.push({ sessionId: session.id, type: event.type, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') })
  })
  Object.assign(evidence, { token, executions, messages })
  const prompt = `This is an explicitly authorized Agent Teams smoke test in an empty temporary workspace. Use ONLY the DSH Agent Teams MCP server (dshteam_*); do not use your own subagent tools, shell, web or files. Create exactly one fresh DSH teammate named ${memberName}, asking it to calculate 1+1 and use the DSH send_message tool to send you the result and token ${token}, then end its response. Use the exposed MCP tool names from tools/list. Wait for its message and then reply with the token and result. If a tool says DSH has pending input, end the current response with a brief progress update so DSH can deliver the message; the host will continue automatically. Do not resend accepted messages. Stop after this single calculation.`
  await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await vi.waitFor(() => expect(executions.some(item => item.name === 'spawn_teammate' && !item.isError)).toBe(true), { timeout: 120_000, interval: 500 })
  const lead = host.ctx.agents.get(executions.find(item => item.name === 'spawn_teammate').sessionId)
  const roster = host.ctx.agentTeams.listMembers(lead)
  Object.assign(evidence, { roster })
  expect(roster).toHaveLength(expectedMembers)
  const member = roster.find(member => member.name === memberName)
  expect(member.context).toBe('fresh')
  const child = host.ctx.agents.get(member.id)
  expect(child.options).toMatchObject({ provider, model })
  expect(child.session.header.cwd).toBe(lead.session.header.cwd)
  await vi.waitFor(() => {
    expect(messages.some(event => event.type === 'team/message/queued' && JSON.stringify(event.data).includes(token))).toBe(true)
    expect(host.ctx.agentTeams.listMembers(lead).every(member => member.status === 'idle' || member.status === 'inactive')).toBe(true)
  }, { timeout: 180_000, interval: 500 })
  expect(executions.some(item => item.name === 'send_message' && item.sessionId === child.id && !item.isError)).toBe(true)
  // No team-control request may have introduced an approval panel.
  expect(await page.locator('[data-approval-key], [data-question-key]').count()).toBe(0)
  const handle = await host.ctx.sessionPersistence.open(lead.id, 'read')
  try {
    // Idle can be momentary between native steps; wait for the actual message-driven response.
    await vi.waitFor(async () => {
      const events = (await handle.read()).events
      const final = events.findLast(event => event.type === 'assistant/message')
      const reply = final?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      evidence.reply = reply
      expect(reply).toContain(token)
      expect(reply).toContain('2')
    }, { timeout: 90_000, interval: 500 })
  } finally { await handle.close() }
  await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/ }).click()
  await page.locator('[data-team-action]').getByText(memberName, { exact: true }).first().waitFor()
}
