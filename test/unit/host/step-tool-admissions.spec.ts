import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installStepToolAdmissions } from '../../../src/host/tools/step-tool-admissions.ts'

function fixture() {
  const listeners = new Map<string, (...args: any[]) => any>()
  let dispose: (() => void) | undefined
  const ctx = {
    on(name: string, listener: (...args: any[]) => any) {
      listeners.set(name, listener)
    },
    effect(acquire: () => () => void) {
      dispose = acquire()
    },
  } as unknown as Context
  const read = installStepToolAdmissions(ctx)
  const agent = { id: 'same-id', session: {} } as Agent
  const controller = new AbortController()
  const modelSelection = { provider: 'acp-test', model: 'model' }
  const definition = { name: 'conditional' } as ToolDefinition
  const admitted = new Map([[definition.name, definition]])
  let closed = false
  const toolSet: ResolvedToolSet = {
    dispose: vi.fn(() => {
      closed = true
    }),
    view: (scope) => (!closed && scope === agent ? admitted : new Map()),
  }
  const context = { agent, scope: agent, toolSet, signal: controller.signal, modelSelection }
  const assemble = (input: object = context) => listeners.get('system-prompt/assemble')!({}, input, async () => ({}))
  const prepare = (step = 1, next = async () => ({ kind: 'enter', messages: [] })) =>
    listeners.get('agent/pre-step')!({ agent, signal: controller.signal, modelSelection, turn: 1, step }, next)
  const event = (type: 'step/start' | 'step/end', step = 1) =>
    listeners.get('session/event')!(agent.session, { type, data: { turn: 1, step } })
  return {
    read,
    agent,
    controller,
    modelSelection,
    context,
    toolSet,
    assemble,
    prepare,
    event,
    listeners,
    dispose: () => dispose!(),
  }
}

describe('borrowed Host step tool admission', () => {
  it('keeps the exact set across retries and diagnostic assemblies, opening only after committed start', async () => {
    const f = fixture()
    await f.assemble()
    await f.assemble({ agent: f.agent, scope: f.agent, signal: new AbortController().signal })
    await f.prepare()
    expect(f.read(f.agent)?.isActive()).toBe(false)
    f.event('step/start')
    const admission = f.read(f.agent)!
    expect(admission.toolSet).toBe(f.toolSet)
    expect(admission.isActive()).toBe(true)
    await f.assemble({ agent: f.agent, scope: f.agent })
    expect(f.read(f.agent)).toBe(admission)
    expect(admission.isActive()).toBe(true)
    f.event('step/end')
    expect(admission.isActive()).toBe(false)
    expect(f.read(f.agent)).toBe(admission)
    expect(f.toolSet.dispose).not.toHaveBeenCalled()
  })

  it('does not admit rejected or throwing preparation and ignores stale start facts', async () => {
    const f = fixture()
    await f.assemble()
    await f.prepare(1, async () => ({ kind: 'reject', messages: [] }))
    f.event('step/start')
    expect(f.read(f.agent)).toBeUndefined()
    await f.assemble()
    await expect(
      f.prepare(2, async () => {
        throw new Error('preparation failed')
      }),
    ).rejects.toThrow('preparation failed')
    f.event('step/start', 2)
    expect(f.read(f.agent)).toBeUndefined()
    expect(f.toolSet.dispose).not.toHaveBeenCalled()
  })

  it('does not open a proposal if an outer hook rejects before step/start', async () => {
    const f = fixture()
    await f.assemble()
    await f.prepare()
    f.toolSet.dispose()
    expect(f.read(f.agent)?.isActive()).toBe(false)
    f.event('step/start', 2)
    expect(f.read(f.agent)?.isActive()).toBe(false)
  })

  it('separates steps sharing a turn signal and retains no admission for replacement Agent instances', async () => {
    const f = fixture()
    await f.assemble()
    await f.prepare()
    f.event('step/start')
    const first = f.read(f.agent)!
    f.event('step/end')
    const nextSet = { dispose: vi.fn(), view: f.toolSet.view }
    await f.assemble({ ...f.context, toolSet: nextSet })
    await f.prepare(2)
    f.event('step/start', 2)
    expect(f.read(f.agent)?.toolSet).toBe(nextSet)
    expect(f.read(f.agent)?.isActive()).toBe(true)
    expect(first.isActive()).toBe(false)
    expect(f.read({ ...f.agent } as Agent)).toBeUndefined()
    f.controller.abort()
    expect(f.read(f.agent)?.isActive()).toBe(false)
    f.dispose()
    expect(f.read(f.agent)).toBeUndefined()
    expect(nextSet.dispose).not.toHaveBeenCalled()
  })

  it('closes admission on idle even if a failed durable step/end write emitted no event', async () => {
    const f = fixture()
    await f.assemble()
    await f.prepare()
    f.event('step/start')
    const admission = f.read(f.agent)!
    expect(admission.isActive()).toBe(true)
    f.listeners.get('agent/status')!({ agent: f.agent, status: 'idle' })
    expect(admission.isActive()).toBe(false)
    expect(f.read(f.agent)).toBe(admission)
    expect(f.toolSet.dispose).not.toHaveBeenCalled()
  })

  it('rejects a different assembly model/signal and drops disposed Agent state', async () => {
    const f = fixture()
    await f.assemble({ ...f.context, modelSelection: { ...f.modelSelection } })
    await f.prepare()
    expect(f.read(f.agent)).toBeUndefined()
    await f.assemble()
    await f.prepare()
    f.event('step/start')
    const admitted = f.read(f.agent)!
    f.listeners.get('agent/disposed')!({ agent: f.agent })
    expect(f.read(f.agent)).toBeUndefined()
    expect(admitted.isActive()).toBe(false)
    expect(f.toolSet.dispose).not.toHaveBeenCalled()
  })
})
