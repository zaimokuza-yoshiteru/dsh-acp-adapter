import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { readReviewDecision, reviewPrompt } from '../../../src/host/approval-review/decision.ts'

const action: ToolCallUpdate = {
  toolCallId: 'write:1',
  name: 'write',
  rawInput: { file_path: 'README', content: 'Correct a typo' },
}

it.each([
  ['zh-CN', 'Check the document', 'a short Chinese sentence'],
  ['en', '检查文档', 'a short English sentence'],
  [undefined, '检查文档', 'in the language of the original user task, or in English if its language is unclear'],
] as const)('selects the reason language with host preference %s', (locale, task, instruction) => {
  const prompt = reviewPrompt(task, action, locale)
  expect(prompt).toContain(instruction)
  expect(prompt).toContain(`Original user task: ${JSON.stringify(task)}\nPending action data:`)
})

it('requires a complete action, redacts known secret values and refuses truncation', () => {
  const prompt = reviewPrompt(
    'Check the local documentation',
    {
      ...action,
      rawInput: { token: 'test-secret', command: 'git status', unused: 'x'.repeat(600) + ' tail-evidence' },
    },
    'en',
  )
  expect(prompt).toContain('tail-evidence')
  expect(prompt).not.toContain('test-secret')
  expect(() => reviewPrompt('Check', { toolCallId: 'a', title: 'Approve' }, 'en')).toThrow(/Incomplete/)
  expect(() => reviewPrompt('Check', { ...action, rawInput: { command: 'x'.repeat(65536) + ' tail' } }, 'en')).toThrow(
    /budget/,
  )
})

it('accepts bare decisions and preserves each backend’s contract for a complete JSON fence', () => {
  const low = { risk: 'not_high', reason: 'A local change' }
  const high = { risk: 'high', reason: 'Anonymous users would gain access to team documents.' }
  for (const mode of ['high-only', 'both'] as const) {
    expect(readReviewDecision(JSON.stringify(low), mode)).toEqual(low)
    expect(readReviewDecision(JSON.stringify(high), mode)).toEqual(high)
    const json = JSON.stringify(high, null, 2)
    for (const block of ['```json\n' + json + '\n```', '\r\n```json\r\n' + json + '\r\n```\r\n'])
      expect(readReviewDecision(block, mode)).toEqual(high)
  }
  const block = '```json\n' + JSON.stringify(low) + '\n```'
  expect(readReviewDecision(block, 'both')).toEqual(low)
  expect(() => readReviewDecision(block, 'high-only')).toThrow(/Unconfirmed/)
})

it('rejects prose, multiple answers and ambiguous or incomplete decisions inside or outside a fence', () => {
  const json = '{"reason":"Public access","risk":"high"}'
  const fence = '```json\n' + json + '\n```'
  for (const text of [
    '<summary>Routine.</summary>',
    'Explanation\n' + fence,
    fence + '\nExplanation',
    fence + '\n' + fence,
    '```json\n' + json + json + '\n```',
    '```json\n{"risk":"high","risk":"not_high","reason":"a"}\n```',
    '```\n' + json + '\n```',
    '```text\n' + json + '\n```',
    '{"risk":"high","risk":"not_high","reason":"a"}',
    '{"reason":"x","risk":"medium"}',
    '{"risk":"not_high","reason":""}',
    '{"risk":"not_high","reason":"a","allow":true}',
  ])
    expect(() => readReviewDecision(text, 'both')).toThrow()
})

it('includes the full text accompanying arguments, hands off opaque content and keeps shell flags private', () => {
  const call = { ...action, rawInput: { target: 'fixture', command: "example --password 'value with spaces'" } }
  const prompt = reviewPrompt(
    'Check access',
    { ...call, content: [{ type: 'content', content: { type: 'text', text: 'Set fixture access to public' } }] },
    'en',
  )
  expect(prompt).toContain('Set fixture access to public')
  expect(prompt).not.toContain('value with spaces')
  expect(() =>
    reviewPrompt('Check access', { ...call, content: [{ type: 'terminal', terminalId: 'file-only' }] }, 'en'),
  ).toThrow(/Incomplete/)
  expect(() =>
    reviewPrompt('Check access', { ...call, rawInput: { target: 'ghp_FAKE0FAKE0FAKE0FAKE0' } }, 'en'),
  ).toThrow(/redaction/)
})
