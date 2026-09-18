import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { required } from './required.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.ts'

it('keeps working ACP routes after a refused profile update and supports repair and removal', async () => {
  const host = await launchAdapterWorld()
  try {
    const config = {
      name: 'Original Devin', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
      env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin' },
    }
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: config } })
    const provider = () => host.ctx.llm.listProviders().find(item => item.id === 'acp-devin')
    await vi.waitFor(() => expect(provider()?.name).toBe(`${config.name} · ACP`))
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
    const session = required(host.ctx.sessions.get(sessionId))
    const prompt = async () => {
      const turns = session.snapshotEvents().filter(event => event.type === 'turn/end').length
      await host.ctx.sessionController.prompt({ requestId: randomUUID() as SessionRequestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 'E2E_MESSAGE' }] }, new AbortController().signal)
      await vi.waitFor(() => expect(session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBeGreaterThan(turns), { timeout: 20_000 })
      expect(required(session.snapshotEvents().findLast(event => event.type === 'turn/end')).data.reason.kind).toBe('completed')
    }
    await prompt()
    class OccupiedRoute extends LlmAdapter {
      providerInfo(id: string) { return { id, name: 'Other plugin' } }
      async listModels() { return [] }
      async *stream(): ReturnType<LlmAdapter['stream']> { throw new Error('The occupied route must never execute') }
    }
    const occupied = new OccupiedRoute()
    const release = host.ctx.llm.registerAdapter(['acp-collision'], occupied)
    try {
      await host.ctx.settings.replace('dsh-acp', { agents: {
        devin: { ...config, name: 'Uncommitted name' },
        collision: { ...config, name: 'Conflicting profile' },
      } })
      expect(provider()?.name).toBe(`${config.name} · ACP`)
      expect(host.ctx.llm.listProviders().find(item => item.id === 'acp-collision')?.name).toBe('Other plugin')
      await prompt()
    } finally { release() }
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: { ...config, name: 'Repaired Devin' } } })
    await vi.waitFor(() => expect(provider()?.name).toBe('Repaired Devin · ACP'))
    await prompt()
    await host.ctx.settings.replace('dsh-acp', { agents: {} })
    await vi.waitFor(() => expect(provider()).toBeUndefined())
    expect((await host.ctx.sessionController.modelCatalog()).routableProviders).not.toContain('acp-devin')
  } finally { await host.close() }
})
