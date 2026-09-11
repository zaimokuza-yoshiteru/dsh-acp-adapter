import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.mjs'

class NativeControl extends LlmAdapter {
  requests = []
  providerInfo(id) { return { id, name: 'Native permission control' } }
  async listModels(provider) { return ['a', 'b'].map(id => ({ provider, id, name: id })) }
  async *stream(options) {
    this.requests.push(options)
    const text = 'NATIVE_DONE'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.each(['kimi', 'devin', 'codex', 'claude'])('permission isolation: %s', profile => {
  it('preserves native choices on blank sessions and applies ACP policy only on execution', async () => {
    const host = await launchAdapterWorld()
    try {
      const native = new NativeControl()
      host.ctx.effect(() => host.ctx.llm.registerAdapter(['native-permission'], native))
      await host.ctx.settings.replace('dsh-acp', { agents: { [profile]: {
        name: profile, command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')],
        env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: profile },
      } } })
      const acp = { provider: `acp-${profile}`, model: 'mock-model-a' }
      const model = { provider: 'native-permission', model: 'a' }
      await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === acp.provider)).toBe(true))
      await host.ctx.settings.replace('permission', { defaultPreset: 'workspace-write' })
      const create = async selection => {
        await host.ctx.agentDefaultModel.saveSelection(selection)
        const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
        return host.ctx.sessions.get(sessionId)
      }
      const select = (session, selection) => host.ctx.sessionController.selectModel({ sessionId: session.id, ...selection })
      const policyEvents = session => session.snapshotEvents().filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
      const preset = session => host.ctx.permissionPresets.current(session)
      const prompt = async (session, succeeds = true) => {
        const before = session.snapshotEvents().filter(event => event.type === 'turn/end').length
        await host.ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: session.id, mode: 'queue', content: [{ type: 'text', text: 'E2E_MESSAGE' }] }, new AbortController().signal)
        await vi.waitFor(() => expect(session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBeGreaterThan(before), { timeout: 20_000 })
        const end = session.snapshotEvents().findLast(event => event.type === 'turn/end')
        if (succeeds) expect(end.data.reason.kind).not.toBe('error')
        else expect(end.data.reason.kind).toBe('error')
      }

      // Reproduce the actual entry path: last used ACP -> New session -> native picker.
      const blank = await create(acp)
      expect(preset(blank)).toBe('workspace-write')
      const original = policyEvents(blank)
      await select(blank, model)
      expect(policyEvents(blank)).toEqual(original)
      await prompt(blank)
      expect(preset(blank)).toBe('workspace-write')
      expect(native.requests).toHaveLength(1)
      expect(JSON.stringify(native.requests[0].messages)).toContain('Approval policy: ask.')
      // Even bypassing the browser's new-session guard must not change native permissions.
      await select(blank, acp)
      await prompt(blank, false)
      expect(policyEvents(blank)).toEqual(original)

      // Native explicit permissions, including a genuine Custom, survive picker changes.
      const explicit = await create(model)
      host.ctx.permissionPresets.set(explicit, 'danger-full-access')
      const fullAccess = policyEvents(explicit)
      await select(explicit, acp)
      await select(explicit, { ...model, model: 'b' })
      expect(policyEvents(explicit)).toEqual(fullAccess)
      await prompt(explicit)
      expect(preset(explicit)).toBe('danger-full-access')
      expect(JSON.stringify(native.requests.at(-1).messages)).toContain('Approval prompts are disabled in this session')
      const custom = await create(acp)
      custom.append('approval/policy', { policy: 'never' })
      expect(preset(custom)).toBe('custom')
      const customEvents = policyEvents(custom)
      await select(custom, model)
      await prompt(custom)
      expect(policyEvents(custom)).toEqual(customEvents)

      // A blank native constructor can actually execute ACP; its first prompt must allow approval.
      await host.ctx.settings.replace('permission', { defaultPreset: 'danger-full-access' })
      const agent = await create(model)
      await select(agent, acp)
      expect(preset(agent)).toBe('danger-full-access')
      await prompt(agent)
      expect(preset(agent)).toBe('custom')
      const snapshot = agent.snapshotEvents().find(event => event.type === 'user/message' && event.data.source?.form === 'snapshot')
      expect(JSON.stringify(snapshot)).toContain('Approval policy: ask.')
      expect(JSON.stringify(snapshot)).not.toContain('Approval prompts are disabled in this session')
      const applied = policyEvents(agent)
      await prompt(agent)
      expect(policyEvents(agent)).toEqual(applied)
      // The ACP session override never becomes the default for another conversation.
      expect(preset(await create(model))).toBe('danger-full-access')

      // Unselected blank Web sessions follow the live native default, not constructor options.
      const implicitNative = await create(acp)
      await host.ctx.agentDefaultModel.saveSelection(model)
      await prompt(implicitNative)
      expect(preset(implicitNative)).toBe('danger-full-access')
      const implicitAcp = await create(model)
      await host.ctx.agentDefaultModel.saveSelection(acp)
      await prompt(implicitAcp)
      expect(preset(implicitAcp)).toBe('custom')
    } finally { await host.close() }
  })
})
