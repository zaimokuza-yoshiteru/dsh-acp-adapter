import { expect, it, vi } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotCore, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { installAcpAssistantStream } from '../../../src/client/ui/AcpAssistantStream.ts'

const HEADER = 'conversation.session.header'
const ACTIONS = 'conversation.session.header.views.actions'
const Native = () => null
const Replacement = () => null
type HeaderFace = {
  hooks: {
    conversationViews?: ObservableSnapshot<readonly ViewTab[]>
    entryPins?: object
    entryActions?: object
    replacement?: boolean
  }
  selectView?: (id: string) => void
  open?: (id: string) => void
  setPinned?: (id: string, pinned: boolean) => void
  extra?: object
}

/** A replacement header may borrow navigation from the best existing entry and
 * follow owner reloads. This models the compatibility pattern, not a Bot UI. */
function installBorrowingHeader(slots: SlotCore): () => void {
  let borrowed: StoredEntry | undefined
  let release: (() => void) | undefined
  const update = () => {
    const others = slots.entries(HEADER).filter((entry) => entry.component !== Replacement)
    const next = others.find((entry) => entry.store !== undefined && entry.inject !== undefined)
    if (release !== undefined && next === borrowed) return
    borrowed = next
    release?.()
    release = slots.register(
      {
        name: HEADER,
        priority: Math.min(-100, ...others.map((entry) => (entry.options.priority ?? 0) - 1)),
        ...(next?.store === undefined ? {} : { store: next.store }),
        inject: (...args: never[]) => {
          const face = (next?.inject?.(...args) ?? {}) as HeaderFace
          return { ...face, hooks: { ...face.hooks, replacement: true } }
        },
      } as never,
      Replacement,
    )
  }
  const unsubscribe = slots.subscribe(HEADER, update)
  update()
  return () => {
    unsubscribe()
    release?.()
  }
}

function fixture() {
  const queue: VoidFunction[] = []
  const microtasks = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => queue.push(task))
  const slots = new SlotCore()
  const releases: VoidFunction[] = []
  const hold = (release: VoidFunction) => {
    releases.push(release)
    return release
  }
  hold(
    slots.register(
      {
        name: 'root',
        children: {
          'conversation.view': { kind: 'list', scope: 'session' },
          [HEADER]: { kind: 'single', scope: 'session' },
        },
      } as never,
      Native,
    ),
  )
  let locale = 'en'
  hold(
    slots.register(
      {
        name: 'conversation.view',
        id: 'chat',
        label: () => (locale === 'en' ? 'Chat' : '对话'),
        children: { 'conversation.chat.flow': { kind: 'single', scope: 'session' } },
      } as never,
      Native,
    ),
  )
  hold(
    slots.register(
      {
        name: 'conversation.chat.flow',
        children: {
          'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        },
      } as never,
      Native,
    ),
  )
  const listeners = new Set<VoidFunction>()
  let tabs: readonly ViewTab[] = []
  const refresh = () => {
    // Match the pinned shell's raw registry producer, including shadowed tabs.
    tabs = slots
      .entries('conversation.view')
      .map((entry) => ({ id: entry.options.id!, label: resolveSlotLabel(entry.options.label) ?? entry.options.id! }))
    listeners.forEach((listener) => listener())
  }
  const views: ObservableSnapshot<readonly ViewTab[]> = {
    getSnapshot: () => tabs,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  hold(slots.subscribe('conversation.view', refresh))
  refresh()
  const callbacks = { open: vi.fn(), selectView: vi.fn(), setPinned: vi.fn() }
  const pins = {},
    actions = {},
    extra = {}
  const store = () => ({})
  const inject = vi.fn((..._args: never[]) => ({
    ...callbacks,
    extra,
    hooks: { conversationViews: views, entryPins: pins, entryActions: actions },
  }))
  const native = () =>
    hold(
      slots.register(
        { name: HEADER, children: { [ACTIONS]: { kind: 'list', scope: 'root' } }, store, inject } as never,
        Native,
      ),
    )
  const acp = () => {
    const owned: VoidFunction[] = []
    installAcpAssistantStream(
      {
        slots: {
          entries: slots.entries.bind(slots),
          entriesOfSlot: slots.entriesOfSlot.bind(slots),
          subscribe: slots.subscribe.bind(slots),
          register: slots.register.bind(slots),
          registerFactory: slots.registerFactory,
          inject: (_name: string, setup: () => VoidFunction) => {
            owned.push(setup())
          },
        },
      } as never,
      {} as never,
    )
    return hold(() => {
      owned
        .splice(0)
        .reverse()
        .forEach((release) => release())
    })
  }
  const replacement = () => hold(installBorrowingHeader(slots))
  const settle = () => {
    let count = 0
    while (queue.length > 0 && count++ < 20) queue.shift()!()
    // A priority chase must fail promptly instead of starving the test runner.
    expect(queue).toHaveLength(0)
    return count
  }
  const winner = () => slots.entriesOfSlot(HEADER)[0]!
  const face = () => winner().inject!() as HeaderFace
  return {
    slots,
    native,
    acp,
    replacement,
    settle,
    winner,
    face,
    views,
    inject,
    store,
    callbacks,
    pins,
    actions,
    extra,
    listeners,
    translate: () => {
      locale = 'zh'
      refresh()
    },
    close: () => {
      releases.reverse().forEach((release) => release())
      microtasks.mockRestore()
    },
  }
}

it.each(['acp-first', 'replacement-first'] as const)(
  'settles borrowed header navigation and hot reloads in %s order',
  (order) => {
    const f = fixture()
    try {
      let native = f.native()
      let acp: VoidFunction, replacement: VoidFunction
      if (order === 'acp-first') {
        acp = f.acp()
        replacement = f.replacement()
      } else {
        replacement = f.replacement()
        acp = f.acp()
      }
      f.settle()
      const assertCombined = () => {
        expect(f.winner().component).toBe(Replacement)
        expect(f.winner().options.priority).toBe(-100)
        expect(f.winner().store).toBe(f.store)
        expect(f.face().hooks.conversationViews!.getSnapshot()).toEqual([{ id: 'chat', label: 'Chat' }])
        expect(f.face().hooks.replacement).toBe(true)
        expect(f.slots.entries(HEADER)).toHaveLength(3)
      }
      assertCombined()
      replacement()
      f.settle()
      expect(f.winner().registrant).toBe('acp-chat-normalization')
      expect(f.winner().options.priority).toBe(-1)
      replacement = f.replacement()
      f.settle()
      assertCombined()
      acp()
      f.settle()
      expect(f.slots.entries(HEADER)).toHaveLength(2)
      expect(f.face().hooks.conversationViews).toBe(f.views)
      acp = f.acp()
      f.settle()
      assertCombined()
      native()
      f.settle()
      expect(f.slots.entries(HEADER)).toHaveLength(1)
      expect(f.face().hooks.conversationViews).toBeUndefined()
      native = f.native()
      f.settle()
      assertCombined()
      // An owner's same-tick replacement must not leave a wrapper of its old entry.
      native()
      native = f.native()
      f.settle()
      assertCombined()
      acp()
      replacement()
      native()
      f.settle()
      expect(f.slots.entries(HEADER)).toHaveLength(0)
    } finally {
      f.close()
    }
  },
)

it('waits for the declared owner without adopting an unrelated replacement and follows a late owner', () => {
  const f = fixture()
  try {
    f.replacement()
    f.acp()
    f.settle()
    expect(f.slots.entries(HEADER)).toHaveLength(1)
    expect(f.winner().component).toBe(Replacement)
    f.native()
    f.settle()
    expect(f.slots.entries(HEADER)).toHaveLength(3)
    expect(f.winner().component).toBe(Replacement)
    expect(f.face().hooks.conversationViews!.getSnapshot()).toEqual([{ id: 'chat', label: 'Chat' }])
  } finally {
    f.close()
  }
})

it('preserves the complete native injection and forwards tab, locale and child-slot changes with stable snapshots', () => {
  const f = fixture()
  try {
    f.native()
    f.acp()
    f.replacement()
    f.settle()
    const face = f.face()
    const argumentsFromHost = ['session-id', { update: vi.fn() }]
    ;(f.winner().inject as (...args: unknown[]) => unknown)(...argumentsFromHost)
    expect(f.inject).toHaveBeenLastCalledWith(...argumentsFromHost)
    expect(face.extra).toBe(f.extra)
    expect(face.hooks.entryPins).toBe(f.pins)
    expect(face.hooks.entryActions).toBe(f.actions)
    for (const key of ['open', 'selectView', 'setPinned'] as const) expect(face[key]).toBe(f.callbacks[key])
    const source = face.hooks.conversationViews!
    expect(f.face().hooks.conversationViews).toBe(source)
    expect(source.getSnapshot()).toBe(source.getSnapshot())
    const onChange = vi.fn()
    const unsubscribe = source.subscribe(onChange)
    expect(f.listeners.size).toBe(1)
    const audit = f.slots.register({ name: 'conversation.view', id: 'audit', label: 'Audit' }, Native)
    f.settle()
    expect(source.getSnapshot()).toEqual([
      { id: 'chat', label: 'Chat' },
      { id: 'audit', label: 'Audit' },
    ])
    const beforeLocale = source.getSnapshot()
    f.translate()
    expect(source.getSnapshot()).not.toBe(beforeLocale)
    expect(source.getSnapshot()).toEqual([
      { id: 'chat', label: '对话' },
      { id: 'audit', label: 'Audit' },
    ])
    expect(source.getSnapshot()).toBe(source.getSnapshot())
    audit()
    f.settle()
    expect(source.getSnapshot()).toEqual([{ id: 'chat', label: '对话' }])
    expect(onChange).toHaveBeenCalledTimes(3)
    unsubscribe()
    expect(f.listeners.size).toBe(0)
    const wrapper = f.slots.entries(HEADER).find((entry) => entry.registrant === 'acp-chat-normalization')!
    const alias = Object.keys(wrapper.children!)[0]!
    expect(alias).not.toBe(ACTIONS)
    const action = () => null
    const releaseAction = f.slots.register({ name: ACTIONS, id: 'third-party-action' }, action)
    f.settle()
    expect(f.slots.entriesOfSlot(alias)).toHaveLength(1)
    releaseAction()
    f.settle()
    expect(f.slots.entriesOfSlot(alias)).toHaveLength(0)
  } finally {
    f.close()
  }
})
