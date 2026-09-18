import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { required } from './required.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.ts'

it('keeps user terminals running when the first ACP prompt projects Agent permissions', async () => {
  // Exercise a real PTY without running the developer's shell startup scripts,
  // which may keep spawning unrelated processes while the test closes it.
  const host = await launchAdapterWorld({ terminalShell: process.platform === 'win32'
    ? { path: 'cmd.exe', name: 'Test shell', args: ['/D', '/Q'] }
    : { path: '/bin/sh', name: 'Test shell', args: ['-i'] } })
  try {
    const log = join(host.workspaceCwd, 'terminal-access-agent.log')
    await host.ctx.settings.replace('dsh-acp', { agents: { devin: {
      name: 'Devin', command: process.execPath, args: [join(root, 'test/mock-agent/mock-agent.ts')],
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
    expect(host.ctx.permissionPresets.current(session)).toBe('workspace-write')
    const terminal = await host.ctx.terminalController.create(agent, { id: randomUUID() as WebTerminalId, cols: 80, rows: 24 }, new AbortController().signal)
    const prompt = async () => {
      const turn = session.snapshotEvents().filter(event => event.type === 'turn/end').length
      await host.ctx.sessionController.prompt({ requestId: randomUUID() as SessionRequestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 'E2E_MESSAGE' }] }, new AbortController().signal)
      await vi.waitFor(() => expect(session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBeGreaterThan(turn), { timeout: 20_000 })
      const reason = required(session.snapshotEvents().findLast(event => event.type === 'turn/end')).data.reason
      return reason
    }
    // Alpha.2 user terminals have independent system-user permissions. Changing
    // Agent policy must neither block its prompt nor replace the user's shell.
    expect(await prompt()).toMatchObject({ kind: 'completed' })
    expect(host.ctx.terminalController.list(sessionId)).toEqual([terminal])
    expect(host.ctx.permissionPresets.current(session)).toBe('custom')
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toContain('--> session/prompt')
    expect(session.snapshotEvents().some(event => event.type === 'request/header')).toBe(true)
    await host.ctx.terminalController.close(agent, terminal.id)
    expect(await prompt()).toMatchObject({ kind: 'completed' })
    expect(host.ctx.permissionPresets.current(session)).toBe('custom')
    // An established ACP session can use a browser terminal without changing
    // its access mode again; neither terminal presence nor retries reset it.
    const acpTerminal = await host.ctx.terminalController.create(agent, { id: randomUUID() as WebTerminalId, cols: 80, rows: 24 }, new AbortController().signal)
    const established = policyEvents()
    expect(await prompt()).toMatchObject({ kind: 'completed' })
    expect(policyEvents()).toEqual(established)
    expect(host.ctx.terminalController.list(sessionId)).toEqual([acpTerminal])
  } finally { await host.close() }
})
