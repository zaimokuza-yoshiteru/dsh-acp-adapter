import { expect, it, vi } from 'vitest'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { followNativeSubagentUi } from '../../../src/client/ui/native-team-ui-lifecycle.ts'

const Native = () => null
function declareConversation(slots: SlotCore): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    } as never,
    Native as never,
  )
}
function nativeTeam(slots: SlotCore): () => void {
  return slots.register(
    {
      name: 'conversation.session.header.actions',
      id: 'subagent-catalog',
      children: {
        'conversation.session.header.actions.subagent.footer': { kind: 'list', scope: 'session' },
      },
    },
    ({ renderSlot }: PropsRenderSlots<'conversation.session.header.actions.subagent.footer'>) =>
      renderSlot('conversation.session.header.actions.subagent.footer', {}),
  )
}
function fixture(slots: SlotCore) {
  const released = vi.fn()
  const mount = vi.fn(() => {
    const management = slots.register(
      { name: 'conversation.session.header.actions.subagent.footer', id: 'acp-settings' },
      Native,
    )
    return () => {
      released()
      management()
    }
  })
  const active = () =>
    slots.entries('conversation.session.header.actions.subagent.footer').map((entry) => entry.options.id)
  return { mount, released, active }
}

it('follows native catalog late mount, hot disable and remount without a second entry', async () => {
  const slots = new SlotCore()
  const releaseRoot = declareConversation(slots)
  const { mount, released, active } = fixture(slots)
  const stop = followNativeSubagentUi(slots, mount)
  const unrelated = slots.register({ name: 'conversation.session.header.actions', id: 'unrelated' }, Native)
  await Promise.resolve()
  expect(mount).not.toHaveBeenCalled()
  expect(active()).toEqual([])

  let releaseTeam = nativeTeam(slots)
  await Promise.resolve()
  expect(active()).toEqual(['acp-settings'])
  unrelated()
  await Promise.resolve()
  expect(mount).toHaveBeenCalledTimes(1)
  releaseTeam()
  await Promise.resolve()
  expect(active()).toEqual([])
  expect(released).toHaveBeenCalledTimes(1)

  releaseTeam = nativeTeam(slots)
  await Promise.resolve()
  expect(active()).toEqual(['acp-settings'])
  expect(mount).toHaveBeenCalledTimes(2)
  stop()
  stop()
  expect(active()).toEqual([])
  expect(released).toHaveBeenCalledTimes(2)
  releaseTeam()
  const afterStop = nativeTeam(slots)
  await Promise.resolve()
  expect(mount).toHaveBeenCalledTimes(2)
  afterStop()
  releaseRoot()
})

it('replaces controls when the native owner is hot replaced within one notification batch', async () => {
  const slots = new SlotCore()
  const releaseRoot = declareConversation(slots)
  const releaseTeam = nativeTeam(slots)
  const { mount, released, active } = fixture(slots)
  const stop = followNativeSubagentUi(slots, mount)
  expect(mount).toHaveBeenCalledTimes(1)
  releaseTeam()
  const replacement = nativeTeam(slots)
  await Promise.resolve()
  expect(released).toHaveBeenCalledTimes(1)
  expect(mount).toHaveBeenCalledTimes(2)
  expect(active()).toEqual(['acp-settings'])
  stop()
  replacement()
  releaseRoot()
})

it('releases subscriptions and controls when the native conversation declaration collapses', async () => {
  const slots = new SlotCore()
  let releaseRoot = declareConversation(slots)
  nativeTeam(slots)
  const { mount, released, active } = fixture(slots)
  const stop = followNativeSubagentUi(slots, mount)
  releaseRoot()
  await Promise.resolve()
  expect(active()).toEqual([])
  expect(released).toHaveBeenCalledTimes(1)
  releaseRoot = declareConversation(slots)
  nativeTeam(slots)
  await Promise.resolve()
  expect(mount).toHaveBeenCalledTimes(2)
  expect(active()).toEqual(['acp-settings'])
  stop()
  releaseRoot()
})
