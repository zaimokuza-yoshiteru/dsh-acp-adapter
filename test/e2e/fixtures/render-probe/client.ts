import { createElement as h } from 'react'
import { mountNativeEntry } from '../../../../src/client/ui/native-tool-renderer.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export interface QuestionProbe {
  failNext(): void
  stats(): { attempts: number; forwarded: number }
  openSession(id: string): void
}

declare global {
  var __DSH_ACP_RENDER_PROBE__: ((key: string) => void) | undefined
  var __DSH_ACP_QUESTION_PROBE__: QuestionProbe | undefined
}

export const inject = ['slots'] as const

export function apply(ctx: Context): void {
  // Exercise a failed UI submission without replacing the Host, gateway,
  // PendingQuestion lifecycle, or production component. Only this test bundle
  // can arm the one-shot rejection; successful retries use the real carrier.
  let failNext = false
  let attempts = 0
  let forwarded = 0
  const wrapped = new WeakMap<object, object>()
  globalThis.__DSH_ACP_QUESTION_PROBE__ = {
    failNext: () => {
      failNext = true
    },
    stats: () => ({ attempts, forwarded }),
    openSession: (id) => {
      // Public navigation exercises actual Session-scoped store remounts.
      const navigation = ctx.get('uiWorkspace') as { openSession(id: string): void }
      navigation.openSession(id)
    },
  }
  ctx.slots.inject('conversation.composer', () => {
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = (): void => {
      const next = ctx.slots
        .entries('conversation.composer')
        .find((entry) => entry.locale === 'acpActivity' && entry.registrant !== 'dsh-acp-question-ui-probe')
      if (next === current) return
      release?.()
      release = undefined
      current = next
      if (next !== undefined)
        release = mountNativeEntry(ctx, next, 'conversation.composer', {
          registration: { priority: (next.options.priority ?? 0) - 1, registrant: 'dsh-acp-question-ui-probe' },
          wrap: (Native, props) => {
            const pending = props.matched as object
            let proxy = wrapped.get(pending)
            if (proxy === undefined) {
              proxy = new Proxy(pending, {
                get(target, key) {
                  const value: unknown = Reflect.get(target, key, target)
                  if (key === 'answer' && typeof value === 'function')
                    return async (answer: unknown) => {
                      attempts += 1
                      if (failNext) {
                        failNext = false
                        throw new Error('UI_PROBE_INTERNAL_FAILURE must not be exposed to the user')
                      }
                      forwarded += 1
                      return await value.call(target, answer)
                    }
                  // Real PendingQuestion methods own private state. Keep their
                  // receiver rather than pretending the Proxy is the carrier.
                  return typeof value === 'function' ? value.bind(target) : value
                },
              })
              wrapped.set(pending, proxy)
            }
            return h(Native, { ...props, matched: proxy })
          },
        })
    }
    const unsubscribe = ctx.slots.subscribe('conversation.composer', sync)
    sync()
    return () => {
      unsubscribe()
      release?.()
      globalThis.__DSH_ACP_QUESTION_PROBE__ = undefined
    }
  })
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
