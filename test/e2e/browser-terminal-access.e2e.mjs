import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.mjs'

it('keeps native terminals and permissions intact when the first ACP prompt needs a sandbox change, then permits retry after close', async () => {
  const host = await launchAdapterWorld()
  try {
    const log = join(host.workspaceCwd, 'terminal-access-agent.log')
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: {
      name: 'Devin', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.mjs')],
      env: { MOCK_SCENARIO: 'regression', MOCK_PROFILE: 'devin', MOCK_LOG: log },
    } } })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some(item => item.id === 'acp-devin')).toBe(true))
    await host.ctx.settings.replace('permission', { defaultPreset: 'workspace-write' })
    await host.ctx.agentDefaultModel.saveSelection({ provider: 'acp-devin', model: 'mock-model-a' })
    const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd })
    const resolved = await host.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const agent = resolved.agent
    const session = agent.session
    const policyEvents = () => session.snapshotEvents().filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
    const before = policyEvents()
    const terminal = await host.ctx.terminalController.create(agent, { id: randomUUID(), cols: 80, rows: 24 }, new AbortController().signal)
    const prompt = async () => {
      const turn = session.snapshotEvents().filter(event => event.type === 'turn/end').length
      await host.ctx.sessionController.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'E2E_MESSAGE' }] }, new AbortController().signal)
      await vi.waitFor(() => expect(session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBeGreaterThan(turn), { timeout: 20_000 })
      const reason = session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason
      return reason
    }
    // The source scaffold and installed plugin can load distinct LlmError
    // classes; verify the user-visible failure here, the code in the unit test.
    expect(await prompt()).toMatchObject({ kind: 'error', error: {
      message: expect.stringContaining("Close this session's browser terminals, then send your message again"),
    } })
    expect(policyEvents()).toEqual(before)
    expect(host.ctx.terminalController.list(sessionId)).toEqual([terminal])
    expect(host.ctx.permissionPresets.current(session)).toBe('workspace-write')
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toContain('--> session/prompt')
    expect(session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    await host.ctx.terminalController.close(agent, terminal.id)
    expect(await prompt()).toMatchObject({ kind: 'completed' })
    expect(host.ctx.permissionPresets.current(session)).toBe('custom')
    // An established ACP session can use a browser terminal without changing
    // its access mode again; neither terminal presence nor retries reset it.
    const acpTerminal = await host.ctx.terminalController.create(agent, { id: randomUUID(), cols: 80, rows: 24 }, new AbortController().signal)
    const established = policyEvents()
    expect(await prompt()).toMatchObject({ kind: 'completed' })
    expect(policyEvents()).toEqual(established)
    expect(host.ctx.terminalController.list(sessionId)).toEqual([acpTerminal])
  } finally { await host.close() }
})
