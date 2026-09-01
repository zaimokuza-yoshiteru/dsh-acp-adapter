import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { createAcpNativePermissionHandler, type AcpPermissionAuditRecord } from '../../../src/domain/policy/permissions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

const params = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({ sessionId: 'acp-session', toolCall: { toolCallId: 'acp-call', title: 'Run command', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello' } }, options })
const option = (optionId: string, name: string, kind: acp.PermissionOption['kind']): acp.PermissionOption => ({ optionId, name, kind })
function bridge(answer: string | undefined, custom?: string): { handler: ReturnType<typeof createAcpNativePermissionHandler>; ask: ReturnType<typeof vi.fn> } {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: answer === undefined ? [] : [answer], ...(custom === undefined ? {} : { custom }) }] }))
  return { handler: createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({ id: 'live-agent' }) }), ask }
}

describe('native ACP permission bridge', () => {
  it('uses the native approval card for allow-once/reject decisions and keeps the complete command', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const command = `printf 'first'\nprintf '${'x'.repeat(400)}'`
    const handler = createAcpNativePermissionHandler({ approval, userQuestions: { ask }, getAgent: () => ({ id: 'live-agent' }) })
    await expect(handler({
      ...params([]),
      toolCall: { ...params([]).toolCall, rawInput: { command } },
      options: [option('once', 'Allow once', 'allow_once'), option('always', 'Always', 'allow_always'), option('reject', 'Reject', 'reject_once')],
    })).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining(command) }))
    expect(ask).not.toHaveBeenCalled()
  })

  it('preserves exact Agent option ids and all four kinds through native questions', async () => {
    for (const [kind, id] of [['allow_once', 'a1'], ['allow_always', 'a2'], ['reject_once', 'r1'], ['reject_always', 'r2']] as const) {
      const name = kind === 'allow_once' ? 'Allow once' : kind === 'allow_always' ? 'Always allow' : kind === 'reject_once' ? 'Reject once' : 'Always reject'
      const { handler, ask } = bridge(name)
      await expect(handler(params([
        option(id, name, kind),
      ]))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: id } })
      expect(ask).toHaveBeenCalledOnce()
    }
  })

  it('records asked and decided sidecar facts before returning', async () => {
    const records: AcpPermissionAuditRecord[] = []
    // Use a real question seam so this test also verifies the audit ordering.
    const question: AcpNativeUserQuestionService = { ask: async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: ['Allow once'] }] }) }
    const real = createAcpNativePermissionHandler({ userQuestions: question, getAgent: () => ({}), audit: { append: async (record) => { records.push(record) } }, now: () => 100 })
    await expect(real(params([option('exact', 'Allow once', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'exact' } })
    expect(records.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
    expect(records[1]?.data).toMatchObject({ decisionVia: 'native-question' })
  })

  it('fails closed for cancel/custom/unknown answers and unavailable service', async () => {
    await expect(bridge(undefined).handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(bridge('Allow [a]', 'typed').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(bridge('Unknown [x]').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(createAcpNativePermissionHandler({ getAgent: () => ({}) })(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('rejects oversized or duplicate identities before opening native UI', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
    await expect(handler(params([option('', 'Allow', 'allow_once')]))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows names by default, uses short ordinal disambiguation, and bounds long names', async () => {
    const longName = 'x'.repeat(500)
    const { handler, ask } = bridge('Same · option 2')
    await expect(handler(params([
      option('first-secret-id', 'Same', 'allow_once'),
      option('second-secret-id', 'Same', 'reject_always'),
    ]))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'second-secret-id' } })
    const question = ask.mock.calls[0]?.[0]
    expect(question?.questions[0]?.options).toEqual([
      { label: 'Same · option 1' },
      { label: 'Same · option 2' },
    ])
    const long = bridge(`${'x'.repeat(119)}…`)
    await expect(long.handler(params([option('long-id', longName, 'allow_always')]))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'long-id' } })
    expect(long.ask.mock.calls[0]?.[0].questions[0]?.options?.[0]?.label.length).toBeLessThan(130)
  })

  it('shows the complete command in the native multi-line detail without executing controls', async () => {
    const command = `printf '${'x'.repeat(600)}'\nprintf 'Authorization: Bearer visible-to-approver'\u001b[31m`
    const { handler, ask } = bridge('Allow once')
    await expect(handler({
      ...params([option('allow', 'Allow once', 'allow_once')]),
      toolCall: { ...params([]).toolCall, rawInput: { command } },
    })).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })

    const question = ask.mock.calls[0]?.[0].questions[0]
    expect(question?.question).not.toContain(command)
    expect(question?.detail).toContain(command.slice(0, -5))
    expect(question?.detail).toContain('\\x1b[31m')
    expect(question?.detail).not.toContain('\u001b')
    expect(question?.detail).not.toContain('…')
  })
})
