import { expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { installNativeToolRenderer } from '../../../src/client/ui/native-tool-renderer.ts'

it('preserves native registration dependencies, follows child plugins and releases all aliases', async () => {
  const slots = new SlotCore()
  const releaseRoot = slots.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } } as never, (() => null) as never)
  const inject = () => ({ hooks: { hostInfo: {} } })
  const Native = () => null
  slots.register({ name: 'conversation.chat.node', key: 'tool-call', locale: 'conversation', inject,
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, Native as never)
  slots.register({ name: 'conversation.chat.node', key: 'turn-process', locale: 'chat' }, (() => null) as never)
  const releaseBash = slots.register({ name: 'tool.call.toolview', key: 'bash', locale: 'conversation' } as never, Native as never)
  const releases: (() => void)[] = []
  installNativeToolRenderer({ slots: {
    register: slots.register.bind(slots), registerFactory: slots.registerFactory,
    entries: slots.entries.bind(slots), entriesOfSlot: slots.entriesOfSlot.bind(slots), subscribe: slots.subscribe.bind(slots),
    inject: (_key: string, setup: () => () => void) => { releases.push(setup()) },
  } } as never)
  const factory = slots.factory('acp.native-tool')!
  expect(factory.inject).toBe(inject)
  expect(factory.locale).toBe('conversation')
  const child = Object.keys(factory.children!)[0]!
  expect(child).not.toBe('tool.call.toolview')
  expect(slots.entriesOfSlot(child).map(entry => entry.options.key)).toEqual(['bash'])
  const releaseExtension = slots.register({ name: 'tool.call.toolview', key: 'third-party', locale: 'conversation' } as never, Native as never)
  await Promise.resolve()
  expect(slots.entriesOfSlot(child).map(entry => entry.options.key)).toEqual(['bash', 'third-party'])
  releaseBash()
  await Promise.resolve()
  expect(slots.entriesOfSlot(child).map(entry => entry.options.key)).toEqual(['third-party'])
  // Installing the ACP controller must not recursively mirror its own wrapper.
  slots.register({ name: 'conversation.chat.node', key: 'turn-process', priority: -1, registrant: 'acp-process-owner' }, (() => null) as never)
  await Promise.resolve()
  expect(slots.factory('acp.native-process')).toBeDefined()
  for (const release of releases) release()
  expect(slots.factory('acp.native-tool')).toBeUndefined()
  expect(slots.factory('acp.native-process')).toBeUndefined()
  expect(slots.entriesOfSlot(child)).toEqual([])
  expect(slots.entriesOfSlot('tool.call.toolview')).toHaveLength(1)
  releaseExtension()
  releaseRoot()
})
