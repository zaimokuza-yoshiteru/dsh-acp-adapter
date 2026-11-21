import { describe, expect, it } from 'vitest'
import { snapshotIsAcp } from '../../../src/client/ui/AcpAgentControl.ts'
import { AcpUiFeedback } from '../../../src/client/data/feedback.ts'
import { AcpOutcomeToast } from '../../../src/client/ui/AcpOutcomeToast.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

describe('ACP Agent control route selection', () => {
  const owns = (provider: string | undefined): boolean => provider === 'acp-devin'

  it('uses the pending next selection as the current route', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: 'native' } }, owns)).toBe(false)
    expect(snapshotIsAcp({ lastUsed: { provider: 'native' }, next: { provider: 'acp-devin' } }, owns)).toBe(true)
  })

  it('falls back from an empty session projection to the host default route', () => {
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' } }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: undefined }, owns)).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: { provider: undefined } }, owns)).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: null }, owns, 'acp-devin')).toBe(true)
    expect(snapshotIsAcp({ lastUsed: { provider: 'acp-devin' }, next: null }, owns, 'native')).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: null }, owns, 'native')).toBe(false)
    expect(snapshotIsAcp({ lastUsed: null, next: { provider: 'native' } }, owns, 'acp-devin')).toBe(false)
    expect(snapshotIsAcp(null, owns, 'acp-devin')).toBe(true)
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
