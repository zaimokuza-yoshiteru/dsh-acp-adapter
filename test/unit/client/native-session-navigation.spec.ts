import { expect, it, vi } from 'vitest'
import { openSubagentAside } from '../../../src/client/coordinator/native-session-navigation.ts'

it.each(['one-shot', 'continuable'] as const)('opens the native %s resource without replacing the main conversation', mode => {
  const openResource = vi.fn()
  openSubagentAside({ openResource } as never, { parentSessionId: 'parent /?#' as never, childSessionId: 'child /?#' as never, mode })
  const [wire, placement] = openResource.mock.calls[0]!
  const url = new URL(wire)
  expect(url.protocol).toBe('dsh-resource:')
  expect(url.hostname).toBe('subagentchat')
  expect(decodeURIComponent(url.pathname.slice('/session/'.length))).toBe('child /?#')
  expect(url.searchParams.get('parent')).toBe('parent /?#')
  expect(url.searchParams.get('mode')).toBe(mode)
  expect(placement).toEqual({ kind: 'subagentchat', preferNewPane: true })
})
