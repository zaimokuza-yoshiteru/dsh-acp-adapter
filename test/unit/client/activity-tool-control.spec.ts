import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import * as React from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpActivityView } from '../../../src/contract/remote.ts'
import {
  nativeActivityToolBlock,
  renderNativeActivityTool,
  usesNativeActivityToolProjection,
} from '../../../src/client/ui/AcpActivityNode.ts'
import { en, zh, type AcpLocaleKey } from '../../../src/client/ui/locales.ts'

const originalOutput =
  'DSH_WAIT_DEFERRED_TEAM_MESSAGE: A Team message is already queued for this caller, so DSH did not execute wait_agent. End this ACP response now; DSH will deliver the queued message for you to handle.'
const proof = {
  source: 'dsh-tool-bridge',
  kind: 'deferred-team-message',
  dshSessionId: 'owner',
  toolCallId: 'call-1',
  tool: 'wait_agent',
  executed: false,
}
const detail = {
  toolKind: 'execute',
  toolName: 'wait_agent',
  rawInput: { server: 'dshteam_verified', tool: 'wait_agent', arguments: { timeout_ms: 1000 } },
  rawOutput: {
    result: {
      content: [{ type: 'text', text: originalOutput }],
      structuredContent: null,
      _meta: { 'zaimokuza.dsh/acp-control': 'opaque-host-receipt' },
    },
    error: null,
  },
  hostControlOutcome: proof,
}
const row: AcpActivityView = {
  dshSessionId: 'view',
  ownerDshSessionId: 'owner',
  promptAnchorMessageId: 'prompt',
  activityId: 'prompt:tool:call-1',
  activitySeq: 1,
  revisionSeq: 2,
  time: 42,
  kind: 'tool',
  status: 'failed',
  presentation: 'wait_agent',
  rawDetail: JSON.stringify(detail),
}
type Element = ReactElement<Record<string, unknown>>
const invoke = (element: Element): Element => (element.type as (props: unknown) => Element)(element.props)

function render(
  activity: AcpActivityView,
  locale: typeof en | typeof zh = en,
  translate: (key: AcpLocaleKey) => string = (key) => locale[key],
) {
  const disclosure = { expanded: true, toggle: vi.fn(), setExpanded: vi.fn() }
  const useDisclosure = vi.fn(() => disclosure)
  const renderFactorySlot = vi.fn(() => 'native-tool')
  const owner = { node: { kind: 'assistant-step', key: 'same-tool', data: {} }, useDisclosure, renderFactorySlot }
  const outer = invoke(renderNativeActivityTool(owner as never, activity, translate) as Element)
  const card = outer.props.children as Element
  const shared = invoke(card)
  const children = shared.props.children as unknown[]
  return { outer, card, shown: children[0] as Element, disclosure, useDisclosure, renderFactorySlot }
}

describe('Host-proven deferred wait presentation', () => {
  it.each([en, zh])('uses a neutral native disclosure while preserving the failed tool result', (locale) => {
    const before = row.rawDetail
    const rendered = render(row, locale)
    expect(rendered.renderFactorySlot).not.toHaveBeenCalled()
    expect(rendered.useDisclosure).toHaveBeenCalledTimes(1)
    expect(rendered.shown.type).toBe(DisclosureRow)
    expect(rendered.shown.props).toMatchObject({
      title: locale['activity.control.waitTitle'],
      open: true,
      onToggle: rendered.disclosure.toggle,
      expandable: true,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
    })
    const icon = rendered.shown.props.icon as Element
    expect(icon.type).toBe(StateDot)
    expect(icon.props.state).toBe('idle')
    expect(JSON.stringify(rendered.shown.props.collapsedContent)).toContain(locale['activity.control.notExecuted'])
    const body = rendered.shown.props.children as Element
    expect(body.props).toHaveProperty('data-acp-host-control', 'deferred-team-message')
    const contents = (Array.isArray(body.props.children) ? body.props.children : [body.props.children]) as Element[]
    expect(contents[0]!.props.children).toBe(locale['activity.control.teamReplyQueued'])
    expect(contents).toHaveLength(1)
    expect(JSON.stringify(contents)).not.toMatch(
      /DSH_WAIT_|End this ACP|structuredContent|opaque-host-receipt|timedOut/,
    )
    expect(nativeActivityToolBlock(row, undefined, undefined, (key) => locale[key])).toMatchObject({ isError: true })
    expect(row.status).toBe('failed')
    expect(row.rawDetail).toBe(before)
  })

  it('refreshes human copy when the native locale changes with a stable bound translator', () => {
    // DSH locale.bind() is stable. Reproduce React memo dependencies rather
    // than letting the element-tree stub recompute every memo on each call.
    const cached: { dependencies: readonly unknown[] | undefined; value: unknown }[] = []
    let cursor = 0
    const memo = vi
      .spyOn(React, 'useMemo')
      .mockImplementation(<T>(factory: () => T, dependencies: readonly unknown[] | undefined): T => {
        const index = cursor++
        const previous = cached[index]
        if (
          previous &&
          dependencies &&
          previous.dependencies?.length === dependencies.length &&
          dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))
        )
          return previous.value as T
        const value = factory()
        cached[index] = { dependencies, value }
        return value
      })
    let locale: typeof en | typeof zh = en
    const translate = (key: AcpLocaleKey) => locale[key]
    try {
      const english = render(row, en, translate)
      expect(english.shown.props.title).toBe(en['activity.control.waitTitle'])
      locale = zh
      cursor = 0
      const chinese = render(row, zh, translate)
      expect(chinese.shown.props.title).toBe(zh['activity.control.waitTitle'])
      expect(JSON.stringify(chinese.shown.props.collapsedContent)).toContain(zh['activity.control.notExecuted'])
      expect(JSON.stringify(chinese.shown.props.children)).toContain(zh['activity.control.teamReplyQueued'])
      expect(chinese.card.type).toBe(english.card.type)
      expect(chinese.shown.props.open).toBe(true)
      expect(row.status).toBe('failed')
    } finally {
      memo.mockRestore()
    }
  })

  it.each([
    { label: 'missing Host proof', data: { ...detail, hostControlOutcome: undefined } },
    { label: 'other session', data: { ...detail, hostControlOutcome: { ...proof, dshSessionId: 'other' } } },
    { label: 'other call', data: { ...detail, hostControlOutcome: { ...proof, toolCallId: 'other' } } },
    { label: 'other tool', data: { ...detail, toolName: 'send_message' } },
    { label: 'executed operation', data: { ...detail, hostControlOutcome: { ...proof, executed: true } } },
    { label: 'other source', data: { ...detail, hostControlOutcome: { ...proof, source: 'agent' } } },
    { label: 'other control kind', data: { ...detail, hostControlOutcome: { ...proof, kind: 'success' } } },
    { label: 'marker text alone', data: { toolName: 'wait_agent', rawOutput: originalOutput } },
    {
      label: 'concurrent provider diagnostic',
      data: { ...detail, content: [{ type: 'content', content: { type: 'text', text: 'A later real failure' } }] },
    },
    {
      label: 'concurrent provider resource',
      data: { ...detail, content: [{ type: 'terminal', terminalId: 'terminal-1' }] },
    },
    {
      label: 'provider metadata alone',
      data: { ...detail, hostControlOutcome: undefined, rawOutput: { ...detail.rawOutput, hostControlOutcome: proof } },
    },
  ])('keeps the native error card for $label', ({ data }) => {
    const activity = { ...row, rawDetail: JSON.stringify(data) }
    const rendered = render(activity)
    expect(rendered.renderFactorySlot).toHaveBeenCalledTimes(1)
    expect(rendered.shown).toBe('native-tool')
    expect(nativeActivityToolBlock(activity)).toMatchObject({ isError: true })
  })

  it.each(['running', 'completed', 'cancelled'] as const)(
    'does not replace %s with a deferred wait notice',
    (status) => {
      const rendered = render({ ...row, status })
      expect(rendered.renderFactorySlot).toHaveBeenCalledTimes(1)
      expect(rendered.shown).toBe('native-tool')
    },
  )

  it('retains the unavailable outcome surface for an unfinished activity', () => {
    expect(usesNativeActivityToolProjection({ ...row, status: 'unfinished' })).toBe(false)
  })

  it('keeps the disclosure owner component across running, control outcome and restored history', () => {
    const running = render({ ...row, status: 'running' })
    const deferred = render(row)
    const restored = render(JSON.parse(JSON.stringify(row)) as AcpActivityView)
    expect(running.outer.type).toBe(deferred.outer.type)
    expect(running.card.type).toBe(deferred.card.type)
    expect(deferred.card.type).toBe(restored.card.type)
    expect(deferred.shown.type).toBe(DisclosureRow)
    expect(deferred.shown.props.open).toBe(true)
    expect(restored.shown.props.open).toBe(true)
    expect(restored.renderFactorySlot).not.toHaveBeenCalled()
  })
})
