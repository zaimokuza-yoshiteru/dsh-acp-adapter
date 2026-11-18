import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { expect, it, vi } from 'vitest'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

type WireEvent = {
  method: string
  session: string
  pid: number
  model?: string
  target?: string
  applied?: string
  markers?: string[]
  history?: string[]
}
type Host = Awaited<ReturnType<typeof launchAdapterWorld>>
const provider = 'acp-switch-fixture'
async function start(host: Host, preset = 'acp-adapter') {
  const directory = join(host.workspaceCwd, 'agent-store')
  mkdirSync(directory)
  const fault = (value: string) => writeFileSync(join(directory, 'fault'), value)
  const trace = (): WireEvent[] =>
    readFileSync(join(directory, 'trace'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  fault('none')
  await host.ctx.settings.replace('dsh-acp-adapter', {
    agents: {
      'switch-fixture': {
        name: 'Switch fixture',
        command: process.execPath,
        args: [join(root, 'test/mock-agent/model-switch-agent.ts')],
        env: { HOME: host.workspaceCwd, MOCK_SWITCH_DIRECTORY: directory },
      },
    },
  })
  await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true))
  await host.ctx.agentDefaultModel.saveSelection({ provider, model: 'a' })
  const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd, agentPreset: preset })
  const session = host.ctx.sessions.get(sessionId)!
  const agent = host.ctx.agents.get(sessionId)!
  const choose = (model: string) => host.ctx.sessionController.selectModel({ sessionId, provider, model })
  const submit = async (marker: string) => {
    const previous = session.snapshotEvents().filter((e) => e.type === 'turn/end').length
    await host.ctx.sessionController.prompt(
      {
        sessionId,
        requestId: randomUUID() as SessionRequestId,
        mode: 'queue',
        content: [{ type: 'text', text: 'SWITCH_TEST_' + marker }],
      },
      new AbortController().signal,
    )
    await vi.waitFor(
      () => expect(session.snapshotEvents().filter((e) => e.type === 'turn/end').length).toBeGreaterThan(previous),
      { timeout: 20000 },
    )
    return session.snapshotEvents().findLast((e) => e.type === 'turn/end')!.data.reason
  }
  expect((await submit('FIRST')).kind).toBe('completed')
  const first = trace().find((entry) => entry.method === 'session/prompt')!
  expect(first).toMatchObject({ model: 'a', markers: ['SWITCH_TEST_FIRST'], history: [] })
  const events = () => trace().filter((entry) => entry.session === first.session)
  const prompts = () => trace().filter((entry) => entry.method === 'session/prompt')
  const header = () => session.requestHeader()?.config.model
  const retry = async (model: string) => {
    fault('none')
    if (agent.model.current()?.model !== model) await choose(model)
    expect((await submit('RETRY')).kind).toBe('completed')
    expect(header()).toBe(model)
    expect(prompts()).toHaveLength(2)
    expect(prompts()[1]).toMatchObject({
      session: first.session,
      model,
      markers: ['SWITCH_TEST_RETRY'],
      history: ['SWITCH_TEST_FIRST'],
    })
  }
  await choose('b')
  return { directory, agent, choose, events, prompts, header, fault, submit, retry }
}

it.each(['standard', 'cordis', 'ptc', 'minimal'])(
  'preserves the independent-session boundary for %s',
  async (preset) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host, preset)
      expect(host.ctx.agentPresets.serviceFor(run.agent, 'compaction')).toBeDefined()
      const result = await run.submit('SECOND')
      expect(result.kind).toBe('error')
      expect(JSON.stringify(result)).toContain('ACP_MODEL_SWITCH_UNAVAILABLE')
      expect(run.header()).toBe('a')
      expect(run.events().filter((e) => e.target === 'b')).toEqual([])
      expect(run.prompts()).toHaveLength(1)
    } finally {
      await host.close()
    }
  },
)

it.each(['refuse', 'unconfirmed', 'disconnect-before', 'disconnect-after'])(
  'keeps the committed source and retries on the original ACP session after %s',
  async (failure) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host)
      run.fault(failure)
      expect((await run.submit('SECOND')).kind).toBe('error')
      expect(run.header()).toBe('a')
      expect(run.prompts()).toHaveLength(1)
      expect(run.events().filter((e) => e.target === 'b')).toHaveLength(1)
      const beforeRetry = run.events().length
      await run.retry('b')
      if (failure.startsWith('disconnect')) {
        const retried = run.events().slice(beforeRetry)
        expect(retried[0]).toMatchObject({ method: 'session/load', model: failure === 'disconnect-before' ? 'a' : 'b' })
        expect(retried.filter((e) => e.target === 'b')).toHaveLength(failure === 'disconnect-before' ? 1 : 0)
      }
    } finally {
      await host.close()
    }
  },
)

it.each(['unavailable', 'no-snapshot', 'other-agent'])(
  'holds the old header when reloading the original session returns %s',
  async (fault) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host)
      run.fault('disconnect-after')
      expect((await run.submit('SECOND')).kind).toBe('error')
      const beforeReload = run.events().length
      run.fault(fault)
      expect((await run.submit('RETRY')).kind).toBe('error')
      const attempts = run.events().slice(beforeReload)
      // A replacement process must not even receive the original session ID.
      expect(attempts.some((e) => e.method === 'session/load')).toBe(fault !== 'other-agent')
      expect(attempts.some((e) => e.method === 'session/set_config_option')).toBe(false)
      expect(run.prompts()).toHaveLength(1)
      expect(run.header()).toBe('a')
    } finally {
      await host.close()
    }
  },
)

it('recovers an unacknowledged switch on the original session after the plugin is restarted', async () => {
  const host = await launchAdapterWorld()
  try {
    const run = await start(host)
    run.fault('hold-ack')
    const pending = run.submit('SECOND')
    void pending.catch(() => {})
    await vi.waitFor(() => expect(run.events().some((e) => e.applied === 'b')).toBe(true), { timeout: 10000 })
    const manager = host.ctx.pluginManager
    const plugin = (await manager.listPlugins()).find((row) => row.moduleName === '@zaimokuza/dsh-acp-adapter')!
    expect(await manager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ application: 'applied' })
    expect((await pending).kind).not.toBe('completed')
    expect(run.header()).toBe('a')
    expect(run.prompts()).toHaveLength(1)
    expect(await manager.setPluginEnabled(plugin.entryId, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true))
    const beforeRetry = run.events().length
    await run.retry('b')
    const retried = run.events().slice(beforeRetry)
    expect(retried[0]).toMatchObject({ method: 'session/load', model: 'b' })
    expect(retried.some((e) => e.target === 'b')).toBe(false)
  } finally {
    await host.close()
  }
})

it('verifies the original Agent when switching back after a lost acknowledgement', async () => {
  const host = await launchAdapterWorld()
  try {
    const run = await start(host)
    run.fault('disconnect-after')
    expect((await run.submit('SECOND')).kind).toBe('error')
    const beforeRetry = run.events().length
    await run.choose('a')
    run.fault('other-agent')
    expect((await run.submit('RETRY')).kind).toBe('error')
    expect(run.events().slice(beforeRetry)).toEqual([])
    expect(run.prompts()).toHaveLength(1)
    expect(run.header()).toBe('a')
  } finally {
    await host.close()
  }
})

it.each([false, true])(
  'waits for confirmation before the request header and handles user cancellation (%s)',
  async (cancel) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host)
      run.fault('hold-ack')
      const pending = run.submit('SECOND')
      void pending.catch(() => {})
      await vi.waitFor(() => expect(run.events().some((e) => e.applied === 'b')).toBe(true), { timeout: 10000 })
      expect(run.header()).toBe('a')
      expect(run.prompts()).toHaveLength(1)
      if (cancel) await run.agent.cancel({ kind: 'user' }, { keepInbox: true })
      writeFileSync(join(run.directory, 'ack'), '')
      const end = await pending
      if (cancel) {
        expect(end.kind).not.toBe('completed')
        expect(run.header()).toBe('a')
        expect(run.prompts()).toHaveLength(1)
        await run.choose('a')
        run.fault('none')
        const session = run.agent.session
        const ticket = host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch
        expect(ticket).toBeDefined()
        const settled = host.whenTurnSettled()
        const controls = host.ctx.get('dshAcp') as AcpRemoteService
        await controls.retryModelSwitchInput(session.id, ticket!.failureSeq, new AbortController().signal)
        expect(await settled).toBe(session.id)
        expect(run.header()).toBe('a')
        expect(run.prompts()).toHaveLength(2)
        expect(run.prompts()[1]).toMatchObject({
          session: run.prompts()[0]!.session,
          model: 'a',
          markers: ['SWITCH_TEST_SECOND'],
          history: ['SWITCH_TEST_FIRST'],
        })
      } else {
        expect(end.kind).toBe('completed')
        expect(run.header()).toBe('b')
        const [first, second] = run.prompts()
        expect(second).toMatchObject({
          session: first!.session,
          model: 'b',
          markers: ['SWITCH_TEST_SECOND'],
          history: ['SWITCH_TEST_FIRST'],
        })
      }
    } finally {
      await host.close()
    }
  },
)
