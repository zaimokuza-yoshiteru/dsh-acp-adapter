import { describe, expect, it } from 'vitest'
import { summarizeRawInputForAudit } from '../../../src/domain/policy/events.ts'
import type { AcpPermissionDecidedAuditData } from '../../../src/domain/policy/events.ts'
import { devinManualPermission } from '../../fixtures/devin-manual-permission.ts'
import {
  assertDevinMarkerDecision,
  validateDevinMarkerPermission,
} from '../../e2e/live-devin-permission-lifecycle-scope.ts'

function fixture() {
  const expected = { file_path: '/isolated/once.txt', content: 'PERMISSION_ONCE' }
  const raw = summarizeRawInputForAudit(expected)
  const asked = structuredClone(devinManualPermission.asked)
  Object.assign(asked.toolCall, { title: 'write', rawInputSummary: raw.summary, rawInputHash: raw.hash })
  Object.assign(asked, {
    options: asked.options.map((option) => ({ ...option, name: option.name.replaceAll('list_agents', 'write') })),
  })
  const bridge = { ...devinManualPermission.bridge, toolName: 'write' }
  return { expected, asked, bridge, cliVersion: '3000.12.43' }
}

describe('real Devin permission lifecycle scope', () => {
  it('preserves the complete observed original options and chooses their exact one-time ids', () => {
    const input = fixture()
    const result = validateDevinMarkerPermission(input)
    expect(result).toMatchObject({
      identity: 'known-cli-manual',
      original: input.expected,
      allow: { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
      reject: { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
    })
    expect(input.asked.options).toHaveLength(7)
  })

  it('accepts a structured Devin identity without inventing support for an unknown title-only CLI', () => {
    const input = fixture()
    input.cliVersion = 'unobserved-version'
    expect(() => validateDevinMarkerPermission(input)).toThrow('IDENTITY_UNPROVEN')
    Object.assign(input.bridge, { structuredIdentityPresent: true, identitySource: 'devin-meta' })
    expect(validateDevinMarkerPermission(input).identity).toBe('devin-meta')
  })

  it.each(['agentSessionId', 'toolCallId', 'toolName'] as const)(
    'rejects a mismatched %s before any UI choice',
    (key) => {
      const input = fixture()
      input.bridge[key] = 'different'
      expect(() => validateDevinMarkerPermission(input)).toThrow('IDENTITY_MISMATCH')
    },
  )

  it.each([
    { file_path: '/outside/file', content: 'PERMISSION_ONCE' },
    { file_path: '/isolated/once.txt', content: 'different' },
    { file_path: '/isolated/once.txt', content: 'PERMISSION_ONCE', append: true },
  ])('refuses changed or extended write arguments', (raw) => {
    const input = fixture()
    const summary = summarizeRawInputForAudit(raw)
    Object.assign(input.asked.toolCall, { rawInputSummary: summary.summary, rawInputHash: summary.hash })
    expect(() => validateDevinMarkerPermission(input)).toThrow('OPERATION_MISMATCH')
  })

  it('uses complete native detail only when its hash matches the original request', () => {
    const input = fixture()
    Object.assign(input.asked.toolCall, { rawInputSummary: 'truncated' })
    const detail = `\`\`\`\n${JSON.stringify({ rawInput: input.expected })}\n\`\`\``
    expect(validateDevinMarkerPermission({ ...input, detail }).original).toEqual(input.expected)
    expect(() =>
      validateDevinMarkerPermission({ ...input, detail: detail.replace('PERMISSION_ONCE', 'changed') }),
    ).toThrow('DETAIL_CHANGED')
  })

  it('never turns missing or duplicate reject options into cancellation or a broader allow', () => {
    const input = fixture()
    Object.assign(input.bridge, { structuredIdentityPresent: true, identitySource: 'devin-meta' })
    Object.assign(input.asked, {
      options: input.asked.options.filter((option) => option.kind !== 'reject_once'),
      optionCount: 6,
    })
    expect(() => validateDevinMarkerPermission(input)).toThrow('REJECT_AMBIGUOUS')
    Object.assign(input.asked, { optionCount: 7 })
    expect(() => validateDevinMarkerPermission(input)).toThrow('OPTIONS_INCOMPLETE')
  })

  it('distinguishes allowed-once, rejected-once, and cancellation with exact request ownership', () => {
    const { asked } = fixture()
    const decision: AcpPermissionDecidedAuditData = {
      phase: 'decided',
      requestId: asked.requestId,
      agentSessionId: asked.agentSessionId,
      toolCallId: asked.toolCall.toolCallId,
      outcome: 'selected',
      decisionVia: 'native-question',
      optionId: 'allow_once',
      selectedOptionKind: 'allow_once',
    }
    expect(() => assertDevinMarkerDecision(asked, decision, 'allow')).not.toThrow()
    expect(() => assertDevinMarkerDecision(asked, decision, 'reject')).toThrow('WRONG_DECISION')
    const reject = { ...decision, optionId: 'reject_once', selectedOptionKind: 'reject_once' as const }
    expect(() => assertDevinMarkerDecision(asked, reject, 'reject')).not.toThrow()
    expect(() => assertDevinMarkerDecision(asked, reject, 'stop')).toThrow('STOP_SELECTED_OPTION')
    const stop: AcpPermissionDecidedAuditData = {
      phase: 'decided',
      requestId: asked.requestId,
      agentSessionId: asked.agentSessionId,
      toolCallId: asked.toolCall.toolCallId,
      decisionVia: 'native-question',
      outcome: 'cancelled',
    }
    expect(() => assertDevinMarkerDecision(asked, stop, 'stop')).not.toThrow()
    expect(() => assertDevinMarkerDecision(asked, stop, 'reject')).toThrow('WRONG_DECISION')
    expect(() => assertDevinMarkerDecision(asked, { ...stop, requestId: 'another' }, 'stop')).toThrow(
      'IDENTITY_CHANGED',
    )
  })
})
