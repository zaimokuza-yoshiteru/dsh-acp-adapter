import { describe, expect, it } from 'vitest'
import { isNativePermissionSeat, selectedAgentProvider } from '../../../src/client/ui/AcpAgentControl.ts'
import { AcpUiFeedback } from '../../../src/client/data/feedback.ts'
import { AcpOutcomeToast } from '../../../src/client/ui/AcpOutcomeToast.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

describe('ACP Agent control route selection', () => {
  it('leaves an unconfirmed or competing permission owner visible, including an equal-priority entry using the native locale', () => {
    const stock = {
      component: function PermissionSelect() {},
      registrant: 'owner',
      locale: 'permission.access',
      options: {},
    }
    const peer = { ...stock, component: function AnotherPermissionSelect() {} }
    expect(isNativePermissionSeat(stock, [stock], 'owner')).toBe(true)
    expect(isNativePermissionSeat(stock, [stock], undefined)).toBe(false)
    expect(isNativePermissionSeat(stock, [stock], 'another-owner')).toBe(false)
    expect(isNativePermissionSeat(peer, [peer], 'owner')).toBe(false)
    expect(isNativePermissionSeat(stock, [stock, peer], 'owner')).toBe(false)
  })

  it('uses the pending next selection as the current route', () => {
    expect(selectedAgentProvider({ lastUsed: { provider: 'acp-devin' }, next: { provider: 'native' } })).toBe('native')
    expect(selectedAgentProvider({ lastUsed: { provider: 'native' }, next: { provider: 'acp-devin' } })).toBe(
      'acp-devin',
    )
  })

  it('falls back from an empty session projection to the host default route', () => {
    expect(selectedAgentProvider({ lastUsed: { provider: 'acp-devin' } })).toBe('acp-devin')
    expect(selectedAgentProvider({ lastUsed: { provider: 'acp-devin' }, next: undefined })).toBe('acp-devin')
    expect(selectedAgentProvider({ lastUsed: { provider: 'acp-devin' }, next: { provider: undefined } })).toBe(
      undefined,
    )
    expect(selectedAgentProvider({ lastUsed: null, next: null }, 'acp-devin')).toBe('acp-devin')
    expect(selectedAgentProvider({ lastUsed: { provider: 'acp-devin' }, next: null }, 'native')).toBe(undefined)
    expect(selectedAgentProvider({ lastUsed: null, next: null }, 'native')).toBe('native')
    expect(selectedAgentProvider({ lastUsed: null, next: { provider: 'native' } }, 'acp-devin')).toBe('native')
    expect(selectedAgentProvider(null, 'acp-devin')).toBe('acp-devin')
  })
})

describe('ACP Agent control operation feedback', () => {
  it('keeps session option failures visible outside the menu and localizes at render', () => {
    const feedback = new AcpUiFeedback()
    const render = (dictionary: typeof en) => {
      const hasKey = (key: string): key is keyof typeof dictionary => Object.hasOwn(dictionary, key)
      return AcpOutcomeToast({
        feedback,
        t: (key, params) => {
          if (!hasKey(key)) throw new Error(`Missing ACP translation: ${key}`)
          let text: string = dictionary[key]
          for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
          return text
        },
      }) as { props: { text: string; tone?: string; onDone(): void } } | null
    }
    expect(render(en)).toBeNull()
    feedback.report('session-option-failed')
    const first = render(en)!
    expect(first.props.text).toBe(en.actionSaveFailed.replace('{reference}', ''))
    expect(first.props.tone).toBeUndefined()
    expect(render(zh)?.props.text).toBe(zh.actionSaveFailed.replace('{reference}', ''))
    // A completed older toast cannot dismiss a newer operation's result.
    feedback.report('session-option-failed')
    first.props.onDone()
    expect(render(en)?.props.text).toBe(en.actionSaveFailed.replace('{reference}', ''))
    render(en)!.props.onDone()
    expect(render(en)).toBeNull()
  })
})
