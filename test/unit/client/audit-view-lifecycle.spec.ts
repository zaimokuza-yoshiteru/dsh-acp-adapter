import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { AcpAuditViewVisibility } from '../../../src/client/ui/audit-view-visibility.ts'

describe('audit visibility at the native session retirement boundary', () => {
  it('exposes the real Cordis cleanup window when a retiring gate withdraws the global view', async () => {
    const ctx = new Context()
    const scope = createScope(ctx, SessionId('retiring-session'))
    await scope.fiber
    const slots = new SlotCore()
    const live = new Set(['retiring-session'])
    const tracked = new Set(['retiring-session'])
    // Native ui-conversation tracks its Provider binding with this exact scope
    // effect contract. Its refreshViews resolves tracked ids through sessions.
    scope.ctx.effect(() => () => {
      tracked.delete('retiring-session')
    })
    slots.register(
      { name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never,
      () => null,
    )
    const disposeView = slots.register({ name: 'conversation.view', id: 'dsh-acp-audit' } as never, () => null)
    await Promise.resolve()
    const stale: string[] = []
    slots.subscribe('conversation.view', () => {
      for (const id of tracked) if (!live.has(id)) stale.push(id)
    })
    // SessionController retires its live lookup before starting fiber disposal.
    // The old Gate cleanup unregisters a view in this same retirement window.
    live.delete('retiring-session')
    disposeView()
    const disposed = scope.fiber.dispose()
    await disposed
    expect(tracked.size).toBe(0)
    expect(stale).toEqual(['retiring-session'])
    await ctx.fiber.dispose()
  })

  it('removes the retiring gate from presentation without re-entering the global roster', async () => {
    const ctx = new Context()
    const scope = createScope(ctx, SessionId('retiring-session'))
    await scope.fiber
    const slots = new SlotCore()
    const live = new Set(['retiring-session']),
      tracked = new Set(['retiring-session'])
    scope.ctx.effect(() => () => {
      tracked.delete('retiring-session')
    })
    slots.register(
      { name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never,
      () => null,
    )
    const disposeView = slots.register({ name: 'conversation.view', id: 'dsh-acp-audit' } as never, () => null)
    await Promise.resolve()
    const stale: string[] = []
    let refreshes = 0
    slots.subscribe('conversation.view', () => {
      refreshes++
      for (const id of tracked) if (!live.has(id)) stale.push(id)
    })
    const visibility = new AcpAuditViewVisibility(),
      gate = {}
    visibility.setVisible('retiring-session', true, gate)
    let localUpdates = 0
    const unsubscribe = visibility.subscribe('retiring-session', () => {
      localUpdates++
    })
    live.delete('retiring-session')
    visibility.setVisible('retiring-session', false, gate)
    await scope.fiber.dispose()
    expect(localUpdates).toBe(1)
    expect(refreshes).toBe(0)
    expect(stale).toEqual([])
    expect(slots.entries('conversation.view')).toHaveLength(1)
    disposeView()
    await Promise.resolve()
    expect(refreshes).toBe(1)
    expect(stale).toEqual([])
    unsubscribe()
    await ctx.fiber.dispose()
  })
})
