import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AcpActivityView } from '../../../src/client/data/acp-remote.ts'
import { activityBoundaries, finalAnswerStart, installAcpAssistantStream } from '../../../src/client/ui/AcpAssistantStream.ts'

describe('native assistant renderer composition', () => {
  it('keeps legacy and not-yet-delivered activity out of the inline boundaries', () => {
    const rows = [{ activityId: 'old' }, { activityId: 'tail', contentIndex: 2 },
      { activityId: 'future', contentIndex: 3 }, { activityId: 'head', contentIndex: 0 }] as AcpActivityView[]
    expect([...activityBoundaries(rows, 2)]).toEqual([[2, [rows[1]]], [0, [rows[3]]]])
    expect([...activityBoundaries(rows, 2, true)]).toEqual([[2, [rows[1], rows[2]]], [0, [rows[3]]]])
  })

  it('keeps all trailing answer paragraphs and images visible when folding the process', () => {
    const blocks = [{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'progress' },
      { kind: 'text', text: 'answer paragraph one' }, { kind: 'text', text: 'answer paragraph two' }] as never
    expect(finalAnswerStart(blocks, new Map([[2, []], [4, []]]))).toBe(2)
    expect(finalAnswerStart(blocks, new Map())).toBe(1)
  })

  it('waits for the native renderer and declines renderers with private dependencies', () => {
    let entries: Array<Record<string, unknown>> = []
    let notify: () => void = () => {}
    let cleanup: (() => void) | undefined
    const unsubscribe = vi.fn()
    const register = vi.fn((options, component) => {
      entries = [{ options, component }]
      notify()
    })
    const ctx = { settingsScope: { bind: () => ({ subscribe: () => () => {}, getSnapshot: () => ({}) }) }, slots: {
      inject: (_name: string, factory: () => () => void) => { cleanup = factory() },
      subscribe: (_name: string, listener: () => void) => { notify = listener; return unsubscribe },
      entriesOfSlot: () => entries,
      register,
    } } as unknown as Context
    const available = installAcpAssistantStream(ctx, {} as never)
    expect(available()).toBe(false)
    const native = { options: { key: 'assistant-step' }, locale: 'chat', component: () => null }
    for (const extra of [{ inject: () => ({}) }, { children: {} }, { locale: 'another-plugin' }, { options: { key: 'assistant-step', priority: -1 } }]) {
      entries = [{ ...native, ...extra }]
      notify()
      expect(register).not.toHaveBeenCalled()
      expect(available()).toBe(false)
    }
    entries = [native]
    notify()
    expect(register).toHaveBeenCalledTimes(1)
    expect(available()).toBe(true)
    // A later winner must make the additive activity renderer visible again.
    entries = [native]
    expect(available()).toBe(false)
    cleanup?.()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
