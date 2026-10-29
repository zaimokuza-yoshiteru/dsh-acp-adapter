import { describe, expect, it, vi } from 'vitest'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { AcpAuditViewVisibility } from '../../../src/client/ui/audit-view-visibility.ts'
import { nativeHeaderViewRegistration } from '../../../src/client/ui/native-header-views.ts'

function fixture() {
  const visibility = new AcpAuditViewVisibility()
  const raw = [
    { id: 'chat', label: 'Chat' },
    { id: 'chat', label: 'Chat' },
    { id: 'trajectory', label: 'Trajectory' },
    { id: 'dsh-acp-audit', label: 'ACP Diagnostics' },
  ]
  const listeners = new Set<() => void>()
  const views: ObservableSnapshot<readonly ViewTab[]> = {
    getSnapshot: () => raw,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const action = vi.fn()
  const entry = {
    inject: () => ({ hooks: { conversationViews: views, inspectCall: 'untouched' }, openView: action }),
  } as unknown as StoredEntry
  const header = nativeHeaderViewRegistration(entry, visibility)
  const body = nativeHeaderViewRegistration(entry, visibility)
  const face = (registration: typeof header, sessionId: string, actions: object) =>
    (
      registration.inject as (
        id: string,
        actions: object,
      ) => {
        hooks: { conversationViews: typeof views; inspectCall: unknown }
        openView: typeof action
      }
    )(sessionId, actions)
  return { visibility, header, body, face, views, listeners, action }
}

describe('session-owned diagnostic view presentation', () => {
  it('filters the same diagnostic tab from header and body while preserving native navigation and hooks', () => {
    const f = fixture(),
      actions = {},
      gate = {}
    const header = f.face(f.header, 'acp', actions)
    const body = f.face(f.body, 'acp', actions)
    const read = () => [header, body].map((face) => face.hooks.conversationViews.getSnapshot().map((tab) => tab.id))
    expect(read()).toEqual([
      ['chat', 'trajectory'],
      ['chat', 'trajectory'],
    ])
    expect(body.openView).toBe(f.action)
    expect(body.hooks.inspectCall).toBe('untouched')
    f.visibility.setVisible('acp', true, gate)
    expect(read()).toEqual([
      ['chat', 'trajectory', 'dsh-acp-audit'],
      ['chat', 'trajectory', 'dsh-acp-audit'],
    ])
    // A formerly selected diagnostic view becomes unavailable to both native
    // resolveActiveView consumers; neither receives a stale diagnostic entry.
    f.visibility.setVisible('acp', false, gate)
    expect(read()).toEqual([
      ['chat', 'trajectory'],
      ['chat', 'trajectory'],
    ])
    expect(f.views.getSnapshot().map((tab) => tab.id)).toContain('dsh-acp-audit')
  })

  it('keeps per-scope snapshots stable and prevents native or side references taking another session visibility', () => {
    const f = fixture(),
      acpActions = {},
      nativeActions = {},
      gate = {},
      sideGate = {}
    const acp = f.face(f.header, 'acp', acpActions).hooks.conversationViews
    const native = f.face(f.header, 'native', nativeActions).hooks.conversationViews
    expect(f.face(f.header, 'acp', acpActions).hooks.conversationViews).toBe(acp)
    expect(acp.getSnapshot()).toBe(acp.getSnapshot())
    const acpChanged = vi.fn(),
      nativeChanged = vi.fn()
    const stopAcp = acp.subscribe(acpChanged),
      stopNative = native.subscribe(nativeChanged)
    f.visibility.setVisible('acp', true, gate)
    expect(acpChanged).toHaveBeenCalledOnce()
    expect(nativeChanged).not.toHaveBeenCalled()
    f.visibility.setVisible('acp', false, sideGate)
    f.visibility.setVisible('native', false, sideGate)
    expect(f.visibility.visible('acp')).toBe(true)
    expect(native.getSnapshot().map((tab) => tab.id)).toEqual(['chat', 'trajectory'])
    expect(acpChanged).toHaveBeenCalledOnce()
    stopAcp()
    stopNative()
    expect(f.listeners.size).toBe(0)
  })

  it('retires only the reporting gate instance and permits a same-session remount', () => {
    const visibility = new AcpAuditViewVisibility(),
      first = {},
      next = {}
    visibility.setVisible('session', true, first)
    visibility.setVisible('session', true, next)
    visibility.setVisible('session', false, first)
    expect(visibility.visible('session')).toBe(true)
    visibility.setVisible('session', false, next)
    expect(visibility.visible('session')).toBe(false)
  })
})
