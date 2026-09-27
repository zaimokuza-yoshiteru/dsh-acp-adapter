import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { describe, expect, it, vi } from 'vitest'
import { installSearchableModelPickerSlot } from '../../../src/client/ui/model-picker-slot.ts'
import type { ModelDirectoryResolverFace, ModelPickerSessionsFace, ModelPickerSlots, PickerSettingsScope } from '../../../src/client/ui/model-picker-slot.ts'

describe('searchable model picker slot lifecycle', () => {
  it('leaves the native occupant alone by default and disposes/re-registers its shadow as the setting changes', async () => {
    let snapshot: { status: 'ready'; value: { agents: Record<string, never>; searchableModelPicker?: boolean } } = {
      status: 'ready', value: { agents: {} },
    }
    const listeners = new Set<() => void>()
    const subscribe = vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    let factory: (() => () => void) | undefined
    let disposeInjection: (() => void) | undefined
    let disposeSeat: (() => void) | undefined
    const unregister = vi.fn()
    const register = vi.fn((_options: Parameters<ModelPickerSlots['register']>[0]) => {
      const generation = register.mock.calls.length
      return () => { unregister(generation) }
    })
    const directory = {
      store: createSnapshotStore<ModelDirectoryState>({ current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null }),
      load: vi.fn(async () => undefined),
      select: vi.fn(async (_selection: ModelSelection): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    }
    const directories: ModelDirectoryResolverFace = { directoryFor: vi.fn(() => directory) }
    const sessions: ModelPickerSessionsFace = { subagentAddress: vi.fn(() => undefined) }
    const slots: ModelPickerSlots = {
      inject: vi.fn((_name: 'conversation.input.model', next: () => () => void) => {
        factory = next
        return () => disposeSeat?.()
      }),
      register,
    }
    const settings: PickerSettingsScope = {
      getSnapshot: () => snapshot,
      subscribe,
    }
    disposeInjection = installSearchableModelPickerSlot(slots, settings, directories, sessions)

    expect(slots.inject).toHaveBeenCalledWith('conversation.input.model', expect.any(Function))
    expect(register).not.toHaveBeenCalled()
    disposeSeat = factory?.()
    expect(register).not.toHaveBeenCalled()

    snapshot = { status: 'ready', value: { agents: {}, searchableModelPicker: true } }
    for (const listener of listeners) listener()
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'conversation.input.model', priority: -1, locale: 'acpModelPicker' })
    const first = register.mock.calls[0]?.[0]
    expect(first).toBeDefined()
    if (first === undefined) throw new Error('picker registration missing')
    const injected = first.inject('session-1' as SessionId)
    expect(injected).toMatchObject({ available: true, directory: directory.store })
    injected.load()
    await vi.waitFor(() => expect(directory.load).toHaveBeenCalledTimes(1))

    snapshot = { status: 'ready', value: { agents: {}, searchableModelPicker: false } }
    for (const listener of listeners) listener()
    expect(unregister).toHaveBeenCalledTimes(1)

    snapshot = { status: 'ready', value: { agents: {}, searchableModelPicker: true } }
    for (const listener of listeners) listener()
    expect(register).toHaveBeenCalledTimes(2)
    disposeInjection?.()
    expect(unregister).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
  })

  it('does not expose session selection for an addressed subagent', async () => {
    let factory: (() => () => void) | undefined
    let disposeFactory: (() => void) | undefined
    let options: { inject(sessionId: SessionId): { available: boolean; select(value: never): Promise<unknown> } } | undefined
    const directory = {
      store: createSnapshotStore<ModelDirectoryState>({ current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null }),
      load: vi.fn(async () => undefined),
      select: vi.fn(async (_selection: ModelSelection): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    }
    const slots: ModelPickerSlots = {
      inject: (_name, next) => { factory = next; return () => undefined },
      register: (value) => { options = value; return () => undefined },
    }
    const settings: PickerSettingsScope = {
      getSnapshot: () => ({ status: 'ready', value: { agents: {}, searchableModelPicker: true } }),
      subscribe: () => () => undefined,
    }
    const directories: ModelDirectoryResolverFace = { directoryFor: () => directory }
    const sessions: ModelPickerSessionsFace = { subagentAddress: () => ({ parentSessionId: 'parent' }) }
    const disposeSlot = installSearchableModelPickerSlot(slots, settings, directories, sessions)
    disposeFactory = factory?.()
    const injected = options?.inject('child-session' as SessionId)
    expect(injected?.available).toBe(false)
    await injected?.select({} as never)
    expect(directory.select).not.toHaveBeenCalled()
    disposeSlot()
    disposeFactory?.()
  })
})
