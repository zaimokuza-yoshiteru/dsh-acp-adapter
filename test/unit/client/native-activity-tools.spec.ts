import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { nativeActivityToolBlock, renderNativeActivityTool } from '../../../src/client/ui/AcpActivityNode.ts'
import { NativeTerminalOutputNotice, type NativeToolOwner } from '../../../src/client/ui/native-tool-renderer.ts'
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
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'unwraps Codex MCP output while retaining the %s protocol state and recorded payload',
    (status) => {
      const rawDetail = JSON.stringify({
        toolKind: 'execute',
        toolName: 'wait_agent',
        rawInput: { server: 'dshteam_0867544f17003968', tool: 'wait_agent', arguments: { timeout_ms: 3600000 } },
        rawOutput: {
          result: { content: [{ type: 'text', text: 'Original tool response' }], structuredContent: null, _meta: null },
          error: null,
        },
      })
      const activity = { ...row, status, rawDetail }
      const block = nativeActivityToolBlock(activity, undefined, undefined, (key) => key)
      expect(block).toMatchObject({
        name: 'wait_agent',
        content: [{ type: 'text', text: 'Original tool response' }],
        isError: status !== 'completed',
      })
      if (status === 'cancelled') expect(block).toHaveProperty('error', { name: 'Interrupted', code: 'interrupted' })
      expect(activity.rawDetail).toBe(rawDetail)
      // A transport envelope saying error:null does not certify successful execution.
      expect(block).not.toHaveProperty('meta')
    },
  )

  it('keeps one disclosure owner mounted from running through missing output to a late output update', () => {
    const disclosure = { expanded: true, toggle() {}, setExpanded() {} }
    const slots: NativeToolOwner[] = []
    const owner = {
      node: { kind: 'assistant-step', key: 'same-tool', data: {} },
      useDisclosure: () => disclosure,
      renderFactorySlot: (_name: string, props: NativeToolOwner) => {
        slots.push(props)
        return null
      },
    }
    const roots: ReactElement<{ children: ReactElement }>[] = []
    for (const phase of ['running', 'missing', 'late-output'] as const) {
      const activity = {
        ...row,
        status: phase === 'running' ? ('running' as const) : ('completed' as const),
        rawDetail: JSON.stringify({
          toolKind: 'execute',
          rawInput: { command: 'same command' },
          ...(phase === 'late-output' ? { rawOutput: 'late real output' } : {}),
          ...(phase === 'running' ? {} : { exitCode: 0 }),
        }),
      }
      const element = renderNativeActivityTool(owner as never, activity, (key) => key) as ReactElement
      const root = (element.type as (props: typeof element.props) => ReactElement<{ children: ReactElement }>)(
        element.props,
      )
      roots.push(root)
      const child = root.props.children
      ;(child.type as (props: typeof child.props) => unknown)(child.props)
    }
    expect(roots.every((item) => item.type === roots[0]!.type)).toBe(true)
    expect(roots.every((item) => item.props.children.type === roots[0]!.props.children.type)).toBe(true)
    expect(roots.map((item) => (item.props as { value?: string }).value)).toEqual([
      undefined,
      'activity.terminal.outputNotProvided',
      undefined,
    ])
    expect(slots).toHaveLength(3)
    for (const props of slots) expect(props.useDisclosure()).toBe(disclosure)
  })

  it.each(['completed-missing', 'failed-missing', 'running-missing', 'completed-empty', 'completed-output'])(
    'keeps the missing-output notice outside tool data for %s',
    (scenario) => {
      const detail = {
        toolKind: 'execute',
        rawInput: { command: 'run command' },
        content: [{ type: 'content', content: { type: 'text', text: 'Exited with code 17' } }],
        ...(scenario === 'completed-empty'
          ? { rawOutput: '' }
          : scenario === 'completed-output'
            ? { rawOutput: 'real stdout' }
            : {}),
      }
      const activity = {
        ...row,
        status: scenario.startsWith('running')
          ? ('running' as const)
          : scenario.startsWith('failed')
            ? ('failed' as const)
            : ('completed' as const),
        rawDetail: JSON.stringify(detail),
      }
      const owner = {
        node: { kind: 'assistant-step', key: 'assistant', data: {} },
        useDisclosure: () => ({ expanded: false, toggle() {}, setExpanded() {} }),
        renderFactorySlot: () => null,
      }
      const element = renderNativeActivityTool(owner as never, activity, (key) => key) as ReactElement
      const Native = element.type as (props: typeof element.props) => ReactElement
      const rendered = Native(element.props)
      const missing = scenario === 'completed-missing' || scenario === 'failed-missing'
      expect(rendered.type).toBe(NativeTerminalOutputNotice.Provider)
      expect(rendered.props).toHaveProperty('value', missing ? 'activity.terminal.outputNotProvided' : undefined)
      const block = nativeActivityToolBlock(activity, undefined, undefined, (key) => key)
      expect(JSON.stringify(block)).not.toContain('outputNotProvided')
      if ('content' in block) {
        expect(block.content).toEqual([
          {
            type: 'text',
            text: scenario === 'completed-output' ? 'real stdout\n[exit code: 17]' : '\n[exit code: 17]',
          },
        ])
        expect(block.isError).toBe(scenario.startsWith('failed'))
      }
    },
  )
  it.each([false, true])(
    'unwraps only the verified Claude Bash envelope and keeps literal output fences (translated=%s)',
    (translated) => {
      const stdout = 'first\n```console\nliteral fence\n```\n```js\nsecond block\n```\n'
      const detail = {
        toolKind: 'execute',
        toolSource: 'claude:Bash',
        rawInput: { command: 'printf output' },
        rawOutput: stdout,
        content: [{ type: 'content', content: { type: 'text', text: `\`\`\`console\n${stdout.trimEnd()}\n\`\`\`` } }],
      }
      const block = nativeActivityToolBlock(
        { ...row, rawDetail: JSON.stringify(detail) },
        undefined,
        undefined,
        translated ? (key) => key : undefined,
      )
      expect(block).toMatchObject({ content: [{ type: 'text', text: stdout }] })
      expect(detail.rawOutput).toBe(stdout)
    },
  )

  it.each(['unidentified', 'other-provider', 'different-payload', 'multiple-atoms'])(
    'preserves possible literal fences for %s output',
    (source) => {
      const stdout = 'literal output\n'
      const wrapped = `\`\`\`console\n${stdout.trimEnd()}\n\`\`\``
      const content = [{ type: 'content', content: { type: 'text', text: wrapped } }]
      if (source === 'multiple-atoms')
        content.push({ type: 'content', content: { type: 'text', text: 'separate output' } })
      const block = normalize({
        toolKind: 'execute',
        toolSource: source === 'unidentified' ? undefined : source === 'other-provider' ? 'other:Bash' : 'claude:Bash',
        rawInput: { command: 'echo output' },
        rawOutput: source === 'different-payload' ? 'different output' : stdout,
        content,
      })
      expect(JSON.stringify(block)).toContain(JSON.stringify(wrapped).slice(1, -1))
    },
  )

  it.each(['Edit', 'Write'])(
    'keeps verified Claude %s failures as file operations with the complete real error',
    (tool) => {
      const error =
        '<tool_use_error>No changes to make: old_string and new_string are exactly the same.</tool_use_error>'
      const detail = {
        toolSource: `claude:${tool}`,
        toolKind: 'edit',
        rawInput: { file_path: '/workspace/src/records.mjs', old_string: 'same', new_string: 'same' },
        locations: [{ path: '/workspace/src/records.mjs' }],
        rawOutput: error,
        content: [{ type: 'content', content: { type: 'text', text: `\`\`\`\n${error}\n\`\`\`` } }],
      }
      const block = nativeActivityToolBlock(
        { ...row, status: 'failed', presentation: `${tool} src/records.mjs`, rawDetail: JSON.stringify(detail) },
        undefined,
        undefined,
        (key) => key,
      )
      expect(block).toMatchObject({
        name: tool.toLowerCase(),
        isError: true,
        meta: { path: '/workspace/src/records.mjs' },
        content: [{ type: 'text', text: error }],
      })
      expect('meta' in block ? block.meta : undefined).not.toHaveProperty('diffs')
      expect(detail.content[0]!.content.text).toBe(`\`\`\`\n${error}\n\`\`\``)
    },
  )

  it('preserves a bare fence on successful Claude output rather than treating it as an error envelope', () => {
    const output = 'literal fenced sample'
    const wrapped = `\`\`\`\n${output}\n\`\`\``
    const block = normalize({
      toolSource: 'claude:Bash',
      toolKind: 'execute',
      rawInput: { command: 'printf sample' },
      rawOutput: output,
      content: [{ type: 'content', content: { type: 'text', text: wrapped } }],
    })
    expect(block).toMatchObject({ content: [{ type: 'text', text: wrapped }] })
  })

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
    const provider = Native(element.props) as ReactElement<{ children: ReactElement }>
    const shared = provider.props.children
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
