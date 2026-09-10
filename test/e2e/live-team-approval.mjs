import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { writeComposerDraft } from '#host-support'

/** A fresh real member must reach the native approval before its first file side effect. */
export async function verifyLiveTeamApproval({ host, page, provider, evidence }) {
  const token = `APPROVAL_${randomUUID().slice(0, 8)}`
  const fileName = `${token}.txt`
  const lead = host.ctx.agents.list().find(agent => agent.options.provider === provider && host.ctx.agentTeams.tryMembership(agent)?.role === 'lead')
  const destination = join(lead.session.header.cwd, fileName)
  const events = []
  host.ctx.on('session/event', (session, event) => {
    if (['approval/asked', 'approval/decided', 'approval/policy', 'turn/end'].includes(event.type)) events.push({ sessionId: session.id, ...event })
  })
  Object.assign(evidence, { token, events })
  // verifyLiveTeam leaves the native team panel open.
  await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/ }).click()
  const prompt = `This is an authorized approval regression in this empty temporary workspace. Use the DSH Teams MCP spawn_teammate tool to create exactly one fresh member named permission-review. Ask it to execute exactly this shell command in the workspace: printf '${token}' > ${fileName}. It must use its normal shell execution tool and request interactive permission when needed; do not bypass permission by using another tool or editing API. After successful execution it should send the lead ${token} using DSH send_message, then finish. Do not execute the command yourself. End your response after creating the member so the human can handle its approval.`
  await writeComposerDraft(page, page.locator('[data-composer-input]').first(), prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const card = page.locator('[data-acp-team-approvals]')
  await card.getByRole('button', { name: 'permission-review · Pending request', exact: true }).waitFor({ timeout: 120_000 })
  const member = host.ctx.agentTeams.listMembers(lead).find(member => member.name === 'permission-review')
  evidence.memberId = member.id
  expect(existsSync(destination), 'Command must not run before approval').toBe(false)
  expect(events.filter(event => event.sessionId === member.id && event.type === 'approval/asked')).toHaveLength(1)
  const handle = await host.ctx.sessionPersistence.open(member.id, 'read')
  try {
    const log = (await handle.read()).events
    const firstPrompt = log.find(event => event.type === 'user/message' && event.data.source?.form === 'snapshot')
    expect(JSON.stringify(firstPrompt)).toContain('Approval policy: ask.')
    expect(JSON.stringify(firstPrompt)).not.toContain('Approval prompts are disabled in this session')
    expect(JSON.stringify(firstPrompt)).not.toContain('operations that require approval are rejected automatically')
  } finally { await handle.close() }
  await page.screenshot({ path: join(evidence.directory, 'pending-approval.png'), fullPage: true })
  await card.getByRole('button', { name: 'permission-review · Pending request', exact: true }).click()
  const approval = page.locator('[data-approval-key]')
  await approval.waitFor()
  expect(await approval.innerText()).toContain(fileName)
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await vi.waitFor(() => expect(existsSync(destination)).toBe(true), { timeout: 60_000 })
  expect(readFileSync(destination, 'utf8').trim()).toBe(token)
  await vi.waitFor(() => expect(host.ctx.agentTeams.listMembers(lead).every(member => ['idle', 'inactive'].includes(member.status))).toBe(true), { timeout: 120_000, interval: 500 })
  await page.locator('header nav').getByRole('button').first().click()
  await vi.waitFor(async () => expect(await card.count()).toBe(0))
  await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/ }).click()
}
