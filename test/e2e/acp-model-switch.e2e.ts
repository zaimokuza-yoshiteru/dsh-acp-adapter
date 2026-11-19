import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { expect, it, vi } from 'vitest'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { ACP_AGENT_MANAGED_MODEL_ID } from '../../src/contract/model-selection.ts'
import { launchAdapterWorld, root } from './scaffold.ts'

type WireEvent = {
  method: string
  session: string
  pid: number
  model?: string
  target?: string
  selectorId?: string
  applied?: string
  markers?: string[]
  images?: string[]
  history?: string[]
}
type Host = Awaited<ReturnType<typeof launchAdapterWorld>>
const provider = 'acp-switch-fixture'
async function openFixture(host: Host, preset: string, managed: boolean, env: Record<string, string> = {}) {
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
        env: {
          HOME: host.workspaceCwd,
          MOCK_SWITCH_DIRECTORY: directory,
          ...(managed ? { MOCK_SWITCH_AGENT_NAME: 'OpenCode' } : {}),
          ...env,
        },
      },
    },
  })
  await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true))
  await host.ctx.agentDefaultModel.saveSelection({ provider, model: managed ? ACP_AGENT_MANAGED_MODEL_ID : 'a' })
  const { sessionId } = await host.ctx.sessionController.create({ cwd: host.workspaceCwd, agentPreset: preset })
  const session = host.ctx.sessions.get(sessionId)!
  const agent = host.ctx.agents.get(sessionId)!
  return { directory, trace, fault, agent, session, sessionId }
}

async function start(host: Host, preset = 'acp-adapter', managed = false, steering = false) {
  const { directory, trace, fault, agent, session, sessionId } = await openFixture(
    host,
    preset,
    managed,
    steering ? { MOCK_SWITCH_STEERING: 'yes' } : {},
  )
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
  if (!managed) await choose('b')
  return { directory, agent, choose, events, prompts, header, fault, submit, retry }
}

it('keeps the first unsent image available to retry on a model that supports it', async () => {
  const host = await launchAdapterWorld({ adapterDirectory: process.env.DSH_E2E_ADAPTER_DIRECTORY ?? root })
  try {
    const { session, sessionId, trace } = await openFixture(host, 'standard', true, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          fixture: {
            models: {
              text: { modalities: { input: ['text'] } },
              vision: { modalities: { input: ['text', 'image'] } },
            },
          },
        },
      }),
    })
    const controls = host.ctx.get('dshAcp') as AcpRemoteService
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMImHYnYNodBggFAC8WBwlf8b0ZAAAAAElFTkSuQmCC'
    const first = host.whenTurnSettled()
    await host.ctx.sessionController.prompt(
      {
        sessionId,
        requestId: randomUUID() as SessionRequestId,
        mode: 'queue',
        content: [
          { type: 'text', text: 'SWITCH_TEST_IMAGE' },
          { type: 'image', mediaType: 'image/png', data: png },
        ],
      },
      new AbortController().signal,
    )
    expect(await first).toBe(sessionId)
    expect(
      JSON.stringify(session.snapshotEvents().findLast((event) => event.type === 'turn/end')?.data.reason),
    ).toContain('MODEL_DOES_NOT_SUPPORT_IMAGES')
    expect(trace().filter((event) => event.method === 'session/prompt')).toHaveLength(0)
    const snapshot = await controls.agentSessionSnapshot(sessionId)
    expect(snapshot).toMatchObject({
      freshness: 'live',
      managedModel: { optionId: 'model', confirmed: 'fixture/text' },
    })
    const failure = host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch
    expect(failure).toBeDefined()
    const switchResult = await controls.setAgentSessionOption(sessionId, {
      kind: 'config',
      id: 'model',
      value: 'fixture/vision',
    })
    expect(switchResult.managedModel?.confirmed).toBe('fixture/vision')
    const selection = trace().findLast(
      (event) => event.method === 'session/set_config_option' && event.target === 'fixture/vision',
    )
    expect(selection).toBeDefined()
    const retry = host.whenTurnSettled()
    await controls.retryModelSwitchInput(sessionId, failure!.failureSeq, new AbortController().signal)
    expect(await retry).toBe(sessionId)
    expect(trace().filter((event) => event.method === 'session/prompt')).toMatchObject([
      {
        session: selection!.session,
        model: 'fixture/vision',
        markers: ['SWITCH_TEST_IMAGE'],
        images: [expect.any(String)],
      },
    ])
    expect(
      session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'user'),
    ).toHaveLength(1)
    await expect(
      controls.retryModelSwitchInput(sessionId, failure!.failureSeq, new AbortController().signal),
    ).rejects.toThrow()
  } finally {
    await host.close()
  }
})

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

it.each(['standard', 'cordis', 'ptc', 'minimal'])(
  'changes the Agent model on the original %s session with a stable DSH route',
  async (preset) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host, preset, true)
      const controls = host.ctx.get('dshAcp') as AcpRemoteService
      const first = run.prompts()[0]!
      const db = new DatabaseSync(join(host.ctx.dshHomePath!('dsh-acp'), 'sidecar.sqlite'), { readOnly: true })
      try {
        const dispatch = db.prepare(
          "SELECT model,json_extract(provenance,'$.confirmedAgentModel') AS actual FROM dispatch_ledger WHERE dsh_session_id=?",
        )
        expect(dispatch.all(run.agent.id)).toEqual([{ model: ACP_AGENT_MANAGED_MODEL_ID, actual: 'a' }])
        const before = await controls.agentSessionSnapshot(run.agent.id)
        expect(before.managedModel?.confirmed).toBe('a')
        const selected = await controls.setAgentSessionOption(run.agent.id, {
          kind: 'config',
          id: before.managedModel!.optionId,
          value: 'b',
        })
        expect(selected.managedModel?.confirmed).toBe('b')
        expect((await run.submit('SECOND')).kind).toBe('completed')
        expect(run.header()).toBe(ACP_AGENT_MANAGED_MODEL_ID)
        expect(dispatch.all(run.agent.id)).toEqual([{ model: ACP_AGENT_MANAGED_MODEL_ID, actual: 'b' }])
        expect(
          db
            .prepare('SELECT model,ordinal FROM managed_model_turns WHERE dsh_session_id=? ORDER BY ordinal')
            .all(run.agent.id),
        ).toEqual([
          { model: 'a', ordinal: 1 },
          { model: 'b', ordinal: 2 },
        ])
      } finally {
        db.close()
      }
      expect(run.prompts()).toHaveLength(2)
      expect(run.prompts()[1]).toMatchObject({ session: first.session, model: 'b', history: ['SWITCH_TEST_FIRST'] })
    } finally {
      await host.close()
    }
  },
)

it.each(['refuse', 'unconfirmed', 'disconnect-before', 'disconnect-after'])(
  'blocks input on an unconfirmed managed selection (%s) until one explicit resend',
  async (fault) => {
    const host = await launchAdapterWorld()
    try {
      const run = await start(host, 'standard', true)
      const controls = host.ctx.get('dshAcp') as AcpRemoteService
      const session = run.agent.session
      const { managedModel } = await controls.agentSessionSnapshot(session.id)
      run.fault(fault)
      await expect(
        controls.setAgentSessionOption(session.id, { kind: 'config', id: managedModel!.optionId, value: 'b' }),
      ).rejects.toThrow()
      expect((await run.submit('SECOND')).kind).toBe('error')
      expect(run.prompts()).toHaveLength(1)
      const ticket = host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch
      expect(ticket).toBeDefined()
      run.fault('none')
      const settled = host.whenTurnSettled()
      await controls.retryModelSwitchInput(session.id, ticket!.failureSeq, new AbortController().signal)
      await settled
      expect(run.prompts()).toHaveLength(2)
      expect(run.prompts()[1]).toMatchObject({
        session: run.prompts()[0]!.session,
        model: 'b',
        markers: ['SWITCH_TEST_SECOND'],
        history: ['SWITCH_TEST_FIRST'],
      })
    } finally {
      await host.close()
    }
  },
)

it('keeps input available when the original Agent reloads with a renamed model selector', async () => {
  const host = await launchAdapterWorld()
  try {
    const run = await start(host, 'standard', true)
    const session = run.agent.session
    const manager = host.ctx.pluginManager
    const plugin = (await manager.listPlugins()).find((entry) => entry.moduleName === '@zaimokuza/dsh-acp-adapter')!
    expect(await manager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ application: 'applied' })
    run.fault('renamed-selector')
    expect(await manager.setPluginEnabled(plugin.entryId, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((entry) => entry.id === provider)).toBe(true))
    expect((await run.submit('SECOND')).kind).toBe('error')
    const loads = run.events().filter((entry) => entry.method === 'session/load')
    expect(loads.at(-1)).toMatchObject({ selectorId: 'llm_model', model: 'a' })
    expect(run.events().filter((entry) => entry.method === 'session/set_config_option')).toHaveLength(0)
    expect(run.prompts()).toHaveLength(1)
    const unsent = host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch
    expect(unsent).toBeDefined()
    run.fault('none')
    const settled = host.whenTurnSettled()
    const controls = host.ctx.get('dshAcp') as AcpRemoteService
    await controls.retryModelSwitchInput(session.id, unsent!.failureSeq, new AbortController().signal)
    expect(await settled).toBe(session.id)
    expect(run.prompts()).toHaveLength(2)
    expect(run.prompts()[1]).toMatchObject({
      session: run.prompts()[0]!.session,
      model: 'a',
      markers: ['SWITCH_TEST_SECOND'],
      history: ['SWITCH_TEST_FIRST'],
    })
  } finally {
    await host.close()
  }
})

it('retries a verified final-lease failure once without duplicating the native user message', async () => {
  const host = await launchAdapterWorld()
  try {
    const run = await start(host, 'cordis', true)
    const session = run.agent.session
    const controls = () => host.ctx.get('dshAcp') as AcpRemoteService
    await controls().setAgentSessionOption(session.id, { kind: 'config', id: 'model', value: 'b' })
    const manager = host.ctx.pluginManager
    const plugin = (await manager.listPlugins()).find((p) => p.moduleName === '@zaimokuza/dsh-acp-adapter')!
    expect(await manager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ application: 'applied' })
    expect(await manager.setPluginEnabled(plugin.entryId, true)).toMatchObject({ application: 'applied' })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((p) => p.id === provider)).toBe(true))
    run.fault('refuse-second-lease')
    expect((await run.submit('SECOND')).kind).toBe('error')
    expect(run.prompts()).toHaveLength(1)
    const ticket = host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch
    expect(ticket).toBeDefined()
    const users = () =>
      session.snapshotEvents().filter((ev) => ev.type === 'user/message' && ev.data.source.kind === 'user')
    expect(users()).toHaveLength(2)
    run.fault('none')
    const settled = host.whenTurnSettled()
    await controls().retryModelSwitchInput(session.id, ticket!.failureSeq, new AbortController().signal)
    await settled
    expect(users()).toHaveLength(2)
    expect(run.prompts()).toHaveLength(2)
    expect(run.prompts()[1]).toMatchObject({
      session: run.prompts()[0]!.session,
      model: 'b',
      markers: ['SWITCH_TEST_SECOND'],
      history: ['SWITCH_TEST_FIRST'],
    })
    await expect(
      controls().retryModelSwitchInput(session.id, ticket!.failureSeq, new AbortController().signal),
    ).rejects.toThrow()
  } finally {
    await host.close()
  }
})

it('keeps a delivered protocol failure out of the resend path and permits an explicit return to A', async () => {
  const host = await launchAdapterWorld()
  try {
    const run = await start(host, 'standard', true)
    const controls = host.ctx.get('dshAcp') as AcpRemoteService
    const session = run.agent.session
    const select = (value: string) => controls.setAgentSessionOption(session.id, { kind: 'config', id: 'model', value })
    await select('b')
    run.fault('prompt-error')
    expect((await run.submit('SECOND')).kind).toBe('error')
    expect(host.ctx.sessionProjections.snapshot(session).values.acpExecution?.unsentModelSwitch).toBeUndefined()
    expect((await controls.agentSessionSnapshot(session.id)).managedModel?.recovery).toBe('possibly-delivered')
    run.fault('none')
    expect((await select('a')).managedModel?.recovery).toBeUndefined()
    expect((await run.submit('CONTINUE')).kind).toBe('completed')
    expect(run.prompts().map((p) => [p.model, p.markers])).toEqual([
      ['a', ['SWITCH_TEST_FIRST']],
      ['b', ['SWITCH_TEST_SECOND']],
      ['a', ['SWITCH_TEST_CONTINUE']],
    ])
  } finally {
    await host.close()
  }
})

it.each([false, true])('verifies the original running model before native steering (model drift %s)', async (drift) => {
  const host = await launchAdapterWorld()
  let gate: string | undefined
  try {
    const run = await start(host, 'standard', true, true)
    const controls = host.ctx.get('dshAcp') as AcpRemoteService
    await controls.setAgentSessionOption(run.agent.id, { kind: 'config', id: 'model', value: 'b' })
    gate = join(run.directory, 'finish-steering')
    run.fault(drift ? 'hold-steering-drift' : 'hold-steering')
    const active = run.submit('ACTIVE')
    void active.catch(() => {})
    await vi.waitFor(() => expect(run.events().some((e) => e.markers?.includes('SWITCH_TEST_ACTIVE'))).toBe(true))
    if (drift)
      await vi.waitFor(async () =>
        expect((await controls.agentSessionSnapshot(run.agent.id)).managedModel?.confirmed).toBeNull(),
      )
    run.agent.steer(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'SWITCH_TEST_STEER' }] }),
    )
    if (!drift)
      await vi.waitFor(() => expect(run.events().filter((e) => e.method === '_session/steering')).toHaveLength(1), {
        timeout: 10000,
      })
    else
      await vi.waitFor(
        () =>
          expect(
            run.agent.session.snapshotEvents().some((e) => e.type === 'turn/end' && e.data.reason.kind === 'error'),
          ).toBe(true),
        { timeout: 10000 },
      )
    writeFileSync(gate, 'done')
    const result = await active
    expect(result.kind).toBe(drift ? 'error' : 'completed')
    expect(
      run
        .events()
        .filter((e) => e.method === '_session/steering')
        .map((e) => [e.model, e.markers]),
    ).toEqual(drift ? [] : [['b', ['SWITCH_TEST_STEER']]])
    expect(run.prompts()).toHaveLength(2)
  } finally {
    if (gate) writeFileSync(gate, 'done')
    await host.close()
  }
})
