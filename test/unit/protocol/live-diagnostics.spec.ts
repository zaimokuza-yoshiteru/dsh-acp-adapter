import { expect, it } from 'vitest'
import { safeLiveDiagnostic } from '../../../scripts/live-diagnostics.ts'

it('keeps allowlisted protocol facts and drops peer text, prompt, and credential values', () => {
  const diagnostic = safeLiveDiagnostic({
    code: 'ACP_PROTOCOL_ERROR',
    message:
      'ACP agent "devin" rejected session/prompt: token=top-secret prompt=private request (JSON-RPC code -32603)',
  })
  expect(diagnostic).toEqual({ code: 'ACP_PROTOCOL_ERROR', operation: 'session/prompt', jsonRpcCode: -32603 })
  expect(JSON.stringify(diagnostic)).not.toContain('top-secret')
  expect(JSON.stringify(diagnostic)).not.toContain('private request')
})

it('omits unknown operations and malformed fields instead of copying their text', () => {
  expect(
    safeLiveDiagnostic({
      code: 'error with text',
      message: 'ACP rejected secret/method: hidden token (JSON-RPC code 1.2)',
    }),
  ).toEqual({})
})

it('extracts an allowlisted method from a generic typed-RPC failure', () => {
  expect(
    safeLiveDiagnostic({ code: 'ACP_PROTOCOL_ERROR', message: 'ACP session/new failed: prompt=<private>' }),
  ).toEqual({ code: 'ACP_PROTOCOL_ERROR', operation: 'session/new' })
})

it('keeps fixed Agent Teams and generic tool failure codes', () => {
  expect(safeLiveDiagnostic({ info: { code: 'TEAM_PROVISIONING_CONFLICT' } })).toEqual({
    code: 'TEAM_PROVISIONING_CONFLICT',
  })
  expect(safeLiveDiagnostic({ info: { code: 'INVALID_ARGS' } })).toEqual({ code: 'INVALID_ARGS' })
})

it('extracts only structured ToolFailure facts and never exposes failure text or metadata', () => {
  const diagnostic = safeLiveDiagnostic({
    message: 'ACP session/prompt failed: prompt=private conversation toolArgs=private (JSON-RPC code -32603)',
    info: {
      name: 'PrivateToolFailureClass',
      code: 'INVALID_TOOL_OUTPUT',
      reason: 'private failure reason',
    },
  })
  expect(diagnostic).toEqual({ code: 'INVALID_TOOL_OUTPUT', operation: 'session/prompt', jsonRpcCode: -32603 })
  const serialized = JSON.stringify(diagnostic)
  for (const secret of ['private conversation', 'toolArgs', 'PrivateToolFailureClass', 'private failure reason']) {
    expect(serialized).not.toContain(secret)
  }
})

it('omits malformed nested ToolFailure codes', () => {
  for (const code of ['not a fixed code', 'UNKNOWN_BUT_NOT_ALLOWLISTED', 'Team_Invalid_Argument']) {
    expect(
      safeLiveDiagnostic({
        message: 'private error text',
        info: { code, name: 'secret class', reason: 'secret reason' },
      }),
    ).toEqual({})
  }
})
