import { expect, it } from 'vitest'
import { safeLiveDiagnostic } from '../../../scripts/live-diagnostics.ts'

it('keeps allowlisted protocol facts and drops peer text, prompt, and credential values', () => {
  const diagnostic = safeLiveDiagnostic({
    code: 'ACP_PROTOCOL_ERROR',
    message: 'ACP agent "devin" rejected session/prompt: token=top-secret prompt=private request (JSON-RPC code -32603)',
  })
  expect(diagnostic).toEqual({ code: 'ACP_PROTOCOL_ERROR', operation: 'session/prompt', jsonRpcCode: -32603 })
  expect(JSON.stringify(diagnostic)).not.toContain('top-secret')
  expect(JSON.stringify(diagnostic)).not.toContain('private request')
})

it('omits unknown operations and malformed fields instead of copying their text', () => {
  expect(safeLiveDiagnostic({ code: 'error with text', message: 'ACP rejected secret/method: hidden token (JSON-RPC code 1.2)' })).toEqual({})
})

it('extracts an allowlisted method from a generic typed-RPC failure', () => {
  expect(safeLiveDiagnostic({ code: 'ACP_PROTOCOL_ERROR', message: 'ACP session/new failed: prompt=<private>' }))
    .toEqual({ code: 'ACP_PROTOCOL_ERROR', operation: 'session/new' })
})
