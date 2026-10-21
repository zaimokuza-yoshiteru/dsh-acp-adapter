import { expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { followNativeTeamUi } from '../../../src/client/ui/native-team-ui-lifecycle.ts'

const Native = () => null
function declareConversation(slots: SlotCore): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    } as never,
    Native as never,
  )
}
function nativeTeam(slots: SlotCore): () => void {
  return slots.register({ name: 'conversation.session.header.actions', id: 'agent-team' }, Native)
}
function fixture(slots: SlotCore) {
  const released = vi.fn()
  const mount = vi.fn(() => {
    const management = slots.register(
      { name: 'conversation.session.header.utilities', id: 'acp-team-management' },
      Native,
    )
    return () => {
      released()
      management()
    }
  })
  const active = () =>
    [...slots.entries('conversation.session.header.utilities'), ...slots.entries('conversation.input.dock')].map(
      (entry) => entry.options.id,
    )
  return { mount, released, active }
}

it('follows default off, late enable, hot disable and remount without a user setting', async () => {
  const slots = new SlotCore()
  const releaseRoot = declareConversation(slots)
  const { mount, released, active } = fixture(slots)
  const stop = followNativeTeamUi(slots, mount)
  const unrelated = slots.register({ name: 'conversation.session.header.actions', id: 'subagent-catalog' }, Native)
  await Promise.resolve()
  expect(mount).not.toHaveBeenCalled()
  expect(active()).toEqual([])

  let releaseTeam = nativeTeam(slots)
  await Promise.resolve()
  expect(active()).toEqual(['acp-team-management'])
  unrelated()
  await Promise.resolve()
  expect(mount).toHaveBeenCalledTimes(1)
  releaseTeam()
  await Promise.resolve()
  expect(active()).toEqual([])
  expect(released).toHaveBeenCalledTimes(1)

  releaseTeam = nativeTeam(slots)
  await Promise.resolve()
  expect(active()).toEqual(['acp-team-management'])
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
  const stop = followNativeTeamUi(slots, mount)
  expect(mount).toHaveBeenCalledTimes(1)
  releaseTeam()
  const replacement = nativeTeam(slots)
  await Promise.resolve()
  expect(released).toHaveBeenCalledTimes(1)
  expect(mount).toHaveBeenCalledTimes(2)
  expect(active()).toEqual(['acp-team-management'])
  stop()
  replacement()
  releaseRoot()
})

it('releases subscriptions and controls when the native conversation declaration collapses', async () => {
  const slots = new SlotCore()
  let releaseRoot = declareConversation(slots)
  nativeTeam(slots)
  const { mount, released, active } = fixture(slots)
  const stop = followNativeTeamUi(slots, mount)
  releaseRoot()
  await Promise.resolve()
  expect(active()).toEqual([])
  expect(released).toHaveBeenCalledTimes(1)
  releaseRoot = declareConversation(slots)
  nativeTeam(slots)
  await Promise.resolve()
  expect(mount).toHaveBeenCalledTimes(2)
  expect(active()).toEqual(['acp-team-management'])
  stop()
  releaseRoot()
})
