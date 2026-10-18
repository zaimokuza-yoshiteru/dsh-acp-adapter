import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { nativeActivityToolBlock, renderNativeActivityTool } from '../../../src/client/ui/AcpActivityNode.ts'
import type { NativeToolOwner } from '../../../src/client/ui/native-tool-renderer.ts'
import type { AcpActivityView } from '../../../src/contract/remote.ts'

const row: AcpActivityView = {
  dshSessionId: 'view',
  ownerDshSessionId: 'owner',
  promptAnchorMessageId: 'prompt',
  activityId: 'tool:1',
  activitySeq: 1,
  revisionSeq: 2,
  time: 42,
  kind: 'tool',
  status: 'completed',
  presentation: 'send_message',
}
const normalize = (detail: unknown, patch: Partial<AcpActivityView> = {}) =>
  nativeActivityToolBlock({
    ...row,
    ...patch,
    rawDetail: JSON.stringify(detail),
  })

describe('ACP presentation normalization into native tool blocks', () => {
  it.each([
    { status: 'running' as const },
    { status: 'completed' as const },
    { status: 'failed' as const },
    { status: 'completed' as const, detailDeferred: true as const },
  ])('omits unsupported native trajectory inspection for $status activity with deferred=$detailDeferred', (patch) => {
    const nativeInspect = vi.fn()
    const renderFactorySlot = vi.fn((_name: string, _owner: NativeToolOwner) => 'native-tool')
    const owner = {
      node: { kind: 'assistant-step', key: 'assistant', data: {} },
      inspectCall: nativeInspect,
      useDisclosure: () => ({ expanded: false, toggle() {}, setExpanded() {} }),
      renderFactorySlot,
    }
    const element = renderNativeActivityTool(owner as never, { ...row, ...patch }, (key) => key) as ReactElement
    const Native = element.type as (props: typeof element.props) => ReactNode
    const shared = Native(element.props) as ReactElement
    const Shared = shared.type as (props: typeof shared.props) => ReactElement<{ children: ReactNode[] }>
    expect(Shared(shared.props).props.children[0]).toBe('native-tool')
    expect(renderFactorySlot).toHaveBeenCalledExactlyOnceWith(
      'acp.native-tool',
      expect.objectContaining({
        inspectCall: undefined,
        node: expect.objectContaining({ kind: 'tool-call' }),
      }),
    )
    expect(nativeInspect).not.toHaveBeenCalled()
    expect(owner.inspectCall).toBe(nativeInspect)
  })

  it.each(['running', 'completed'] as const)('provides native argument readers for %s activity', (status) => {
    const block = normalize(
      { toolKind: 'execute', rawInput: { command: 'npm test', cwd: '/work' }, rawOutput: 'done' },
      { status },
    )
    expect(block.name).toBe('bash')
    expect(block.args.text('command')).toBe('npm test')
    expect(block.args.text('workdir')).toBe('/work')
    expect(block.args.isSealed).toBe(true)
  })

  it('unwraps MCP arguments without mistaking execute-kind tools for shell commands', () => {
    const block = normalize({
      toolKind: 'execute',
      rawInput: {
        server: 'dshteam_0867544f17003968',
        tool: '0867544f17003968_send_message',
        arguments: { target: 'repo-codex', message: 'Review this repository' },
      },
      rawOutput: 'queued',
    })
    expect(block).toMatchObject({
      call: { name: 'send_message', argsRaw: '{"target":"repo-codex","message":"Review this repository"}' },
      content: [{ type: 'text', text: 'queued' }],
    })
  })

  it('uses Bash for actual commands and preserves known nonzero exit status', () => {
    expect(
      normalize(
        {
          toolKind: 'execute',
          rawInput: { command: 'npm test', cwd: '/work' },
          rawOutput: { formatted_output: 'failed\n', exit_code: 2 },
        },
        { presentation: 'Run tests' },
      ),
    ).toMatchObject({
      call: {
        name: 'bash',
        argsRaw: '{"command":"npm test","cwd":"/work","workdir":"/work","description":"Run tests"}',
      },
      content: [{ type: 'text', text: 'failed\n\n[exit code: 2]' }],
    })
    const unknown = normalize({
      toolKind: 'execute',
      rawInput: { command: 'npm test' },
      rawOutput: 'still no exit status',
    })
    expect(unknown).toMatchObject({ call: { name: 'bash', argsRaw: '{"command":"npm test"}' } })
    expect(JSON.stringify(unknown)).not.toContain('[exit code: 0]')
  })

  it('keeps numbered read output without inventing a file total and retains complete diff sides', () => {
    const read = normalize({ toolKind: 'read', rawInput: { path: 'file.ts' }, rawOutput: '1\tconst n = 1\n2\tn++\n' })
    expect(read).toMatchObject({
      call: { name: 'read' },
      content: [{ type: 'text', text: '1\tconst n = 1\n2\tn++\n' }],
    })
    expect(read).not.toHaveProperty('meta')
    expect(
      normalize({ toolKind: 'read', rawInput: { path: 'file.ts' }, rawOutput: '10\tline ten\n' }),
    ).not.toHaveProperty('meta')
    const diff = normalize({}, { display: { diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] } })
    expect(diff).toMatchObject({
      call: { name: 'edit' },
      meta: { diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] },
    })
  })

  it.each([1, 40])('does not equate a limited window starting at %s with the whole file', (start) => {
    const text = `${start}\tvisible\n${start + 1}\tcontent\n<system>read status</system>\n`
    const block = normalize({
      toolKind: 'read',
      rawInput: { path: 'file.ts', offset: start, limit: 2 },
      rawOutput: text,
    })
    expect(block).not.toHaveProperty('meta')
    expect(block).toMatchObject({ content: [{ type: 'text', text }] })
  })

  it.each([
    ['src/file.ts', '/old/workspace/src/file.ts'],
    ['./src/file.ts', '/old/workspace/src/file.ts'],
    ['src\\file.ts', 'C:\\old\\workspace\\src\\file.ts'],
    ['src/file.ts', '\\\\server\\share\\src\\file.ts'],
  ])('records the operation-time location for %s without rewriting tool arguments', (file, location) => {
    const block = normalize({
      toolKind: 'read',
      rawInput: { path: file },
      rawOutput: '1\tcontent',
      locations: [{ path: location, line: 1 }],
    })
    expect(block).toMatchObject({ meta: { path: location }, call: { name: 'read' } })
    expect(block.args.text('file_path')).toBe(file)
    expect(block).not.toHaveProperty('meta.totalLines')
  })

  it('adds the operation-time location without replacing complete diff metadata', () => {
    const block = normalize(
      { locations: [{ path: '/old/workspace/file.ts' }] },
      { display: { diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] } },
    )
    expect(block).toMatchObject({
      meta: { path: '/old/workspace/file.ts', diffs: [{ path: 'file.ts', oldText: 'old', newText: 'new' }] },
    })
  })

  it.each([
    { file: 'file.ts', locations: [{ path: '/old/file.ts' }, { path: '/other/file.ts' }] },
    { file: 'file.ts', locations: [{ path: '/old/other.ts' }] },
    { file: '/new/file.ts', locations: [{ path: '/old/file.ts' }] },
    { file: 'file.ts', locations: [{ path: 'old/file.ts' }] },
    { file: '../file.ts', locations: [{ path: '/old/file.ts' }] },
    { file: '*.ts', locations: [{ path: '/old/file.ts' }] },
    { file: '.', locations: [{ path: '/old/' }] },
  ])('does not guess a recorded path from ambiguous locations: $file / $locations', ({ file, locations }) => {
    const block = normalize({ toolKind: 'read', rawInput: { path: file }, rawOutput: '1\tcontent', locations })
    expect(block).not.toHaveProperty('meta')
  })

  it('does not choose one operation path for a multi-file diff', () => {
    const block = normalize(
      { locations: [{ path: '/old/a.ts' }] },
      {
        display: {
          diffs: [
            { path: 'a.ts', oldText: 'a', newText: 'A' },
            { path: 'b.ts', oldText: 'b', newText: 'B' },
          ],
        },
      },
    )
    expect(block).not.toHaveProperty('meta.path')
  })

  it('keeps running, failed and interrupted states distinct and IDs unique across prompts', () => {
    expect(normalize({}, { status: 'running' })).toMatchObject({ phase: 'start' })
    expect(normalize({}, { status: 'running' })).not.toHaveProperty('kind')
    expect(normalize({}, { status: 'failed' })).toMatchObject({ isError: true })
    expect(normalize({}, { status: 'cancelled' })).toMatchObject({ isError: true, error: { code: 'interrupted' } })
    expect(normalize({}, { promptAnchorMessageId: 'next' }).callId).not.toBe(normalize({}).callId)
  })

  it('refuses to fabricate a native result for an unfinished activity', () => {
    expect(() => normalize({}, { status: 'unfinished' })).toThrow(/cannot be projected as a native tool result/)
  })
})
