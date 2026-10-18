import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { mountNativeEntry, observeNativeSlotAnchors } from '../../src/client/ui/native-tool-renderer.ts'

const scaffold = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(process.cwd(), '../reference/deepseek-harness')
const requireScaffold = createRequire(resolve(scaffold, 'package.json'))
const { JSDOM } = (await import(pathToFileURL(requireScaffold.resolve('jsdom')).href)) as {
  JSDOM: new (html: string) => {
    window: { document: Document; MutationObserver: typeof MutationObserver; close(): void }
  }
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllGlobals()
})

function documentFixture() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  cleanups.push(() => dom.window.close())
  return dom.window.document
}

function addSlot(document: Document, name: string, parent: Element = document.body): Element {
  const anchor = document.createElement('div')
  anchor.setAttribute('data-slot', name)
  parent.append(anchor)
  return anchor
}

describe('native semantic anchors in private ACP slot compositions', () => {
  it('corrects initial empty outlets synchronously without adding a wrapper', () => {
    const document = documentFixture()
    const seat = document.createElement('div')
    document.body.append(seat)
    const anchor = addSlot(document, 'acp.native.owner.node', seat)
    const unrelated = addSlot(document, 'other.node')
    const owner = observeNativeSlotAnchors(document, new Map([['acp.native.owner.node', 'conversation.chat.node']]))
    cleanups.push(owner.dispose)
    owner.flush()
    expect(anchor.getAttribute('data-slot')).toBe('conversation.chat.node')
    expect(seat.matches(':has(> [data-slot="conversation.chat.node"]:empty)')).toBe(true)
    expect(seat.children).toHaveLength(1)
    expect(unrelated.getAttribute('data-slot')).toBe('other.node')
  })

  it('corrects late subtrees, empty outlets and later data-slot assignments', async () => {
    const document = documentFixture()
    const aliases = new Map([['acp.native.owner.flow', 'conversation.chat.flow']])
    const owner = observeNativeSlotAnchors(document, aliases)
    cleanups.push(owner.dispose)
    owner.flush()
    const subtree = document.createElement('section')
    const flow = addSlot(document, 'acp.native.owner.flow', subtree)
    aliases.set('acp.native.owner.node', 'conversation.chat.node')
    const node = addSlot(document, 'acp.native.owner.node', flow)
    document.body.append(subtree)
    await Promise.resolve()
    expect(flow.getAttribute('data-slot')).toBe('conversation.chat.flow')
    expect(node.getAttribute('data-slot')).toBe('conversation.chat.node')
    expect(node.children).toHaveLength(0)
    node.setAttribute('data-slot', 'acp.native.owner.node')
    await Promise.resolve()
    expect(node.getAttribute('data-slot')).toBe('conversation.chat.node')
  })

  it('isolates owners, handles remounts and stops correcting after disposal', async () => {
    const document = documentFixture()
    const first = observeNativeSlotAnchors(document, new Map([['acp.native.first.node', 'conversation.chat.node']]))
    const second = observeNativeSlotAnchors(document, new Map([['acp.native.second.node', 'conversation.chat.node']]))
    cleanups.push(first.dispose, second.dispose)
    first.flush()
    second.flush()
    const initial = addSlot(document, 'acp.native.first.node')
    await Promise.resolve()
    expect(initial.getAttribute('data-slot')).toBe('conversation.chat.node')
    initial.remove()
    const remounted = addSlot(document, 'acp.native.first.node')
    await Promise.resolve()
    expect(remounted.getAttribute('data-slot')).toBe('conversation.chat.node')
    first.dispose()
    const retired = addSlot(document, 'acp.native.first.node')
    const active = addSlot(document, 'acp.native.second.node')
    await Promise.resolve()
    first.flush()
    expect(retired.getAttribute('data-slot')).toBe('acp.native.first.node')
    expect(active.getAttribute('data-slot')).toBe('conversation.chat.node')
  })

  it('retains private registry identities and releases the observer with the native mount', async () => {
    const document = documentFixture()
    const slots = new SlotCore()
    const releaseRoot = slots.register(
      { name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never,
      (() => null) as never,
    )
    cleanups.push(releaseRoot)
    slots.register(
      {
        name: 'conversation.view',
        id: 'chat',
        children: { 'conversation.chat.flow': { kind: 'single', scope: 'session' } },
      } as never,
      (() => null) as never,
    )
    slots.register(
      {
        name: 'conversation.chat.flow',
        children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
      } as never,
      (() => null) as never,
    )
    slots.register({ name: 'conversation.chat.node', key: 'acp-activity' } as never, (() => null) as never)
    const source = slots.entries('conversation.view')[0]!
    const release = mountNativeEntry({ slots } as never, source, 'acp.test-semantic', { factory: true })
    cleanups.push(release)
    const flowAlias = Object.keys(slots.factory('acp.test-semantic')!.children!)[0]!
    const flowEntry = slots.entriesOfSlot(flowAlias)[0]!
    const nodeAlias = Object.keys(flowEntry.children!)[0]!
    const flow = addSlot(document, flowAlias)
    const node = addSlot(document, nodeAlias, flow)
    await Promise.resolve()
    expect(flow.getAttribute('data-slot')).toBe('conversation.chat.flow')
    expect(node.getAttribute('data-slot')).toBe('conversation.chat.node')
    expect(slots.entriesOfSlot(flowAlias)).toHaveLength(1)
    expect(slots.entriesOfSlot(nodeAlias)).toHaveLength(1)
    expect(slots.entriesOfSlot('conversation.chat.node')).toHaveLength(1)
    release()
    const retired = addSlot(document, nodeAlias)
    await Promise.resolve()
    expect(retired.getAttribute('data-slot')).toBe(nodeAlias)
    expect(slots.factory('acp.test-semantic')).toBeUndefined()
    expect(slots.entriesOfSlot(flowAlias)).toEqual([])
  })

  it('retires aliases of a removed child contribution while its outer mount stays active', async () => {
    const document = documentFixture()
    const slots = new SlotCore()
    const releaseRoot = slots.register(
      { name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never,
      (() => null) as never,
    )
    cleanups.push(releaseRoot)
    slots.register(
      {
        name: 'conversation.view',
        id: 'chat',
        children: { 'conversation.chat.flow': { kind: 'single', scope: 'session' } },
      } as never,
      (() => null) as never,
    )
    const registerFlow = () =>
      slots.register(
        {
          name: 'conversation.chat.flow',
          children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
        } as never,
        (() => null) as never,
      )
    let releaseFlow = registerFlow()
    const release = mountNativeEntry({ slots } as never, slots.entries('conversation.view')[0]!, 'acp.test-churn', {
      factory: true,
    })
    cleanups.push(release)
    const flowAlias = Object.keys(slots.factory('acp.test-churn')!.children!)[0]!
    const retired: Element[] = []
    for (let cycle = 0; cycle < 3; cycle++) {
      const nodeAlias = Object.keys(slots.entriesOfSlot(flowAlias)[0]!.children!)[0]!
      const current = addSlot(document, nodeAlias)
      // Child removal flushes already inserted anchors before retiring their keys.
      releaseFlow()
      await Promise.resolve()
      expect(current.getAttribute('data-slot')).toBe('conversation.chat.node')
      retired.push(addSlot(document, nodeAlias))
      releaseFlow = registerFlow()
      await Promise.resolve()
      const nextAlias = Object.keys(slots.entriesOfSlot(flowAlias)[0]!.children!)[0]!
      const next = addSlot(document, nextAlias)
      const outer = addSlot(document, flowAlias)
      await Promise.resolve()
      expect(next.getAttribute('data-slot')).toBe('conversation.chat.node')
      expect(outer.getAttribute('data-slot')).toBe('conversation.chat.flow')
      expect(retired.every((anchor) => anchor.getAttribute('data-slot') !== 'conversation.chat.node')).toBe(true)
    }
    releaseFlow()
    await Promise.resolve()
  })
})
