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
    revision = 7
  const setDefault = (next: typeof initial) => {
    if (value.provider === next.provider && value.model === next.model) return
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
  function open(id: string, selected: AcpHandoffTarget) {
    const session = { id, header: {}, requestHeader: () => ({ config: source }) }
    let selection = selected
    const model = {
      current: () => selection,
      select: (next: AcpHandoffTarget) => {
        selection = next
        notify('session/event', session, { type: 'model/selection', data: next })
      },
    }
    return { session, model }
  }
  const first = open('source-session', target)
  const agents = new Map([[first.session.id, first]])
  const services = {
    settings,
    llm: { listModels: () => [{ id: source.model }], resolveCallConfig: async () => source },
    agents: { get: (id: string) => agents.get(id) },
    configEditor: { entries: () => [{ options: { name: '@deepseek-ai/dsh-agent-default-model', id: 'default' } }] },
  }
  const ctx = {
    on: (name: string, listener: (...a: unknown[]) => void) => listeners.set(name, listener),
    get: (key: keyof typeof services) => services[key],
  } as unknown as Context
  const owner = new HandoffPickerDefault(ctx, (p) => p.startsWith('acp-'))
  first.model.select(target)
  return {
    setDefault,
    read: () => value,
    settings,
    notify,
    model: first.model,
    pickInSecondWindow: (next: typeof target) => {
      const second = open('other-session', next)
      agents.set(second.session.id, second)
      second.model.select(next)
      return () => owner.restore(second.session.id, source, next, () => {})
    },
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

it.each([false, true])(
  'preserves the original default for two simultaneous cross-provider picks, first write persisted=%s',
  async (persisted) => {
    const f = fixture()
    const second = { provider: 'acp-second', model: 'two' }
    if (persisted) f.setDefault(target)
    const restoreSecond = f.pickInSecondWindow(second)
    await restoreSecond()
    if (!persisted) f.setDefault(target)
    await f.restore()
    f.setDefault(second)
    await vi.waitFor(() => expect(f.read()).toEqual(initial))
    expect(f.settings.replace).toHaveBeenCalledTimes(1)
  },
)

it('keeps a separate settings change made between two provisional selections', async () => {
  const f = fixture()
  const explicit = { provider: 'native', model: 'new preference' }
  f.setDefault(target)
  f.setDefault(explicit)
  const second = { provider: 'acp-second', model: 'two' }
  const restoreSecond = f.pickInSecondWindow(second)
  f.setDefault(second)
  await f.restore()
  await restoreSecond()
  expect(f.read()).toEqual(explicit)
})

it('restores a shared target once when two windows picked the same model', async () => {
  const f = fixture()
  f.setDefault(target)
  const restoreSecond = f.pickInSecondWindow(target)
  await f.restore()
  await restoreSecond()
  expect(f.read()).toEqual(initial)
  expect(f.settings.replace).toHaveBeenCalledTimes(1)
})
