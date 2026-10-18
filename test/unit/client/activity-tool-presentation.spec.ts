import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import type { AcpActivityView } from '../../../src/contract/remote.ts'
import { nativeActivityToolBlock, renderNativeActivityTool } from '../../../src/client/ui/AcpActivityNode.ts'
import type { NativeToolOwner } from '../../../src/client/ui/native-tool-renderer.ts'
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
const render = (element: ReactElement): ReactNode =>
  (element.type as (props: typeof element.props) => ReactNode)(element.props)

describe('native mixed ACP tool presentation', () => {
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
