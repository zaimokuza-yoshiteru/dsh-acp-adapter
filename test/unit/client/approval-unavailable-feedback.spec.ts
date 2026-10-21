import { describe, expect, it } from 'vitest'
import { AcpUiFeedback, followAcpQuestionLimitations } from '../../../src/client/data/feedback.ts'
import { AcpOutcomeToast } from '../../../src/client/ui/AcpOutcomeToast.ts'

const suffix = ' (ACP_DELEGATED_QUESTION_UNAVAILABLE)'
const reason = '宿主暂不支持子会话的此类授权选项；本次未授权。'
function fixture() {
  const listeners = new Set<(sessionId: string, message: string) => void>()
  const titles = new Map<string, string>([['unopened-child', 'Research child']])
  const feedback = new AcpUiFeedback()
  const mount = () =>
    followAcpQuestionLimitations(
      (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      feedback,
      (id) => titles.get(id) ?? null,
    )
  return {
    feedback,
    titles,
    mount,
    listeners,
    emit: (id: string, message: string) => {
      for (const listener of listeners) listener(id, message)
    },
  }
}
const t = (key: string, params?: Record<string, string | number>) =>
  key === 'toastSessionOutcome' ? `${params?.message} [${params?.session}]` : key

describe('unsupported child question feedback', () => {
  it('shows the localized exact-code reason with source title and id without materializing a child', () => {
    const f = fixture()
    f.mount()
    f.emit('unopened-child', reason + suffix)
    expect(f.feedback.getSnapshot()).toMatchObject({
      outcome: 'delegated-question-unavailable',
      message: reason,
      sourceSession: { id: 'unopened-child', title: 'Research child' },
    })
    const toast = AcpOutcomeToast({ feedback: f.feedback, t } as never) as { props: { text: string } }
    expect(toast.props.text).toContain(reason)
    expect(toast.props.text).toContain('Research child')
    expect(toast.props.text).toContain('unopened-child')
    expect(toast.props.text).not.toContain('ACP_DELEGATED_QUESTION_UNAVAILABLE')
  })

  it('uses the source id when summaries have not arrived and refreshes the title for later notices', () => {
    const f = fixture()
    f.mount()
    f.emit('not-catalogued', reason + suffix)
    expect(f.feedback.getSnapshot()?.sourceSession).toEqual({ id: 'not-catalogued', title: null })
    f.titles.set('not-catalogued', 'New child')
    f.emit('not-catalogued', reason + suffix)
    expect(f.feedback.getSnapshot()?.sourceSession).toEqual({ id: 'not-catalogued', title: 'New child' })
  })

  it('ignores unrelated errors, empty reasons and non-terminal or malformed markers', () => {
    const f = fixture()
    f.mount()
    f.feedback.report('saved')
    const before = f.feedback.getSnapshot()
    for (const message of [
      'Failed',
      'ACP_DELEGATED_QUESTION_UNAVAILABLE',
      suffix,
      reason + suffix + ' extra',
      reason + ' (ACP_OTHER_ERROR)',
    ])
      f.emit('child', message)
    f.emit('', reason + suffix)
    expect(f.feedback.getSnapshot()).toBe(before)
    f.emit('child', reason + suffix)
    expect(f.feedback.getSnapshot()).not.toBe(before)
  })

  it('releases the listener on unload and dismisses only the current toast', () => {
    const f = fixture()
    const unmount = f.mount()
    expect(f.listeners.size).toBe(1)
    f.emit('child', reason + suffix)
    const first = f.feedback.getSnapshot()!
    f.emit('child', reason + suffix)
    f.feedback.dismiss(first.sequence)
    expect(f.feedback.getSnapshot()).not.toBeNull()
    unmount()
    expect(f.listeners.size).toBe(0)
    const last = f.feedback.getSnapshot()!
    f.emit('child', 'Late' + suffix)
    expect(f.feedback.getSnapshot()).toBe(last)
    f.feedback.dismiss(last.sequence)
    expect(f.feedback.getSnapshot()).toBeNull()
    f.mount()
    f.emit('child', reason + suffix)
    expect(f.feedback.getSnapshot()).not.toBeNull()
  })
})
