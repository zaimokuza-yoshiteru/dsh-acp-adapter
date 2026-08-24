// tool-presentation.spec.ts — 稳定 tool 名 + 版本化有界展示信封
// （src/protocol/v1/tool-presentation.ts）的单元钉版 + 经 TurnTranslator 的
// 端到端落盘形态（`tool/result` meta.acpToolPresentation）。
//
// 黑盒纪律同 translate.spec：常量按文档字面值断言（不只引用导出符号）；
// 信封经公开 sink 事件断言，不触私有实现。

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { SessionEvent, SessionEventMap, SessionEventType, SurfaceEventType, SurfaceIntent } from '@deepseek-ai/dsh-session'
import { TurnTranslator, acpUnknownToolName } from '../../../src/protocol/v1/translate.ts'
import type { SessionEventSink, TurnTranslatorOptions } from '../../../src/protocol/v1/translate.ts'
import {
  ACP_EXTERNAL_TOOL_NAME,
  ACP_TOOL_CONTENT_HASH_HEX_CHARS,
  ACP_TOOL_CONTENT_META_ITEMS_MAX,
  ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS,
  ACP_TOOL_CONTENT_TOTAL_MAX_CHARS,
  ACP_TOOL_INPUT_SUMMARY_MAX_CHARS,
  ACP_TOOL_PRESENTATION_VERSION,
  ACP_TOOL_TITLE_MAX_CHARS,
  acpToolInputSummary,
  acpToolPresentationPreview,
  boundAcpToolPresentationItems,
  boundAcpToolTitle,
  presentationHash16,
} from '../../../src/protocol/v1/tool-presentation.ts'
import type { AcpToolPresentationContentV1 } from '../../../src/protocol/v1/tool-presentation.ts'

const PROVIDER = 'acp-devin'
const MODEL = 'mock-model-a'
const TIME_BASE = 1_700_000_000_000

class RecordingSink implements SessionEventSink {
  readonly events: SessionEvent[] = []

  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
    const intent = (opts as unknown as ReadonlyArray<SurfaceIntent | undefined>)[0]
    const event = {
      type,
      seq: this.events.length,
      time: TIME_BASE + this.events.length,
      data,
      ...(intent?.surfaceOp === undefined ? {} : { surfaceOp: intent.surfaceOp }),
      ...(intent?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: [...intent.sourceEventSeqs] }),
    } as unknown as SessionEvent<T>
    this.events.push(event as SessionEvent)
    return event
  }
}

function makeTranslator(options?: Partial<TurnTranslatorOptions>) {
  const sink = new RecordingSink()
  const translator = new TurnTranslator({ sink, provider: PROVIDER, model: MODEL, ...options })
  return { sink, translator }
}

function feed(updates: SessionUpdate[]): RecordingSink {
  const { sink, translator } = makeTranslator()
  translator.beginTurn(1)
  for (const update of updates) translator.feed({ sessionId: 'test-session', update })
  translator.endTurn()
  return sink
}

/** 第 index 个 tool/result 的信封（未窄化——逐字段断言形状）。 */
function presentationOf(sink: RecordingSink, index: number): Record<string, unknown> {
  const results = sink.events.filter(e => e.type === 'tool/result')
  const result = results[index]
  if (result === undefined || result.type !== 'tool/result') throw new Error('test fixture: no tool/result')
  const meta = result.data.meta as Record<string, unknown> | undefined
  const envelope = meta?.acpToolPresentation
  if (typeof envelope !== 'object' || envelope === null) throw new Error('test fixture: tool/result without acpToolPresentation')
  return envelope as Record<string, unknown>
}

// ---------- 常量钉版（黑盒字面值） ----------

describe('常量钉版', () => {
  it('稳定名 / 版本 / 界限都是契约字面值', () => {
    expect(ACP_EXTERNAL_TOOL_NAME).toBe('dsh_acp_external_tool')
    expect(ACP_TOOL_PRESENTATION_VERSION).toBe(1)
    expect(ACP_TOOL_TITLE_MAX_CHARS).toBe(200)
    expect(ACP_TOOL_INPUT_SUMMARY_MAX_CHARS).toBe(2_000)
 // 信封界限沿用 口径（单一事实源在本模块，translate.ts re-export）
    expect(ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS).toBe(2_000)
    expect(ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS).toBe(2_000)
    expect(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS).toBe(16_000)
    expect(ACP_TOOL_CONTENT_META_ITEMS_MAX).toBe(64)
    expect(ACP_TOOL_CONTENT_HASH_HEX_CHARS).toBe(16)
  })
})

// ---------- 纯函数归一化 ----------

describe('boundAcpToolTitle', () => {
  it('缺席/空白 → undefined；未超界原样；超界截断加省略号', () => {
    expect(boundAcpToolTitle(undefined)).toBeUndefined()
    expect(boundAcpToolTitle('')).toBeUndefined()
    expect(boundAcpToolTitle('Read a.ts')).toBe('Read a.ts')
    const long = 't'.repeat(ACP_TOOL_TITLE_MAX_CHARS + 10)
    expect(boundAcpToolTitle(long)).toBe(`${'t'.repeat(ACP_TOOL_TITLE_MAX_CHARS)}…`)
  })
})

describe('acpToolPresentationPreview', () => {
  it('未超界原样；超界 head+tail 折叠（无内嵌标记，截断事实由返回值表达）', () => {
    expect(acpToolPresentationPreview('short')).toEqual({ text: 'short', truncated: false })
    const original = 'A'.repeat(2_000) + 'M'.repeat(100) + 'C'.repeat(2_000)
    const preview = acpToolPresentationPreview(original)
    expect(preview.truncated).toBe(true)
    expect(preview.text).toBe('A'.repeat(2_000) + 'C'.repeat(2_000))
    expect(preview.text).not.toContain('已截断')
  })
})

describe('acpToolInputSummary', () => {
  it('未超界原样（同一 JSON 值）；超界折 {truncated, originalChars, hash16}（hash 对 canonical JSON 串）', () => {
    const small = { command: 'ls' }
    expect(acpToolInputSummary(small)).toBe(small)
    const big = { payload: 'x'.repeat(ACP_TOOL_INPUT_SUMMARY_MAX_CHARS) }
    const json = JSON.stringify(big)
    const folded = acpToolInputSummary(big)
    expect(folded).toEqual({
      truncated: true,
      originalChars: json.length,
      hash16: createHash('sha256').update(json, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS),
    })
  })
})

describe('boundAcpToolPresentationItems（条数 + 文本总量双闸）', () => {
  const textItem = (text: string): AcpToolPresentationContentV1 => ({ type: 'text', text })

  it('条数闸：超过 64 条时尾部折进注记项（注记占最后一槽，总数恒 ≤ 64）', () => {
    const items = Array.from({ length: 70 }, (_, i) => textItem(`item-${String(i)}`))
    const bounded = boundAcpToolPresentationItems(items)
    expect(bounded.items).toHaveLength(ACP_TOOL_CONTENT_META_ITEMS_MAX)
    expect(bounded.items.at(-1)).toEqual({ type: 'text', text: '[……另有 7 项内容未纳入展示信封……]' })
    expect(bounded.truncated).toBe(true)
    expect(bounded.omitted).toBe(7)
  })

  it('总量闸：超界项就地截断标记，预算耗尽的后续项折进注记', () => {
    const items = [
      textItem('A'.repeat(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS - 10)),
      textItem('B'.repeat(100)),
      textItem('C'.repeat(100)),
    ]
    const bounded = boundAcpToolPresentationItems(items)
    expect(bounded.items).toHaveLength(3)
    expect(bounded.items[0]).toEqual({ type: 'text', text: 'A'.repeat(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS - 10) })
    // 第二项只剩 10 字符预算 → 就地截断 + truncated 标记
    expect(bounded.items[1]).toEqual({ type: 'text', text: 'B'.repeat(10), truncated: true })
    // 第三项预算耗尽 → 注记
    expect(bounded.items[2]).toEqual({ type: 'text', text: '[……另有 1 项内容未纳入展示信封……]' })
    expect(bounded.truncated).toBe(true)
  })

  it('有界内原样通过；image 项不占文本预算', () => {
    const items: AcpToolPresentationContentV1[] = [
      textItem('ok'),
      { type: 'image', ref: 'sha256:abc', mimeType: 'image/png', size: 10 },
    ]
    const bounded = boundAcpToolPresentationItems(items)
    expect(bounded.items).toEqual(items)
    expect(bounded.truncated).toBe(false)
    expect(bounded.omitted).toBe(0)
  })
})

describe('presentationHash16', () => {
  it('sha256 前 16 hex（展示用，与对账 digest 的 acpCanonicalHash16 不同源）', () => {
    expect(presentationHash16('payload')).toBe(
      createHash('sha256').update('payload', 'utf8').digest('hex').slice(0, 16),
    )
  })
})

// ---------- 端到端：tool/result meta.acpToolPresentation ----------

describe('信封落盘（TurnTranslator → tool/result meta）', () => {
  it('Codex runtime：只投影 namespaced collaboration/subagent 元数据，不伪造 DSH subagent 事件', () => {
    const { sink, translator } = makeTranslator({ runtime: 'codex' })
    translator.beginTurn(1)
    translator.feed({ sessionId: 'test-session', update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'spawn-1',
      title: 'spawnAgent',
      kind: 'other',
      rawInput: { prompt: 'work', secretVendorField: 'not-projected' },
      _meta: {
        codex: {
          collaboration: {
            tool: 'spawnAgent',
            senderThreadId: 'parent-thread',
            receiverThreadIds: ['child-thread'],
            unknown: 'not-projected',
          },
        },
        vendorSecret: 'not-projected',
      },
    } as unknown as SessionUpdate })
    translator.feed({ sessionId: 'test-session', update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'spawn-1',
      status: 'completed',
      _meta: {
        codex: {
          collaboration: {
            tool: 'spawnAgent',
            senderThreadId: 'parent-thread',
            receiverThreadIds: ['child-thread'],
          },
        },
      },
    } as unknown as SessionUpdate })
    translator.endTurn()
    expect(presentationOf(sink, 0).agentExtension).toEqual({
      runtime: 'codex',
      type: 'collaboration',
      tool: 'spawnAgent',
      senderThreadId: 'parent-thread',
      receiverThreadIds: ['child-thread'],
    })
    const json = JSON.stringify(presentationOf(sink, 0).agentExtension)
    expect(json).not.toContain('vendorSecret')
    expect(json).not.toContain('unknown')
    expect(sink.events.some((event) => event.type.startsWith('subagent/'))).toBe(false)
  })

  it('非 Codex runtime：相同私有 _meta 不进入展示信封', () => {
    const { sink, translator } = makeTranslator({ runtime: 'claude' })
    translator.beginTurn(1)
    translator.feed({ sessionId: 'test-session', update: {
      sessionUpdate: 'tool_call', toolCallId: 'tc-meta', title: 'Tool',
      _meta: { codex: { subagent: { threadId: 'child', path: '/agents/worker', activity: 'started' } } },
    } as unknown as SessionUpdate })
    translator.feed({ sessionId: 'test-session', update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-meta', status: 'completed',
    } as unknown as SessionUpdate })
    translator.endTurn()
    expect(presentationOf(sink, 0)).not.toHaveProperty('agentExtension')
  })

  it('completed：title/kind/locations/inputSummary/content 全量；name 恒稳定名', () => {
    const sink = feed([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read README.md',
        kind: 'read',
        locations: [{ path: '/repo/README.md', line: 3 }],
        rawInput: { path: 'README.md' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '# readme' } }],
      },
    ])
    const call = sink.events.find(e => e.type === 'tool/call')
    expect(call?.type).toBe('tool/call')
    if (call?.type === 'tool/call') expect(call.data.name).toBe('dsh_acp_external_tool')
    expect(presentationOf(sink, 0)).toEqual({
      version: 1,
      title: 'Read README.md',
      kind: 'read',
      status: 'completed',
      locations: [{ path: '/repo/README.md', line: 3 }],
      inputSummary: { path: 'README.md' },
      content: [{ type: 'text', text: '# readme' }],
    })
  })

  it('failed：status=failed；title 全程缺席 → 回退 acpUnknownToolName(callId)', () => {
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-fail' } as unknown as SessionUpdate,
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-fail', status: 'failed' },
    ])
    expect(presentationOf(sink, 0)).toEqual({
      version: 1,
      title: acpUnknownToolName('tc-fail'),
      status: 'failed',
      content: [],
    })
  })

  it('title latest-wins：进行中 update 的终态标题覆盖占位首帧标题', () => {
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-lw', title: 'Preparing file…', kind: 'edit' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-lw', status: 'in_progress', title: 'Write /repo/a.txt' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-lw', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] },
    ])
    const envelope = presentationOf(sink, 0)
    expect(envelope.title).toBe('Write /repo/a.txt')
    expect(envelope.kind).toBe('edit')
  })

  it('diff 项：patch 是 newText 有界预览 + operation/行数；oldText 不进信封', () => {
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-diff', title: 'Edit' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-diff',
        status: 'completed',
        content: [{ type: 'diff', path: '/src/a.ts', oldText: 'old line\nsecond', newText: 'new line' }],
      },
    ])
    const envelope = presentationOf(sink, 0)
    expect(envelope.content).toEqual([
      {
        type: 'diff',
        path: '/src/a.ts',
        operation: '修改',
        linesAdded: 1,
        linesRemoved: 2,
        patch: 'new line',
        originalChars: 8,
      },
    ])
    expect(JSON.stringify(envelope)).not.toContain('old line')
  })

  it('image 项：只留 ref（sha256:<hash16>）+ mime/size/hash 元数据，wire 字节不进信封', () => {
    const data = 'aGVsbG8='
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-img', title: 'Shot' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-img',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data, mimeType: 'image/png' } }],
      },
    ])
    const hash16 = createHash('sha256').update(data, 'utf8').digest('hex').slice(0, 16)
    const envelope = presentationOf(sink, 0)
    expect(envelope.content).toEqual([
      { type: 'image', ref: `sha256:${hash16}`, mimeType: 'image/png', size: data.length, hash16 },
    ])
    expect(JSON.stringify(envelope)).not.toContain(data)
  })

  it('image 带 uri → ref 取 uri；audio/未知类型折叠为 text 占位项', () => {
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-mix', title: 'Mix' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-mix',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'image', data: 'aGk=', mimeType: 'image/png', uri: 'file:///shot.png' } },
          { type: 'content', content: { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' } },
          { type: 'hologram', payload: 'volumetric' } as unknown as ToolCallContent,
        ],
      },
    ])
    const content = presentationOf(sink, 0).content as { type: string }[]
    expect(content[0]).toMatchObject({ type: 'image', ref: 'file:///shot.png' })
    expect(content[1]?.type).toBe('text')
    expect((content[1] as unknown as { text: string }).text).toContain('[音频占位]')
    expect(content[2]?.type).toBe('text')
    expect((content[2] as unknown as { text: string }).text).toContain('[未知内容类型 hologram]')
  })

  it('孤儿终态 update：信封仍落（title 取本帧/fallback），content 来自本帧', () => {
    const sink = feed([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ghost',
        status: 'completed',
        title: 'Ghost title',
        content: [{ type: 'content', content: { type: 'text', text: 'late' } }],
      },
    ])
    const envelope = presentationOf(sink, 0)
    expect(envelope.title).toBe('Ghost title')
    expect(envelope.content).toEqual([{ type: 'text', text: 'late' }])
  })

  it('rawInput 超界 → inputSummary 折叠为截断标记（与 resume 对账折叠同形同界）', () => {
    const sink = feed([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-big',
        title: 'Big',
        rawInput: { payload: 'x'.repeat(ACP_TOOL_INPUT_SUMMARY_MAX_CHARS) },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-big', status: 'completed' },
    ])
    const envelope = presentationOf(sink, 0)
    const summary = envelope.inputSummary as Record<string, unknown>
    expect(summary.truncated).toBe(true)
    expect(typeof summary.originalChars).toBe('number')
    expect(typeof summary.hash16).toBe('string')
  })

  it('content 取最新累积：终态帧无 content 时回退进行中帧的映射（信封同步）', () => {
    const sink = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'tc-stash', title: 'Stash' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-stash',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-stash', status: 'completed' },
    ])
    expect(presentationOf(sink, 0).content).toEqual([{ type: 'text', text: 'partial' }])
  })
})
