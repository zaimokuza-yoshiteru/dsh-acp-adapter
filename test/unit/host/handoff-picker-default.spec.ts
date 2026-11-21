import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HandoffPickerDefault } from '../../../src/host/handoff/picker-default.ts'
import type { AcpHandoffTarget } from '../../../src/contract/handoff.ts'

const source = { provider: 'native', model: 'source' }
const target = { provider: 'acp-agent', model: 'selected' }
const initial = { provider: 'native', model: 'preferred' }

function fixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const notify = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args)
  const nativeWrite = new AsyncLocalStorage<boolean>()
  let value = initial,
    revision = 7,
    selection = target
  const setDefault = (next: typeof initial) => {
    value = next
    revision++
    nativeWrite.run(true, () => notify('settings/document-updated', 'default', revision))
  }
  const settings = {
    describe: () => [{ ns: 'default', revision, value, user: value }],
    replace: vi.fn(async (_ns: string, previous: typeof initial, expected: number) => {
      expect(nativeWrite.getStore()).toBeUndefined()
      expect(expected).toBe(revision)
      setDefault(previous)
    }),
  }
  const session = { id: 'source-session', header: {}, requestHeader: () => ({ config: source }) }
  const model = {
    current: () => selection,
    select: (next: AcpHandoffTarget) => {
      selection = next
      notify('session/event', session, { type: 'model/selection', data: next })
    },
  }
  const services = {
    settings,
    llm: { listModels: () => [{ id: source.model }], resolveCallConfig: async () => source },
    agents: { get: () => ({ session, model }) },
    configEditor: { entries: () => [{ options: { name: '@deepseek-ai/dsh-agent-default-model', id: 'default' } }] },
  }
  const agent = { session, model }
  services.agents.get = () => agent
  const ctx = {
    on: (name: string, listener: (...a: unknown[]) => void) => listeners.set(name, listener),
    get: (key: keyof typeof services) => services[key],
  } as unknown as Context
  const owner = new HandoffPickerDefault(ctx, (p) => p.startsWith('acp-'))
  notify('session/event', session, { type: 'model/selection', data: target })
  return {
    setDefault,
    read: () => value,
    settings,
    notify,
    session,
    model,
    restore: () => owner.restore('source-session', source, target, () => {}),
  }
}

it.each([false, true])('preserves a distinct profile default when the picker write settles late=%s', async (late) => {
  const f = fixture()
  if (!late) f.setDefault(target)
  await f.restore()
  if (late) f.setDefault(target)
  expect(f.model.current()).toEqual(source)
  await vi.waitFor(() => expect(f.read()).toEqual(initial))
  expect(f.settings.replace).toHaveBeenCalledTimes(1)
})

it('restores the source selection while preserving an intervening preference or another session’s selection', async () => {
  for (const concurrentPicker of [false, true]) {
    const f = fixture()
    f.setDefault(target)
    if (concurrentPicker)
      f.notify('session/event', { requestHeader: () => undefined }, { type: 'model/selection', data: initial })
    f.setDefault({ provider: 'elsewhere', model: 'chosen' })
    await f.restore()
    expect(f.model.current()).toEqual(source)
    expect(f.read()).toEqual({ provider: 'elsewhere', model: 'chosen' })
    expect(f.settings.replace).not.toHaveBeenCalled()
  }
})
