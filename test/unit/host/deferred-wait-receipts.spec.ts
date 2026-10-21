import { describe, expect, it } from 'vitest'
import {
  DeferredWaitReceipts,
  DEFERRED_WAIT_META,
  DEFERRED_WAIT_TEXT,
} from '../../../src/host/tools/deferred-wait-receipts.ts'

const envelope = (meta: unknown) => ({
  result: { content: [{ type: 'text', text: DEFERRED_WAIT_TEXT }], structuredContent: null, _meta: meta },
  error: null,
})

describe('Host deferred-wait receipts', () => {
  it('binds one actual reply to one activity and keeps repeated snapshots stable', () => {
    const receipts = new DeferredWaitReceipts('owner')
    const meta = receipts.issue()
    expect(meta?.[DEFERRED_WAIT_META]).toBeTruthy()
    receipts.observe('call-a', envelope(meta))
    expect(receipts.outcome('call-a')).toEqual({
      source: 'dsh-tool-bridge',
      kind: 'deferred-team-message',
      dshSessionId: 'owner',
      toolCallId: 'call-a',
      tool: 'wait_agent',
      executed: false,
    })
    receipts.observe('call-a', envelope(meta))
    expect(receipts.outcome('call-a')).toBeDefined()
    receipts.observe('call-b', envelope(meta))
    expect(receipts.outcome('call-b')).toBeUndefined()
    expect(receipts.outcome('call-a')).toBeDefined()
  })

  it('does not reuse revoked receipts or let one activity adopt another reply', () => {
    const receipts = new DeferredWaitReceipts('owner')
    const first = receipts.issue(),
      second = receipts.issue()
    receipts.observe('a', envelope(first))
    receipts.revoke('a')
    receipts.observe('b', envelope(first))
    expect(receipts.outcome('b')).toBeUndefined()
    receipts.observe('a', envelope(second))
    expect(receipts.outcome('a')).toBeUndefined()
    receipts.observe('b', envelope(second))
    expect(receipts.outcome('b')).toBeDefined()
  })

  it('isolates prompts and bridge instances and degrades safely on capacity exhaustion', () => {
    const receipts = new DeferredWaitReceipts('owner', 1)
    const meta = receipts.issue()
    const other = new DeferredWaitReceipts('owner')
    other.observe('a', envelope(meta))
    expect(other.outcome('a')).toBeUndefined()
    expect(receipts.issue()).toBeUndefined()
    receipts.observe('a', envelope(meta))
    receipts.clear()
    expect(receipts.outcome('a')).toBeUndefined()
    receipts.observe('b', envelope(meta))
    expect(receipts.outcome('b')).toBeUndefined()
    expect(receipts.issue()).toBeDefined()
  })

  it.each([
    ['marker alone', () => ({ result: { content: [{ type: 'text', text: DEFERRED_WAIT_TEXT }] }, error: null })],
    ['unknown receipt', () => envelope({ [DEFERRED_WAIT_META]: 'forged' })],
    ['meaningful error', (x: ReturnType<typeof envelope>) => ({ ...x, error: 'real failure' })],
    ['extra outer data', (x: ReturnType<typeof envelope>) => ({ ...x, extra: 'diagnostic' })],
    ['extra inner data', (x: ReturnType<typeof envelope>) => ({ ...x, result: { ...x.result, extra: 1 } })],
    [
      'structured data',
      (x: ReturnType<typeof envelope>) => ({ ...x, result: { ...x.result, structuredContent: { result: 'failed' } } }),
    ],
    [
      'successful protocol result',
      (x: ReturnType<typeof envelope>) => ({ ...x, result: { ...x.result, isError: false } }),
    ],
    [
      'extra metadata',
      (x: ReturnType<typeof envelope>) => ({
        ...x,
        result: { ...x.result, _meta: { ...(x.result._meta as object), other: 1 } },
      }),
    ],
    [
      'different message',
      (x: ReturnType<typeof envelope>) => ({
        ...x,
        result: { ...x.result, content: [{ type: 'text', text: 'real failure' }] },
      }),
    ],
    [
      'additional failure',
      (x: ReturnType<typeof envelope>) => ({
        ...x,
        result: { ...x.result, content: [...x.result.content, { type: 'text', text: 'real failure' }] },
      }),
    ],
  ] as const)('does not accept %s, and drops an earlier enhanced presentation', (_name, mutate) => {
    const receipts = new DeferredWaitReceipts('owner')
    const value = envelope(receipts.issue())
    receipts.observe('a', value)
    expect(receipts.outcome('a')).toBeDefined()
    receipts.observe('a', mutate(value))
    expect(receipts.outcome('a')).toBeUndefined()
  })
})
