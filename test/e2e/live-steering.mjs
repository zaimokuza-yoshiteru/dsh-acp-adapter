import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { writeComposerDraft } from '#host-support'

/** Opt-in real Agent test; steering is sent only after native streaming begins. */
export async function verifyLiveSteering({ host, page }) {
  const marker = `LIVE_STEER_${randomUUID()}`
  let injected = false, owner
  const off = host.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (injected || frame.type !== 'chunk' || frame.chunk.type !== 'text-delta' || !frame.chunk.text.trim()) return
    injected = true
    owner = agent.id
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Stop counting. Reply only with ${marker}. Do not use tools.` }] }))
  })
  try {
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Count from 1 to 1000, one number per line. Do not use tools or read or write files. If a new user instruction arrives, follow that new instruction.')
    const settled = host.whenTurnSettled(120_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const id = await settled
    expect(injected, 'A real response must have begun before requesting steering').toBe(true)
    expect(id).toBe(owner)
    const handle = await host.ctx.sessionPersistence.open(id, 'read')
    let evidence
    try {
      const events = (await handle.read()).events
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(events.findLast(event => event.type === 'turn/end').data.reason).toMatchObject({ kind: 'completed' })
      const inputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain(marker)
      const assistant = events.findLast(event => event.type === 'assistant/message')
      const reply = assistant.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(reply).toContain(marker)
      evidence = { sessionId: id, marker, reply, steps: 2, turns: 1 }
    } finally { await handle.close() }
    await page.getByText(marker, { exact: true }).waitFor()
    await page.reload()
    await page.getByText(marker, { exact: true }).waitFor()
    return evidence
  } finally { off() }
}
