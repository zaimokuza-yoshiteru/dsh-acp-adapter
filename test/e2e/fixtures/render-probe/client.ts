import { createElement as h } from 'react'
import { mountNativeEntry } from '../../../../src/client/ui/native-tool-renderer.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'

declare global {
  var __DSH_ACP_RENDER_PROBE__: ((key: string) => void) | undefined
}

export const inject = ['slots'] as const

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.chat.node', () => {
    let current: { options: { key?: string; priority?: number }; registrant?: string } | undefined
    let release: (() => void) | undefined
    const sync = (): void => {
      const next = ctx.slots
        .entries('conversation.chat.node')
        .find((entry) => entry.options.key === 'assistant-step' && entry.registrant !== 'dsh-acp-test-render-probe')
      if (next === current) return
      release?.()
      release = undefined
      current = next
      if (next !== undefined)
        release = mountNativeEntry(ctx, next, 'conversation.chat.node', {
          registration: { priority: (next.options.priority ?? 0) - 1, registrant: 'dsh-acp-test-render-probe' },
          wrap: (Native, props) => {
            globalThis.__DSH_ACP_RENDER_PROBE__?.(String((props.node as { key: string }).key))
            return h(Native, props)
          },
        })
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', sync)
    sync()
    return () => {
      unsubscribe()
      release?.()
    }
  })
}
