import { describe, expect, it, vi } from 'vitest'
import { useContext, type ReactElement, type ReactNode } from 'react'
import type { AcpActivityView } from '../../../src/contract/remote.ts'
import { nativeActivityToolBlock, renderNativeActivityTool } from '../../../src/client/ui/AcpActivityNode.ts'
import { NativeTerminalOutputNotice, type NativeToolOwner } from '../../../src/client/ui/native-tool-renderer.ts'
import { en, type AcpLocaleKey } from '../../../src/client/ui/locales.ts'

const t = (key: AcpLocaleKey, params: Record<string, string | number> = {}) =>
  en[key].replace(/\{([^}]+)\}/g, (_match, name: string) => String(params[name] ?? ''))
const row: AcpActivityView = {
  dshSessionId: 'view',
  ownerDshSessionId: 'owner',
  promptAnchorMessageId: 'prompt',
  activityId: 'mixed',
  activitySeq: 1,
  revisionSeq: 2,
  time: 42,
  kind: 'tool',
  status: 'completed',
  presentation: 'Export report',
}
const content = [
  { type: 'content', content: { type: 'text', text: 'Report ready' } },
  {
    type: 'content',
    content: { type: 'resource_link', name: 'Report A', uri: 'https://example.test/a?token=private' },
  },
  { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'PRIVATE_BASE64' } },
]
const withDetail = (detail: unknown, patch: Partial<AcpActivityView> = {}): AcpActivityView => ({
  ...row,
  ...patch,
  rawDetail: JSON.stringify(detail),
})
const render = (element: ReactElement): ReactNode => {
  if (typeof element.type === 'function')
    return (element.type as (props: typeof element.props) => ReactNode)(element.props)
  // Match the scoped Context behavior of the React element-tree stub. A
  // Provider is not a component function; its value applies only to children.
  const provider = element.type as unknown as {
    $$typeof?: symbol
    _context: { _currentValue: unknown }
  }
  if (provider.$$typeof === Symbol.for('react.provider')) {
    const previous = provider._context._currentValue
    const props = element.props as { value: unknown; children: ReactElement }
    provider._context._currentValue = props.value
    try {
      return render(props.children)
    } finally {
      provider._context._currentValue = previous
    }
  }
  throw new Error('Expected a component or Context Provider in this render step')
}

describe('Host terminal outcome presentation', () => {
  const originalOutput = { type: 'text', text: 'Exited with code 2. Final output:\n\nshell syntax error\n' }
  const content = [{ type: 'terminal', terminalId: 'known-terminal' }]
  const hostTerminalOutcome = {
    source: 'acp-client-terminal',
    dshSessionId: row.ownerDshSessionId,
    acpSessionId: 'owned-agent',
    terminalId: 'known-terminal',
    exitCode: 2,
    signal: null,
  }

  it.each([
    { exitCode: 2, signal: null, failed: true, suffix: '[exit code: 2]' },
    { exitCode: 0, signal: null, failed: false, suffix: '[exit code: 0]' },
    { exitCode: null, signal: 'SIGTERM', failed: true, suffix: '[killed by signal: SIGTERM]' },
  ])('uses the exact Host result while preserving completed vendor state (%j)', (result) => {
    const detail = {
      toolKind: 'execute',
      rawInput: { command: 'original command' },
      rawOutput: originalOutput,
      content,
      hostTerminalOutcome: { ...hostTerminalOutcome, exitCode: result.exitCode, signal: result.signal },
    }
    const before = JSON.stringify(detail)
    const activity = withDetail(detail)
    const block = nativeActivityToolBlock(activity)
    expect(block).toMatchObject({ kind: 'tool-result', name: 'bash', isError: result.failed })
    expect(JSON.stringify(block)).toContain(result.suffix)
    expect(JSON.stringify(block)).toContain('shell syntax error')
    expect(activity.status).toBe('completed')
    expect(activity.rawDetail).toBe(before)
    expect(JSON.stringify(detail)).toBe(before)
  })

  it.each(['absent', 'foreign', 'unknown-reference', 'multiple-references'])(
    'does not parse multi-line output or guess an outcome for %s',
    (scenario) => {
      const detail = {
        toolKind: 'execute',
        rawInput: { command: 'original command' },
        rawOutput: originalOutput,
        content:
          scenario === 'unknown-reference'
            ? [{ type: 'terminal', terminalId: 'unknown' }]
            : scenario === 'multiple-references'
              ? [...content, ...content]
              : content,
        ...(scenario === 'absent'
          ? {}
          : {
              hostTerminalOutcome: {
                ...hostTerminalOutcome,
                ...(scenario === 'foreign' ? { dshSessionId: 'another-owner' } : {}),
              },
            }),
      }
      const block = nativeActivityToolBlock(withDetail(detail))
      expect(block).toMatchObject({ kind: 'tool-result', isError: false })
      expect(JSON.stringify(block)).not.toContain('[exit code: 2]')
      expect(JSON.stringify(block)).toContain('shell syntax error')
    },
  )
})

describe('native mixed ACP tool presentation', () => {
  it('scopes missing-output copy to the native card without changing its output or leaking to another render', () => {
    const notices: (string | undefined)[] = []
    const renderFactorySlot = vi.fn((_name: string, _props: NativeToolOwner) => {
      notices.push(useContext(NativeTerminalOutputNotice))
      return 'native-tool'
    })
    const owner = {
      node: { kind: 'assistant-step', key: 'assistant', data: {} },
      useDisclosure: () => ({ expanded: true, toggle() {}, setExpanded() {} }),
      renderFactorySlot,
    }
    for (const output of [undefined, ''] as const) {
      const component = render(
        renderNativeActivityTool(
          owner as never,
          withDetail(
            {
              toolKind: 'execute',
              rawInput: { command: 'command' },
              content: [{ type: 'content', content: { type: 'text', text: 'Exited with code 17' } }],
              ...(output === undefined ? {} : { rawOutput: output }),
            },
            { status: 'failed' },
          ),
          t,
        ) as ReactElement,
      ) as ReactElement
      const rendered = render(component) as ReactElement<{ children: ReactNode[] }>
      expect(rendered.props.children[0]).toBe('native-tool')
      expect(useContext(NativeTerminalOutputNotice)).toBeUndefined()
      expect(renderFactorySlot.mock.calls.at(-1)![1].node.data.root).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: '\n[exit code: 17]' }],
      })
    }
    expect(notices).toEqual(['Output was not provided in this tool record.', undefined])
  })
  it('puts safe ordered mixed output in the generic native tool, without a second disclosure', () => {
    const useDisclosure = vi.fn(() => ({ expanded: false, toggle() {}, setExpanded() {} }))
    const renderFactorySlot = vi.fn((_name: string, _props: NativeToolOwner) => 'native-tool')
    const owner = { node: { kind: 'assistant-step', key: 'assistant', data: {} }, useDisclosure, renderFactorySlot }
    const result = render(
      renderNativeActivityTool(owner as never, withDetail({ toolName: 'export_report', content }), t) as ReactElement,
    ) as ReactElement
    expect(useDisclosure).not.toHaveBeenCalled()
    expect((render(result) as ReactElement<{ children: ReactNode[] }>).props.children[0]).toBe('native-tool')
    expect(useDisclosure).toHaveBeenCalledTimes(1)
    const props = renderFactorySlot.mock.calls[0]![1]
    expect(props.useDisclosure().expanded).toBe(false)
    expect(props.inspectCall).toBeUndefined()
    const block = props.node.data.root
    expect(block).toMatchObject({
      name: 'export_report',
      subCalls: [],
      content: [{ type: 'text', text: expect.stringContaining('Report ready\nThis tool record') }],
    })
    expect(JSON.stringify(block)).toContain('image/png')
    expect(JSON.stringify(block)).not.toMatch(/PRIVATE_BASE64|token=private/)
  })

  it('keeps shell mixed descriptions in the terminal output and emits one native exit status', () => {
    const block = nativeActivityToolBlock(
      withDetail({
        toolKind: 'execute',
        rawInput: { command: 'export report' },
        content: [...content, { type: 'content', content: { type: 'text', text: 'Exited with code 0' } }],
      }),
      undefined,
      undefined,
      t,
    )
    expect(block).toMatchObject({
      name: 'bash',
      content: [{ type: 'text', text: expect.stringContaining('Report A') }],
    })
    expect('kind' in block && block.content).toEqual([
      { type: 'text', text: expect.stringMatching(/image\/png\n\[exit code: 0\]$/) },
    ])
    expect(JSON.stringify(block)).not.toContain('Exited with code')
    expect(JSON.stringify(block).match(/exit code: 0/g)).toHaveLength(1)
  })

  it('retains canonical shell stdout when display text is a different caption', () => {
    const block = nativeActivityToolBlock(
      withDetail({
        toolKind: 'execute',
        rawInput: { command: 'export report' },
        rawOutput: { formatted_output: 'ACTUAL_STDOUT', exit_code: 0 },
        content,
      }),
      undefined,
      undefined,
      t,
    )
    expect(block).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('ACTUAL_STDOUT\nReport ready\nThis tool record') }],
    })
    expect(JSON.stringify(block).match(/ACTUAL_STDOUT/g)).toHaveLength(1)
  })

  it('shares one native disclosure result with the diff supplement and preserves captions without duplicate diff text', () => {
    let expanded = false
    const toggle = vi.fn(() => {
      expanded = !expanded
    })
    const useDisclosure = vi.fn(() => ({
      expanded,
      toggle,
      setExpanded: (value: boolean) => {
        expanded = value
      },
    }))
    const renderFactorySlot = vi.fn((_name: string, _props: NativeToolOwner) => 'native-tool')
    const owner = { node: { kind: 'assistant-step', key: 'assistant', data: {} }, useDisclosure, renderFactorySlot }
    const mixed = withDetail(
      { content: [...content, { type: 'diff', path: 'report.md', oldText: 'old', newText: 'new' }] },
      {
        display: { diffs: [{ path: 'report.md', oldText: 'old', newText: 'new' }] },
      },
    )
    const supplement = render(renderNativeActivityTool(owner as never, mixed, t) as ReactElement) as ReactElement
    expect(useDisclosure).not.toHaveBeenCalled()
    const closed = render(supplement) as ReactElement<{ children: ReactNode[] }>
    expect(useDisclosure).toHaveBeenCalledTimes(1)
    expect(closed.props.children[1]).toBeNull()
    const shared = renderFactorySlot.mock.calls.at(-1)![1].useDisclosure
    expect(shared().expanded).toBe(false)
    shared().toggle()
    const opened = render(supplement) as ReactElement<{ children: ReactNode[] }>
    expect(useDisclosure).toHaveBeenCalledTimes(2)
    expect(renderFactorySlot.mock.calls.at(-1)![1].useDisclosure().expanded).toBe(true)
    const text = JSON.stringify(opened.props.children[1])
    expect(text).toContain('Report ready')
    expect(text).toContain('Report A')
    expect(text).not.toContain('File difference:')
    expect(text).not.toContain('PRIVATE_BASE64')
    // Model a native turn reset; no adapter state can retain an obsolete open bit.
    expanded = false
    expect((render(supplement) as ReactElement<{ children: ReactNode[] }>).props.children[1]).toBeNull()
    expect(renderFactorySlot.mock.calls.at(-1)![1].useDisclosure().expanded).toBe(false)
  })

  it.each([
    {
      label: 'authored display caption',
      detail: {
        content: [{ type: 'content', content: { type: 'text', text: 'Check the migration before deployment.' } }],
      },
      supplement: true,
    },
    { label: 'raw-only success output', detail: { rawOutput: 'Wrote report.md' }, supplement: false },
  ])('preserves $label according to its source beside a native diff', ({ detail, supplement }) => {
    const owner = {
      node: { kind: 'assistant-step', key: 'assistant', data: {} },
      useDisclosure: () => ({ expanded: true, toggle() {}, setExpanded() {} }),
      renderFactorySlot: () => 'native-tool',
    }
    const mixed = withDetail(detail, { display: { diffs: [{ path: 'report.md', oldText: 'old', newText: 'new' }] } })
    const component = render(renderNativeActivityTool(owner as never, mixed, t) as ReactElement) as ReactElement
    const result = render(component) as ReactElement<{ children: ReactNode[] }>
    expect(result.props.children[1] !== null).toBe(supplement)
    if (supplement) expect(JSON.stringify(result)).toContain('Check the migration before deployment.')
  })

  it.each([
    { status: 'failed' as const, rawInput: {} },
    { status: 'completed' as const, rawInput: { replace_all: 'invalid' } },
  ])(
    'retains the generic native output when a $status diff cannot use the native diff card',
    ({ status, rawInput }) => {
      const useDisclosure = vi.fn(() => ({ expanded: false, toggle() {}, setExpanded() {} }))
      const renderFactorySlot = vi.fn(() => 'native-tool')
      const owner = { node: { kind: 'assistant-step', key: 'assistant', data: {} }, useDisclosure, renderFactorySlot }
      const mixed = withDetail(
        { content, rawInput },
        { status, display: { diffs: [{ path: 'report.md', oldText: 'old', newText: 'new' }] } },
      )
      const component = render(renderNativeActivityTool(owner as never, mixed, t) as ReactElement) as ReactElement
      const result = render(component) as ReactElement<{ children: ReactNode[] }>
      expect(result.props.children).toEqual(['native-tool', null])
    },
  )
})
