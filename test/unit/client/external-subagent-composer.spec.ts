import { describe, expect, it, vi } from 'vitest'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  AcpExternalSubagentComposer,
  followExternalSubagentRecords,
  selectExternalSubagentRecord,
} from '../../../src/client/ui/AcpExternalSubagentComposer.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const child = 'external-child' as SessionId
const nativeChild = 'native-child' as SessionId
function owner(sessionId: SessionId, mode: 'one-shot' | 'continuable' | 'unknown'): ComposerChainProps {
  return { sessionId, session: { subagent: { address: { mode } } } } as ComposerChainProps
}

describe('external Agent record composer', () => {
  it('claims only a Host-proven external record with the native one-shot address', () => {
    const owned = new Set([child])
    expect(selectExternalSubagentRecord(owner(child, 'one-shot'), owned)).toBe(true)
    expect(selectExternalSubagentRecord(owner(nativeChild, 'one-shot'), owned)).toBeNull()
    expect(selectExternalSubagentRecord(owner(child, 'continuable'), owned)).toBeNull()
    expect(selectExternalSubagentRecord(owner(child, 'unknown'), owned)).toBeNull()
    expect(selectExternalSubagentRecord({ sessionId: child } as ComposerChainProps, owned)).toBeNull()
    expect(selectExternalSubagentRecord({} as ComposerChainProps, owned)).toBeNull()
    expect(selectExternalSubagentRecord(owner(child, 'one-shot'), new Set())).toBeNull()
  })

  it('follows Host projection ownership, removes stale claims, and releases late notifications on disposal', () => {
    let value = {} as ReturnType<ISessions['list']['getSnapshot']>['projectionsBySession']
    let notify = () => {}
    const unsubscribe = vi.fn()
    const source = {
      getSnapshot: () => ({ projectionsBySession: value }) as ReturnType<ISessions['list']['getSnapshot']>,
      subscribe: (listener: () => void) => {
        notify = listener
        return unsubscribe
      },
    }
    const released = vi.fn()
    const mount = vi.fn((_records: ReadonlySet<SessionId>) => released)
    const stop = followExternalSubagentRecords(source, mount)
    expect(mount).not.toHaveBeenCalled()
    value = {
      [child]: { state: 'ready', error: null, values: { acpExecution: { externalSubagent: true } } },
      [nativeChild]: { state: 'ready', error: null, values: { acpExecution: { externalSubagent: false } } },
    } as typeof value
    notify()
    expect([...mount.mock.calls[0]![0]]).toEqual([child])
    notify()
    expect(mount).toHaveBeenCalledTimes(1)
    value = {}
    notify()
    expect(released).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledTimes(1)
    value = {
      [child]: { state: 'ready', error: null, values: { acpExecution: { externalSubagent: true } } },
    } as typeof value
    notify()
    expect(mount).toHaveBeenCalledTimes(2)
    stop()
    stop()
    value = {}
    notify()
    expect(released).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledTimes(2)
  })

  it('releases the Host subscription if initial registration fails', () => {
    const unsubscribe = vi.fn()
    const source = {
      getSnapshot: () =>
        ({ projectionsBySession: { [child]: { values: { acpExecution: { externalSubagent: true } } } } }) as ReturnType<
          ISessions['list']['getSnapshot']
        >,
      subscribe: () => unsubscribe,
    }
    expect(() =>
      followExternalSubagentRecords(source, () => {
        throw new Error('slot unavailable')
      }),
    ).toThrow('slot unavailable')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each([
    ['en', en],
    ['zh', zh],
  ] as const)('renders the %s completeness boundary without adding decisions', (_locale, dictionary) => {
    const output = AcpExternalSubagentComposer({
      t: (key) => (key in dictionary ? dictionary[key as keyof typeof dictionary] : key),
    } as Parameters<typeof AcpExternalSubagentComposer>[0]) as unknown as {
      type: string
      props: { role: string; children: { type: string; props: { children: string } }[] }
    }
    expect(output.type).toBe('div')
    expect(output.props.role).toBe('status')
    expect(output.props.children.map((node) => node.type)).toEqual(['strong', 'span'])
    expect(output.props.children.map((node) => node.props.children)).toEqual([
      dictionary['subagent.readOnlyTitle'],
      dictionary['subagent.readOnlyBody'],
    ])
    expect(dictionary['subagent.readOnlyBody']).toMatch(/不包含完整|not its full/)
  })
})
