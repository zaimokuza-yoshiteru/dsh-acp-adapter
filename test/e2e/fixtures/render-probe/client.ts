import { createElement as h } from 'react'
import { mountNativeEntry } from '../../../../src/client/ui/native-tool-renderer.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.acp.companion': { kind: 'single'; scope: 'session' }
  }
}

export interface ComposerProbe {
  showCompanion(cwd: string, preset: string): Promise<void>
  closeCompanion(): void
  shadowPermission(enable: boolean): void
}

export interface QuestionProbe {
  failNext(): void
  stats(): { attempts: number; forwarded: number }
  openSession(id: string): void
}

declare global {
  var __DSH_ACP_RENDER_PROBE__: ((key: string) => void) | undefined
  var __DSH_ACP_QUESTION_PROBE__: QuestionProbe | undefined
  var __DSH_ACP_COMPOSER_PROBE__: ComposerProbe | undefined
}

export const inject = ['slots'] as const

export function apply(ctx: Context): void {
  let closeCompanion: (() => void) | undefined
  let releasePermission: (() => void) | undefined
  globalThis.__DSH_ACP_COMPOSER_PROBE__ = {
    async showCompanion(cwd, preset) {
      closeCompanion?.()
      const sessions = ctx.get('sessions') as unknown as ISessions
      const id = await sessions.create({ cwd, agentPreset: preset })
      const reference = sessions.retain(id, { source: 'controllerOperation' })
      await reference.ready
      const parent = ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'test-acp-companion',
          children: { 'test.acp.companion': { kind: 'single', scope: 'session' } },
        },
        ({ SessionProvider, renderSlot }) =>
          h(
            'aside',
            {
              'data-test-companion': preset,
              style: { position: 'fixed', inset: '0 0 auto auto', width: '30vw' },
            },
            h(SessionProvider, { session: reference, children: renderSlot('test.acp.companion', {}) }),
          ),
      )
      const child = ctx.slots.register({ name: 'test.acp.companion' }, ({ renderFactorySlot }) =>
        renderFactorySlot(
          'conversation.content',
          { variant: 'embedded', phase: 'active', hero: false },
          {
            slots: {
              views: (props: ConversationViewsProps) => props.renderSlot('conversation.session', { view: 'chat' }),
            },
          },
        ),
      )
      closeCompanion = () => {
        child()
        parent()
        reference.release()
        closeCompanion = undefined
      }
    },
    closeCompanion() {
      closeCompanion?.()
    },
    shadowPermission(enable) {
      releasePermission?.()
      releasePermission = enable
        ? ctx.slots.register({ name: 'conversation.input.permission', priority: -2, registrant: 'test-acp-peer' }, () =>
            h('button', null, 'External permission control'),
          )
        : undefined
    },
  }
  ctx.effect(
    () => () => {
      releasePermission?.()
      closeCompanion?.()
      globalThis.__DSH_ACP_COMPOSER_PROBE__ = undefined
    },
    'test: companion composer and permission owner',
  )
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
