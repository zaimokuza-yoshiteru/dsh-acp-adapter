import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { expect, it } from 'vitest'
import { readReviewDecision, reviewPrompt } from '../../../src/host/approval-review/decision.ts'
import { redactLegacyPermissionInput, summarizeRawInputForAudit } from '../../../src/domain/policy/events.ts'

const action: ToolCallUpdate = {
  toolCallId: 'write:1',
  name: 'write',
  rawInput: { file_path: 'README', content: 'Correct a typo' },
}

it.each([
  { headers: { Cookie: 'sid=private-fixture; other=second-fixture' } },
  { headers: [['Set-Cookie', 'sid=private-fixture; Path=/second-fixture']] },
  { headers: [{ name: 'cOOkie', value: 'sid=private-fixture; other=second-fixture' }] },
  { headers: ['Cookie: sid=private-fixture; other=second-fixture'] },
])('withholds the complete Cookie header from both the audit and model while retaining the request target', (input) => {
  const url = 'https://cookie.example.invalid/documentation'
  const rawInput = { url, ...input }
  const prior = structuredClone(rawInput)
  const prompt = reviewPrompt('Read the documentation', { toolCallId: 'fetch-1', name: 'webfetch', rawInput }, 'en')
  const { summary } = summarizeRawInputForAudit(rawInput)
  for (const text of [summary, prompt]) {
    expect(text).not.toMatch(/private-fixture|second-fixture/)
    expect(text).toContain(url)
  }
  expect(rawInput).toEqual(prior)
})

it.each([
  { headers: { 'X-Api-Key': 'private-fixture', Accept: 'text/plain' } },
  {
    headers: [
      ['Authorization', 'private-fixture'],
      ['Accept', 'text/plain'],
    ],
  },
  { rawHeaders: ['Accept', 'text/plain', 'x-aPi-kEy', 'private-fixture'] },
  {
    headers: [
      { name: 'Proxy-Authorization', value: 'private-fixture' },
      { name: 'Accept', value: 'text/plain' },
    ],
  },
  {
    headers: [
      { key: 'X-Auth-Token', value: 'private-fixture' },
      { key: 'Accept', value: 'text/plain' },
    ],
  },
])('masks credentials in HTTP header collections and preserves the other operation evidence', (headers) => {
  const url = 'https://docs.example.invalid/token/usage'
  const rawInput = { url, ...headers, references: [url, 'usage-guide', 'secrets.md', 'changes.md'] }
  const prompt = reviewPrompt('Read the documentation', { toolCallId: 'fetch', name: 'fetch', rawInput }, 'en')
  const { summary } = summarizeRawInputForAudit(rawInput)
  for (const text of [prompt, summary]) {
    expect(text).not.toContain('private-fixture')
    expect(text).toContain('<redacted>')
    expect(text).toContain('text/plain')
    expect(text).toContain(JSON.stringify(rawInput.references))
  }
})

it('keeps the target and other arguments when a command or JSON text embeds a credential header', () => {
  const target = 'https://cookie.example.invalid/set-cookie/documentation'
  const publicArgs = ' --output fixture.txt'
  for (const [input, expected] of [
    ["fetch -H 'Cookie: sid=private-fixture; pref=second-fixture'", "fetch -H 'Cookie: <redacted>'"],
    ['fetch -H "Set-Cookie: sid=private-fixture; Path=/second-fixture"', 'fetch -H "Set-Cookie: <redacted>"'],
    ['fetch -H "Cookie: sid=\\"private-fixture\\"; pref=second-fixture"', 'fetch -H "Cookie: <redacted>"'],
    ['fetch -H \\"Cookie: sid=private-fixture; pref=second-fixture\\"', 'fetch -H \\"Cookie: <redacted>\\"'],
    ['{"headers":{"Cookie":"sid=private-fixture; pref=second-fixture"}}', '{"headers":{"Cookie":"<redacted>"}}'],
    ["fetch -H 'Authorization: Custom private-fixture second-fixture'", "fetch -H 'Authorization: <redacted>'"],
    ['fetch -H "X-Api-Key: private-fixture second-fixture"', 'fetch -H "X-Api-Key: <redacted>"'],
    ['{"headers":{"X-Api-Key":"private-fixture second-fixture"}}', '{"headers":{"X-Api-Key":"<redacted>"}}'],
    ['fetch -H "X-Example: cookie documentation"', 'fetch -H "X-Example: cookie documentation"'],
  ] as const) {
    const rawInput = { command: input + ' ' + target + publicArgs }
    const prompt = reviewPrompt('Check the documentation', { toolCallId: 'one', name: 'shell', rawInput }, 'en')
    const { summary } = summarizeRawInputForAudit(rawInput)
    const legacy = redactLegacyPermissionInput({
      phase: 'asked',
      toolCall: { rawInputSummary: JSON.stringify(rawInput) },
    })
    const sanitized = { command: expected + ' ' + target + publicArgs }
    expect(prompt).toContain(JSON.stringify(sanitized))
    expect(JSON.parse(summary)).toEqual(sanitized)
    expect(legacy.toolCall).toEqual({ rawInputSummary: JSON.stringify(sanitized) })
  }
})

it('masks a complete HTTP credential field and retains the next public field and URL', () => {
  const rawInput = {
    url: 'https://example.invalid/guide',
    headers:
      'Authorization: Custom private-fixture second-fixture\r\nAccept: text/plain\r\nX-Api-Key: first part\r\n second-fixture\r\nX-Request-Id: public-id',
  }
  const prompt = reviewPrompt('Read the guide', { toolCallId: 'fetch', name: 'fetch', rawInput }, 'en')
  const audit = summarizeRawInputForAudit(rawInput)
  const expected = 'Authorization: <redacted>\r\nAccept: text/plain\r\nX-Api-Key: <redacted>\r\nX-Request-Id: public-id'
  expect(prompt).toContain(JSON.stringify(expected))
  expect(JSON.parse(audit.summary)).toEqual({ ...rawInput, headers: expected })
})

it('omits a credential-bearing field name from the audit and hands an obscured operation to the user', () => {
  const rawInput = { 'password=private-fixture': 'value-fixture', url: 'https://example.invalid/guide' }
  expect(JSON.parse(summarizeRawInputForAudit(rawInput).summary)).toEqual({ url: rawInput.url })
  expect(() => reviewPrompt('Read the guide', { toolCallId: 'fetch', name: 'fetch', rawInput }, 'en')).toThrow(
    /redaction/,
  )
})

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
      name: 'shell',
      rawInput: { token: 'test-secret', command: 'git status', unused: 'x'.repeat(600) + ' tail-evidence' },
    },
    'en',
  )
  expect(prompt).toContain('tail-evidence')
  expect(prompt).not.toContain('test-secret')
  expect(() => reviewPrompt('Check', { toolCallId: 'a', title: 'Approve' }, 'en')).toThrow(/Incomplete/)
  expect(() =>
    reviewPrompt('Check', { ...action, name: 'shell', rawInput: { command: 'x'.repeat(65536) + ' tail' } }, 'en'),
  ).toThrow(/budget/)
})

it.each(['high', 'not_high'])('preserves a %s decision in either JSON presentation', (risk) => {
  const decision = { risk, reason: 'The reviewed operation' }
  const json = JSON.stringify(decision, null, 2)
  for (const block of [json, '```json\n' + json + '\n```', '\r\n```json\r\n' + json + '\r\n```\r\n'])
    expect(readReviewDecision(block)).toEqual(decision)
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
    expect(() => readReviewDecision(text)).toThrow()
})

it('uses a reported read location or a proposed diff when approval arguments are sparse', () => {
  const target = { path: '/workspace/README.md' }
  const read: ToolCallUpdate = { toolCallId: 'read-1', name: 'read', kind: 'read', locations: [target] }
  expect(reviewPrompt('Read the documentation', read, 'en')).toContain(target.path)
  const edit: ToolCallUpdate = { ...read, name: 'edit', kind: 'edit', rawInput: { filePath: target.path } }
  expect(() => reviewPrompt('Edit the documentation', edit, 'en')).toThrow(/Incomplete/)
  expect(() => reviewPrompt('Run the checks', { ...read, name: 'shell', kind: 'execute' }, 'en')).toThrow(/Incomplete/)
  expect(() => reviewPrompt('Run the checks', { ...edit, name: 'shell', kind: 'execute' }, 'en')).toThrow(/Incomplete/)
  // An empty replacement is a real edit (clear the file) and must reach the model intact.
  const diff = { type: 'diff' as const, ...target, oldText: 'original', newText: '' }
  expect(reviewPrompt('Clear the draft', { ...edit, content: [diff] }, 'en')).toContain('"newText":""')
  expect(
    reviewPrompt('Clear the draft', { ...edit, name: 'write', rawInput: { filePath: target.path, content: '' } }, 'en'),
  ).toContain('"content":""')
  for (const rawInput of [{ command: '' }, { filePath: target.path, description: 'Checking the fixture' }]) {
    expect(() => reviewPrompt('Run the checks', { ...read, name: 'shell', kind: 'execute', rawInput }, 'en')).toThrow(
      /Incomplete/,
    )
  }
  expect(() =>
    reviewPrompt(
      'Edit the draft',
      { ...edit, rawInput: { filePath: target.path, description: 'Editing the fixture' } },
      'en',
    ),
  ).toThrow(/Incomplete/)
  expect(
    reviewPrompt(
      'Check the branch',
      { ...read, name: 'shell', kind: 'execute', rawInput: { argv: ['git', 'status'] } },
      'en',
    ),
  ).toContain('["git","status"]')
})

it('includes the full text accompanying arguments, hands off opaque content and keeps shell flags private', () => {
  const call = {
    ...action,
    name: 'shell',
    rawInput: { target: 'fixture', command: "example --password 'value with spaces'" },
  }
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
    reviewPrompt('Check access', { ...call, name: 'webfetch', rawInput: { url: 'ghp_FAKE0FAKE0FAKE0FAKE0' } }, 'en'),
  ).toThrow(/redaction/)
})
