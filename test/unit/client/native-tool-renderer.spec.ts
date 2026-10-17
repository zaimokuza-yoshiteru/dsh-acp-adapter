import { expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  installNativeToolRenderer,
  mountNativeEntry,
  nativeOwner,
} from '../../../src/client/ui/native-tool-renderer.ts'

it('forwards the native viewport group action with the node disclosure hook', () => {
  const useDisclosure = () => ({ open: true, toggle() {} })
  const useGroupAction = () => ({ current: null })
  const node = { key: 'tool' }
  const loadImage = vi.fn(async () => 'session-authorized-image-url')
  const owner = nativeOwner({
    useDisclosure,
    useGroupAction,
    node,
    loadImage,
    // An older caller must not reintroduce removed cross-domain callbacks.
    openSkill: () => undefined,
    renderMessageImages: () => null,
  } as never)
  expect(owner.useDisclosure).toBe(useDisclosure)
  expect(owner.useGroupAction).toBe(useGroupAction)
  expect(owner.node).toBe(node)
  expect(owner.loadImage).toBe(loadImage)
  expect(owner).not.toHaveProperty('openSkill')
  expect(owner).not.toHaveProperty('renderMessageImages')
})

it('keeps the native assistant image domain and caller loader through slot aliases and replacement', async () => {
  const slots = new SlotCore()
  const releaseRoot = slots.register(
    {
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never,
    (() => null) as never,
  )
  const images = [{ attachment: { attachmentId: 'owned-image' } }]
  type Owner = { images: typeof images; loadImage: (value: unknown) => Promise<string>; align: string }
  type NativeProps = { loadImage: Owner['loadImage']; renderSlot: (name: string, owner: Owner) => null }
  const Native = ({ loadImage, renderSlot }: NativeProps) =>
    renderSlot('conversation.chat.message.images', { images, loadImage, align: 'start' })
  const releaseAssistant = slots.register(
    {
      name: 'conversation.chat.node',
      key: 'assistant-step',
      locale: 'chat',
      children: { 'conversation.chat.message.images': { kind: 'single', scope: 'session' } },
    } as never,
    Native as never,
  )
  const Gallery = () => null
  const releaseGallery = slots.register(
    { name: 'conversation.chat.message.images', priority: 100 } as never,
    Gallery as never,
  )
  const source = slots.entries('conversation.chat.node').find((entry) => entry.options.key === 'assistant-step')!
  const releaseMirror = mountNativeEntry({ slots } as never, source, 'acp.test-native-assistant', { factory: true })
  try {
    const factory = slots.factory('acp.test-native-assistant')!
    const imageSlot = Object.keys(factory.children!)[0]!
    expect(imageSlot).toMatch(/\.conversation\.chat\.message\.images$/)
    expect(slots.entriesOfSlot(imageSlot)[0]?.component).toBeDefined()
    const loadImage = vi.fn(async () => 'session-authorized-image-url')
    const renderSlot = vi.fn((_name: string, _owner: Owner) => null)
    const element = (
      factory.component as unknown as (props: NativeProps) => { type: typeof Native; props: NativeProps }
    )({ loadImage, renderSlot })
    element.type(element.props)
    const [name, owner] = renderSlot.mock.calls[0]!
    expect(name).toBe(imageSlot)
    expect(owner.images).toBe(images)
    expect(owner.loadImage).toBe(loadImage)
    await expect(owner.loadImage(images[0]!.attachment)).resolves.toBe('session-authorized-image-url')
    expect(loadImage).toHaveBeenCalledWith(images[0]!.attachment)
    const childComponent = () =>
      (slots.entriesOfSlot(imageSlot)[0]!.component as (props: object) => { type: unknown })({}).type
    expect(childComponent()).toBe(Gallery)
    const Replacement = () => null
    const releaseReplacement = slots.register(
      { name: 'conversation.chat.message.images', priority: 0 } as never,
      Replacement as never,
    )
    await Promise.resolve()
    expect(childComponent()).toBe(Replacement)
    releaseReplacement()
    await Promise.resolve()
    expect(childComponent()).toBe(Gallery)
  } finally {
    releaseMirror()
    releaseGallery()
    releaseAssistant()
    releaseRoot()
  }
})

it('preserves native registration dependencies, follows child plugins and releases all aliases', async () => {
  const slots = new SlotCore()
  const releaseRoot = slots.register(
    {
      name: 'root',
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    } as never,
    (() => null) as never,
  )
  const inject = () => ({ hooks: { hostInfo: {} } })
  const Native = () => null
  slots.register(
    {
      name: 'conversation.chat.node',
      key: 'tool-call',
      locale: 'conversation',
      inject,
      children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never,
    Native as never,
  )
  slots.register({ name: 'conversation.chat.node', key: 'turn-process', locale: 'chat' }, (() => null) as never)
  const releaseBash = slots.register(
    { name: 'tool.call.toolview', key: 'bash', locale: 'conversation' } as never,
    Native as never,
  )
  const releases: (() => void)[] = []
  installNativeToolRenderer({
    slots: {
      register: slots.register.bind(slots),
      registerFactory: slots.registerFactory,
      entries: slots.entries.bind(slots),
      entriesOfSlot: slots.entriesOfSlot.bind(slots),
      subscribe: slots.subscribe.bind(slots),
      inject: (_key: string, setup: () => () => void) => {
        releases.push(setup())
      },
    },
  } as never)
  const factory = slots.factory('acp.native-tool')!
  expect(factory.inject).toBe(inject)
  expect(factory.locale).toBe('conversation')
  const child = Object.keys(factory.children!)[0]!
  expect(child).not.toBe('tool.call.toolview')
  expect(slots.entriesOfSlot(child).map((entry) => entry.options.key)).toEqual(['bash'])
  const releaseExtension = slots.register(
    { name: 'tool.call.toolview', key: 'third-party', locale: 'conversation' } as never,
    Native as never,
  )
  await Promise.resolve()
  expect(slots.entriesOfSlot(child).map((entry) => entry.options.key)).toEqual(['bash', 'third-party'])
  releaseBash()
  await Promise.resolve()
  expect(slots.entriesOfSlot(child).map((entry) => entry.options.key)).toEqual(['third-party'])
  // Installing the ACP controller must not recursively mirror its own wrapper.
  slots.register(
    { name: 'conversation.chat.node', key: 'tool-call', priority: -1, registrant: 'acp-chat-normalization' },
    (() => null) as never,
  )
  await Promise.resolve()
  expect(slots.factory('acp.native-tool')).toBe(factory)
  for (const release of releases) release()
  expect(slots.factory('acp.native-tool')).toBeUndefined()
  expect(slots.entriesOfSlot(child)).toEqual([])
  expect(slots.entriesOfSlot('tool.call.toolview')).toHaveLength(1)
  releaseExtension()
  releaseRoot()
})
