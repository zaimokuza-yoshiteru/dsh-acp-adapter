import { describe, expect, it } from 'vitest'
import { nativeActivityToolBlock } from '../../../src/client/ui/AcpActivityNode.ts'
import type { AcpActivityView } from '../../../src/contract/remote.ts'

const row: AcpActivityView = {
  dshSessionId: 'view', ownerDshSessionId: 'owner', promptAnchorMessageId: 'prompt',
  activityId: 'tool:1', activitySeq: 1, revisionSeq: 2, time: 42,
  kind: 'tool', status: 'completed', presentation: 'send_message',
}
const normalize = (detail: unknown, patch: Partial<AcpActivityView> = {}) => nativeActivityToolBlock({
  ...row, ...patch, rawDetail: JSON.stringify(detail),
})

describe('ACP presentation normalization into native tool blocks', () => {
  it('unwraps MCP arguments without mistaking execute-kind tools for shell commands', () => {
    const block = normalize({ toolKind: 'execute', rawInput: {
      server: 'dshteam_0867544f17003968', tool: '0867544f17003968_send_message',
      arguments: { target: 'repo-codex', message: 'Review this repository' },
    }, rawOutput: 'queued' })
    expect(block).toMatchObject({ call: { name: 'send_message', argsRaw: '{"target":"repo-codex","message":"Review this repository"}' }, content: [{ type: 'text', text: 'queued' }] })
  })

  it('uses Bash for actual commands and preserves known nonzero exit status', () => {
    expect(normalize({ toolKind: 'execute', rawInput: { command: 'npm test', cwd: '/work' }, rawOutput: { formatted_output: 'failed\n', exit_code: 2 } }, { presentation: 'Run tests' }))
      .toMatchObject({ call: { name: 'bash', argsRaw: '{"command":"npm test","cwd":"/work","workdir":"/work","description":"Run tests"}' }, content: [{ type: 'text', text: 'failed\n\n[exit code: 2]' }] })
    const unknown = normalize({ toolKind: 'execute', rawInput: { command: 'npm test' }, rawOutput: 'still no exit status' })
    expect(unknown).toMatchObject({ call: { name: 'bash', argsRaw: '{"command":"npm test"}' } })
    expect(JSON.stringify(unknown)).not.toContain('[exit code: 0]')
  })

  it('keeps native read metadata and complete diff sides rather than truncated diagnostics', () => {
    const read = normalize({ toolKind: 'read', rawInput: { path: 'file.ts' }, rawOutput: '1\tconst n = 1\n2\tn++\n' })
    expect(read).toMatchObject({ call: { name: 'read' }, meta: { path: 'file.ts', lines: [{ number: 1, text: 'const n = 1' }, { number: 2, text: 'n++' }], totalLines: 2 } })
    expect(normalize({ toolKind: 'read', rawInput: { path: 'file.ts' }, rawOutput: '10\tline ten\n' })).not.toHaveProperty('meta')
    const diff = normalize({}, { display: { diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] } })
    expect(diff).toMatchObject({ call: { name: 'edit' }, meta: { diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] } })
  })

  it('keeps running, failed and interrupted states distinct and IDs unique across prompts', () => {
    expect(normalize({}, { status: 'running' })).toMatchObject({ phase: 'start' })
    expect(normalize({}, { status: 'running' })).not.toHaveProperty('kind')
    expect(normalize({}, { status: 'failed' })).toMatchObject({ isError: true })
    expect(normalize({}, { status: 'cancelled' })).toMatchObject({ isError: true, error: { code: 'interrupted' } })
    expect(normalize({}, { promptAnchorMessageId: 'next' }).callId).not.toBe(normalize({}).callId)
  })
})
