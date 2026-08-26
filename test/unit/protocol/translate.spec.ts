// translate.spec.ts — .3t：TurnTranslator（src/protocol/v1/translate.ts）黑盒契约测试。
//
// 契约来源（不读实现、只按规格断言）：
//   - src/protocol/v1/translate.ts 模块 doc + feed 逐分支注释（事件形状、append 纪律、警告码）
// - README.md「执行过程」与翻译器契约（tool result fidelity：
//     每种 ACP content type 在 export 中有事实；未知类型可见占位；降级落 sidecar 审计）
//   - mock 帧形状复刻 test/mock-agent/mock-agent.mjs 的 happy scenario
//     （含 kind/locations/rawOutput/_meta 等冗余字段，验证翻译器不搬运它们）
//
// sink 是记录型假 SessionEventSink：从 0 分配连续 seq，time 用确定性递增值；
// surface 意图（surfaceOp/sourceEventSeqs）按 Session.append 语义贴到事件信封上，
// sourceEventSeqs 数组落盘即拷贝，避免与翻译器内部数组产生别名。
// degradation 是记录型假回调（生产接线落 sidecar degradation kind）。
//
// 发现实现与契约不符时：保留 failing test 并在任务报告中逐条列出，不改实现。

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceEventType,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import {
  ACP_DEGRADATION_ITEMS_MAX,
  ACP_STEP,
  ACP_TOOL_CONTENT_HASH_HEX_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS,
  ACP_TOOL_CONTENT_TOTAL_MAX_CHARS,
  ACP_TOOL_ERROR_CODE,
  ACP_TOOL_ERROR_NAME,
  ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS,
  TRANSLATOR_WARNINGS_RETAINED_MAX,
  ReplayTranslator,
  TurnTranslator,
  acpUnknownToolName,
  type AcpToolResultMeta,
  type SessionEventSink,
  type TurnTranslatorOptions,
} from '../../../src/protocol/v1/translate.ts'
import { ACP_EXTERNAL_TOOL_NAME } from '../../../src/protocol/v1/tool-presentation.ts'
import {
  expectedVisibleHistory,
  reconcileVisibleHistory,
  replayVisibleHistory,
} from '../../../src/domain/session/resume.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AcpDegradationAuditData } from '../../../src/domain/policy/events.ts'

const PROVIDER = 'acp-devin'
const MODEL = 'mock-model-a'
const TIME_BASE = 1_700_000_000_000

// ---------- 记录型假 sink ----------

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

// ---------- helpers ----------

function makeTranslator(options?: Partial<TurnTranslatorOptions>) {
  const sink = new RecordingSink()
  const translator = new TurnTranslator({ sink, provider: PROVIDER, model: MODEL, ...options })
  return { sink, translator }
}

/** 带记录型 degradation 回调的翻译器（生产接线 = sidecar degradation kind）。 */
function makeTranslatorWithDegradation() {
  const degradations: AcpDegradationAuditData[] = []
  const { sink, translator } = makeTranslator({ degradation: entry => { degradations.push(entry) } })
  return { sink, translator, degradations }
}

/** 第 index 个 tool/result 的 tool-result 块内各内容块的文本（非 text 块以 `<type>` 代替）。 */
function toolResultTexts(events: readonly SessionEvent[], index: number): string[] {
  const result = at(ofType(events, 'tool/result'), index)
  const block = result.data.message.content[0]
  if (block?.type !== 'tool-result') throw new Error('test fixture: tool/result without a tool-result block')
  return block.content.map(b => (b.type === 'text' ? b.text : `<${b.type}>`))
}

/** 第 index 个 tool/result 的 meta（按 {@link AcpToolResultMeta} 形状窄化；缺席 → undefined）。 */
function toolResultMeta(events: readonly SessionEvent[], index: number): AcpToolResultMeta | undefined {
  const result = at(ofType(events, 'tool/result'), index)
  return result.data.meta as AcpToolResultMeta | undefined
}

function notification(update: SessionUpdate): SessionNotification {
  return { sessionId: 'test-session', update }
}

function messageChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId === undefined ? {} : { messageId }),
  }
}

function thoughtChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
    ...(messageId === undefined ? {} : { messageId }),
  }
}

function ofType<T extends SessionEventType>(events: readonly SessionEvent[], type: T): SessionEvent<T>[] {
  return events.filter(e => e.type === type) as SessionEvent<T>[]
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`test fixture: no element at index ${index}`)
  return item
}

function typeNames(events: readonly SessionEvent[]): SessionEventType[] {
  return events.map(e => e.type)
}

function warningCodes(translator: TurnTranslator): string[] {
  return translator.warnings.map(w => w.code)
}

// ---------- 共享 fixtures ----------

// 复刻 mock-agent.mjs happyTurnUpdates：字段逐一对应（rawOutput 等翻译器应忽略的字段；
// kind/locations 不再忽略——摘要落 tool/call 的 meta.acpToolCall）。
const HAPPY_UPDATES: SessionUpdate[] = [
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about the mock request.' }, messageId: 'mock-thought-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'mock-msg-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ', mock' }, messageId: 'mock-msg-1' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world.' }, messageId: 'mock-msg-1' },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'mock-tool-1',
    title: 'Read README.md',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: '/mock/cwd/README.md' }],
    rawInput: { path: 'README.md' },
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'mock-tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '# mock readme' } }],
    rawOutput: { bytes: 13 },
  },
  {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Inspect the request', priority: 'high', status: 'completed' },
      { content: 'Produce a reply', priority: 'medium', status: 'completed' },
      { content: 'Report usage', priority: 'low', status: 'completed' },
    ],
  },
  { sessionUpdate: 'usage_update', used: 1234, size: 1048576 },
]

const HAPPY_PLAN_TEXT =
  'Agent 计划：\n- [completed] Inspect the request\n- [completed] Produce a reply\n- [completed] Report usage'

const CONFIG_OPT_A: SessionConfigOption = {
  id: 'mode',
  name: 'Session Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'code',
  options: [
    { value: 'code', name: 'Code' },
    { value: 'smart', name: 'Smart' },
  ],
}
const CONFIG_OPT_B: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'mock-model-a',
  options: [{ value: 'mock-model-a', name: 'Mock Model A' }],
}
const SLASH_COMMAND: AvailableCommand = { name: 'review', description: 'Review the current changes' }

function runHappy() {
  const { sink, translator } = makeTranslator()
  const beginEvents = translator.beginTurn(1)
  const perFeed = HAPPY_UPDATES.map(update => translator.feed(notification(update)))
  const endEvents = translator.endTurn()
  return { sink, translator, beginEvents, perFeed, endEvents }
}

// ---------- happy 全序列 ----------

describe('happy 全序列（mock-agent happy scenario 复刻）', () => {
  it('事件类型序列、seq 连续性、逐 feed 返回值与 turn 归属', () => {
    const { sink, translator, beginEvents, perFeed, endEvents } = runHappy()

    // 边界调用本身不发事件（turn/start、turn/end 是 AcpAgent 的职责）
    expect(beginEvents).toEqual([])

    // 每条 session/update 翻译出的事件（feed 返回值契约："the events appended while translating it"）
    expect(perFeed.map(evts => typeNames(evts))).toEqual([
      ['assistant/chunk', 'assistant/chunk'], // thought: block-start + reasoning-delta
      ['assistant/chunk', 'assistant/chunk', 'assistant/chunk'], // thought block-end + text block-start + 'Hello'
      ['assistant/chunk'], // text-delta ', mock'
      ['assistant/chunk'], // text-delta ' world.'
 // tool_call 到达前先 flush 开放文本段（block-end + assistant/message），再落 tool/call
      ['assistant/chunk', 'assistant/message', 'tool/call'],
      ['tool/result'],
      ['assistant/chunk', 'assistant/chunk', 'assistant/chunk'], // plan 三元组（新 segment，step 3）
      ['request/context'],
    ])
    expect(typeNames(endEvents)).toEqual(['assistant/message'])

 // 全量事件类型序列（assistant/message(segment 1) 先于 tool 事件落盘；
    // 尾部 plan 段在 endTurn 收口为第二条 assistant/message）
    expect(typeNames(sink.events)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'request/context',
      'assistant/message',
    ])

    // seq 从 0 连续；time 由 sink 分配
    expect(sink.events.map(e => e.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(sink.events.every(e => typeof e.time === 'number')).toBe(true)

    // feed/endTurn 返回的事件就是 sink 新追加的事件（同值、同序）
    expect(perFeed.flat()).toEqual(sink.events.slice(0, 15))
    expect(endEvents).toEqual([at(sink.events, 15)])

 // 所有 turn 作用域事件归属 turn 1；step 是 presentation step：
    // segment 1（thought+text，seq 0-8）= 1；tool 段（seq 9-10）= 2；plan 段（seq 11-13、15）= 3
    const turnScoped = [
      ...ofType(sink.events, 'assistant/chunk'),
      ...ofType(sink.events, 'assistant/message'),
      ...ofType(sink.events, 'tool/call'),
      ...ofType(sink.events, 'tool/result'),
    ]
    expect(turnScoped).toHaveLength(15)
    for (const e of turnScoped) {
      expect(e.data.turn).toBe(1)
      const expectedStep = e.seq <= 8 ? 1 : e.seq <= 10 ? 2 : 3
      expect(e.data.step).toBe(expectedStep)
    }

    // 全程无异常
    expect(translator.warnings).toEqual([])
    expect(translator.turn).toBe(1)
    expect(translator.inTurn).toBe(false)
  })

 it('assistant/message 聚合：每 segment 一条（content 块顺序、文本聚合、append 意图）； 起不带 usage', () => {
    const { sink } = runHappy()

 // turn 内两条 assistant/message——segment 1（thought+text，tool/call
    // 到达前 flush）与 segment 3（plan 折叠的 reasoning，endTurn 收口）
    const messages = ofType(sink.events, 'assistant/message')
    expect(messages).toHaveLength(2)

    const msg = at(messages, 0)
    expect(msg.surfaceOp).toBe('append')
    // sourceEventSeqs 恰为本 segment 全部 assistant/chunk 的 seq（tool/call、
    // tool/result、request/context 与后续 segment 的 chunk 不在其列）
    expect(msg.sourceEventSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(msg.data.turn).toBe(1)
    expect(msg.data.step).toBe(ACP_STEP) // segment 1 = 每 turn 分配起点
    expect(typeof msg.data.message.id).toBe('string')
    expect(msg.data.message.role).toBe('assistant')
    expect(msg.data.message.source).toEqual({ kind: 'model', provider: PROVIDER, model: MODEL })
    // 块顺序 = 生产顺序：reasoning(thought) → text(聚合消息)
    expect(msg.data.message.content).toEqual([
      { type: 'reasoning', text: 'Thinking about the mock request.' },
      { type: 'text', text: 'Hello, mock world.' },
    ])
 // usage_update 不再合成伪 TokenUsage——message 恒不带 usage 字段
    // （上下文占用走 translator.contextUsage 快照 / live state 通道，见专项套件）
    expect('usage' in msg.data).toBe(false)

    const planMsg = at(messages, 1)
    expect(planMsg.surfaceOp).toBe('append')
    expect(planMsg.sourceEventSeqs).toEqual([11, 12, 13])
    expect(planMsg.data.turn).toBe(1)
    expect(planMsg.data.step).toBe(3)
    expect(planMsg.data.message.content).toEqual([
      { type: 'reasoning', text: HAPPY_PLAN_TEXT },
    ])

    // chunk 流结构抽样：block-start / *-delta / block-end 与块索引
 //（块索引每 segment 从 0 重起——plan 块在新 segment 里重回 index 0）
    const chunks = ofType(sink.events, 'assistant/chunk')
    expect(at(chunks, 0).data.chunk).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(at(chunks, 1).data.chunk).toEqual({ type: 'reasoning-delta', index: 0, text: 'Thinking about the mock request.' })
    expect(at(chunks, 2).data.chunk).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: 'Thinking about the mock request.' },
    })
    expect(at(chunks, 3).data.chunk).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(at(chunks, 4).data.chunk).toEqual({ type: 'text-delta', index: 1, text: 'Hello' })
    expect(at(chunks, 5).data.chunk).toEqual({ type: 'text-delta', index: 1, text: ', mock' })
    expect(at(chunks, 6).data.chunk).toEqual({ type: 'text-delta', index: 1, text: ' world.' })
    expect(at(chunks, 7).data.chunk).toEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'text', text: 'Hello, mock world.' },
    })
    expect(at(chunks, 8).data.chunk).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(at(chunks, 9).data.chunk).toEqual({ type: 'reasoning-delta', index: 0, text: HAPPY_PLAN_TEXT })
    expect(at(chunks, 10).data.chunk).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: HAPPY_PLAN_TEXT },
    })
  })

  it('tool/call、tool/result、request/context 的形状与引用', () => {
    const { sink } = runHappy()

 // tool_call：name 恒为稳定名；title 有界落 meta.acpToolCall.title；
    // arguments 是 rawInput 的 JSON 字符串；status 不搬运；
    // kind/locations 摘要落 meta.acpToolCall（恢复对账的对称事实源）
    const call = at(ofType(sink.events, 'tool/call'), 0)
    expect(call.data).toEqual({
      turn: 1,
      step: 2, // tool 段在文本段（step 1）之后分配
      callId: 'mock-tool-1',
      name: ACP_EXTERNAL_TOOL_NAME,
      arguments: '{"path":"README.md"}',
      meta: { acpToolCall: { title: 'Read README.md', kind: 'read', locations: [{ path: '/mock/cwd/README.md' }] } },
    })
    expect('surfaceOp' in call).toBe(false)
    expect('sourceEventSeqs' in call).toBe(false)

    // tool/result：append + 引用 callSeq；rawOutput 不翻译；无 error 字段
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.surfaceOp).toBe('append')
    expect(result.sourceEventSeqs).toEqual([call.seq])
    expect(result.data.turn).toBe(1)
    expect(result.data.step).toBe(2) // 终态 result 复用配对 call 的 step
    expect('error' in result.data).toBe(false)
    expect(result.data.message.role).toBe('user')
    expect(result.data.message.source).toEqual({ kind: 'tool', callId: 'mock-tool-1' })
    expect(result.data.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'mock-tool-1',
        content: [{ type: 'text', text: '# mock readme' }],
        isError: false,
      },
    ])

    // request/context：{provider, model, contextWindow:size}，log-only
    const context = at(ofType(sink.events, 'request/context'), 0)
    expect(context.data).toEqual({ provider: PROVIDER, model: MODEL, contextWindow: 1048576 })
    expect('surfaceOp' in context).toBe(false)
    expect('sourceEventSeqs' in context).toBe(false)
  })
})

// ---------- messageId 归属与块切换 ----------

describe('messageId 归属与块切换', () => {
  it('(kind, messageId) 任一变更为切换：关旧块开新块', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('A', 'm1')))
    translator.feed(notification(thoughtChunk('T', 't1')))
    translator.feed(notification(messageChunk('B', 'm1')))
    translator.endTurn()

    // 三个块按序开出，索引 0/1/2
    const starts = ofType(sink.events, 'assistant/chunk').filter(e => e.data.chunk.type === 'block-start')
    expect(starts.map(e => e.data.chunk)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'block-start', index: 2, blockType: 'text' },
    ])

    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([
      { type: 'text', text: 'A' },
      { type: 'reasoning', text: 'T' },
      { type: 'text', text: 'B' },
    ])
    // 本 turn 无 usage_update → message 不携带 usage 字段
    expect('usage' in msg.data).toBe(false)
    expect(translator.warnings).toEqual([])
  })

  it('回访旧 messageId 开新块（单开块策略，不续写旧块）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('A', 'm1')))
    translator.feed(notification(messageChunk('B', 'm2')))
    translator.feed(notification(messageChunk('C', 'm1'))) // 回访 m1 → 第三个块而非续写第一块
    translator.endTurn()

    const ends = ofType(sink.events, 'assistant/chunk').filter(e => e.data.chunk.type === 'block-end')
    expect(ends.map(e => e.data.chunk)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'B' } },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'C' } },
    ])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'text', text: 'C' },
    ])
    expect(translator.warnings).toEqual([])
  })

  it('同 messageId 跨 tool 边界分成多个片段，但 append 顺序保持稳定', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('before', 'same')))
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'timeline-tool', title: 'Timeline tool', kind: 'read', status: 'in_progress' }))
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'timeline-tool', status: 'completed' }))
    translator.feed(notification(messageChunk('after', 'same')))
    translator.endTurn()

    const messages = ofType(sink.events, 'assistant/message')
    const tool = at(ofType(sink.events, 'tool/call'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(messages.map((event) => event.data.message.content)).toEqual([
      [{ type: 'text', text: 'before' }],
      [{ type: 'text', text: 'after' }],
    ])
    expect(messages[0]!.seq).toBeLessThan(tool.seq)
    expect(tool.seq).toBeLessThan(result.seq)
    expect(result.seq).toBeLessThan(messages[1]!.seq)
  })

  it('messageId 缺失的匿名 run：同 kind 连续聚合，与具名/异 kind 均构成切换', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('x'))) // 匿名 run 开始
    translator.feed(notification(messageChunk('y'))) // 同匿名 run 聚合
    translator.feed(notification(messageChunk('w', 'm1'))) // 匿名 → 具名：切换
    translator.feed(notification(thoughtChunk('z'))) // 具名 text → 匿名 reasoning：切换
    translator.endTurn()

    const starts = ofType(sink.events, 'assistant/chunk').filter(e => e.data.chunk.type === 'block-start')
    expect(starts.map(e => e.data.chunk)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-start', index: 2, blockType: 'reasoning' },
    ])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([
      { type: 'text', text: 'xy' },
      { type: 'text', text: 'w' },
      { type: 'reasoning', text: 'z' },
    ])
    expect(translator.warnings).toEqual([])
  })
})

// ---------- tool_call / tool_call_update ----------

describe('tool_call / tool_call_update', () => {
  it('tool-call presentation snapshot is a bounded read-only correlation lookup', () => {
    const { translator } = makeTranslator()
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'corr-1', title: 'Read file', kind: 'read', locations: [{ path: '/tmp/a.txt' }], rawInput: { path: '/tmp/a.txt' } }))
    expect(translator.getToolCallPresentationSnapshot('corr-1')).toEqual({
      toolCallId: 'corr-1', title: 'Read file', kind: 'read', locations: [{ path: '/tmp/a.txt' }], inputSummary: { path: '/tmp/a.txt' },
    })
    expect(translator.getToolCallPresentationSnapshot('missing')).toBeUndefined()
  })
 it('tool/call 形状：name 恒稳定名、title 落 meta、不稳定 name 字段不被采纳、rawInput 序列化与缺席回退 {}、kind/locations 落 meta', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Human Title',
      name: 'machine_name_must_be_ignored',
      kind: 'execute',
      locations: [{ path: '/repo/a.txt', line: 3 }, { path: '/repo/b.txt' }],
      rawInput: { command: 'ls -la' },
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'No input call',
    }))

    const calls = ofType(sink.events, 'tool/call')
    expect(calls).toHaveLength(2)
    expect(at(calls, 0).data).toEqual({
      turn: 1,
      step: ACP_STEP, // 本 turn 首个段分配（纯工具 turn 从 1 起）
      callId: 'tc-1',
      name: ACP_EXTERNAL_TOOL_NAME,
      arguments: '{"command":"ls -la"}',
      // title + kind + locations（line 缺席者不带该键）进 meta.acpToolCall；rawInput 不进 meta（已在 arguments）
      meta: { acpToolCall: { title: 'Human Title', kind: 'execute', locations: [{ path: '/repo/a.txt', line: 3 }, { path: '/repo/b.txt' }] } },
    })
    // 仅 title 在场 → meta 只带 title 键（kind/locations 缺席者不带键）
    expect(at(calls, 1).data).toEqual({
      turn: 1,
      step: 2, // 第二个 tool call id 分配到递增的下一个 step
      callId: 'tc-2',
      name: ACP_EXTERNAL_TOOL_NAME,
      arguments: '{}',
      meta: { acpToolCall: { title: 'No input call' } },
    })
    expect(translator.warnings).toEqual([])
  })

  it('tool_call 的 title 缺席/空白：name 仍恒稳定名，meta 不带 title 键；回退标签只用于信封 title 与审批 UX', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-untitled',
    } as unknown as SessionUpdate))
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-blank',
      title: '',
    }))
    const calls = ofType(sink.events, 'tool/call')
    expect(at(calls, 0).data.name).toBe(ACP_EXTERNAL_TOOL_NAME)
    expect(at(calls, 1).data.name).toBe(ACP_EXTERNAL_TOOL_NAME)
    // title 缺席/空白 → 不落 meta（对账两侧同样归 null/空集）
    expect('meta' in at(calls, 0).data).toBe(false)
    expect('meta' in at(calls, 1).data).toBe(false)
    // 回退标签本身有界：超长 callId 截断加省略号
    expect(acpUnknownToolName('x'.repeat(ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS + 10)))
      .toBe(`Agent 工具请求 (${'x'.repeat(ACP_UNKNOWN_TOOL_CALL_ID_MAX_CHARS)}…)`)
  })

  it('failed 终态：isError + error{AcpToolError, ACP_TOOL_FAILED} + sourceEventSeqs 引用', () => {
    // 契约常量值固定（黑盒按文档值断言，不只引用导出符号）
    expect(ACP_TOOL_ERROR_NAME).toBe('AcpToolError')
    expect(ACP_TOOL_ERROR_CODE).toBe('ACP_TOOL_FAILED')
    expect(ACP_STEP).toBe(1)

    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-fail', title: 'Failing call' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-fail',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    }))

    const call = at(ofType(sink.events, 'tool/call'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.surfaceOp).toBe('append')
    expect(result.sourceEventSeqs).toEqual([call.seq])
    expect(result.data.error).toEqual({ name: 'AcpToolError', code: 'ACP_TOOL_FAILED' })
    expect(result.data.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'tc-fail',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      },
    ])
    expect(translator.warnings).toEqual([])
  })

  it('终态 update 无 content 字段时回退到 tool_call 帧 stash 的文本', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-fallback',
      title: 'Call with content',
      content: [{ type: 'content', content: { type: 'text', text: 'stashed text' } }],
    }))
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-fallback', status: 'completed' }))

    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.data.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'tc-fallback',
        content: [{ type: 'text', text: 'stashed text' }],
        isError: false,
      },
    ])
    expect(translator.warnings).toEqual([])
  })

  it('显式 content:null 是空结果（不使用 fallback）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-null',
      title: 'Call with stash',
      content: [{ type: 'content', content: { type: 'text', text: 'stashed' } }],
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-null',
      status: 'completed',
      content: null,
    }))

    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.data.message.content).toEqual([
      { type: 'tool-result', toolCallId: 'tc-null', content: [], isError: false },
    ])
    expect(translator.warnings).toEqual([])
  })

  it('非终态 update（status 缺席 / null / pending / in_progress）不产生事件，随后 completed 正常 resolve', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-pending', title: 'Slow call' }))

    const nonTerminal = [undefined, null, 'pending', 'in_progress'] as const
    for (const status of nonTerminal) {
      const update: SessionUpdate = status === undefined
        ? { sessionUpdate: 'tool_call_update', toolCallId: 'tc-pending' }
        : { sessionUpdate: 'tool_call_update', toolCallId: 'tc-pending', status }
      expect(translator.feed(notification(update))).toEqual([])
    }
    expect(ofType(sink.events, 'tool/result')).toEqual([])

    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-pending',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }))
    const call = at(ofType(sink.events, 'tool/call'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.sourceEventSeqs).toEqual([call.seq])
    expect(translator.warnings).toEqual([])
  })

  it('orphan 终态 update 仍落盘：无 sourceEventSeqs + orphan-tool-result 警告', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    const fed = translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ghost-call',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'late result' } }],
    }))
    expect(typeNames(fed)).toEqual(['tool/result'])

    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.surfaceOp).toBe('append')
    expect('sourceEventSeqs' in result).toBe(false)
    expect(result.data.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'ghost-call',
        content: [{ type: 'text', text: 'late result' }],
        isError: false,
      },
    ])
    expect(warningCodes(translator)).toEqual(['orphan-tool-result'])
    expect(at(translator.warnings, 0).message).toContain('ghost-call')
  })

  it('duplicate-tool-call：第二个同 id tool_call 仍落盘并 supersede stash', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'dup', title: 'First' }))
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'dup', title: 'Second' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'dup',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }))

    const calls = ofType(sink.events, 'tool/call')
    expect(calls).toHaveLength(2)
 // name 恒稳定名；各自的 title 落 meta.acpToolCall.title
    expect(at(calls, 0).data.name).toBe(ACP_EXTERNAL_TOOL_NAME)
    expect(at(calls, 1).data.name).toBe(ACP_EXTERNAL_TOOL_NAME)
    expect((at(calls, 0).data as { meta?: { acpToolCall?: { title?: string } } }).meta?.acpToolCall?.title).toBe('First')
    expect((at(calls, 1).data as { meta?: { acpToolCall?: { title?: string } } }).meta?.acpToolCall?.title).toBe('Second')
    // 结果引用第二个（ superseding）tool/call 的 seq
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.sourceEventSeqs).toEqual([at(calls, 1).seq])
    expect(warningCodes(translator)).toEqual(['duplicate-tool-call'])
    expect(at(translator.warnings, 0).message).toContain('dup')
  })

  it('跨 turn 迟到的终态 update 仍 resolve：结果归属到达时的 turn，引用旧 turn 的 callSeq', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'late', title: 'Late call' }))
    // turn 1 无内容无 usage：endTurn 不合成 assistant/message
    expect(translator.endTurn()).toEqual([])

    translator.beginTurn(2)
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'late',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'late result' } }],
    }))
    translator.endTurn()

    const call = at(ofType(sink.events, 'tool/call'), 0)
    expect(call.data.turn).toBe(1)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.data.turn).toBe(2)
    expect(result.sourceEventSeqs).toEqual([call.seq])
    // 两个 turn 都没有 assistant/message（turn 2 只有 tool/result，不算内容聚合）
    expect(ofType(sink.events, 'assistant/message')).toEqual([])
    expect(translator.warnings).toEqual([])
  })
})

// ---------- 非对称工具回放：终态快照（tool/result meta.acpToolCall.terminal） ----------

describe('非对称工具回放：终态快照回写（claude 0.70.0 占位首帧形态）', () => {
  type TerminalMeta = {
    acpToolCall?: { terminal?: { title?: string; kind?: string; locations?: { path: string; line?: number }[]; input?: unknown } }
    acpToolContent?: { items: { type: string }[]; truncated: boolean; originalItems: number }
  }
  const terminalOf = (events: readonly SessionEvent[], index: number) =>
    (at(ofType(events, 'tool/result'), index).data.meta as TerminalMeta | undefined)?.acpToolCall?.terminal

  it('占位首帧 + 进行中 update 全量事实 + 终态帧仅 status/rawOutput → 终态快照随 tool/result 落盘，content 取最新累积', () => {
    // claude-agent-acp 0.70.0 live 实证形态（Claude ACP 真机验收）：
    // tool_call 首帧 title='Preparing file…'、rawInput 缺席、locations 空、无 content；
    // 进行中 update 帧携带终态 title/rawInput/locations/content=[diff]；终态帧只有
    // status+rawOutput（rawOutput 既定不翻译）。
    const { sink, translator, degradations } = makeTranslatorWithDegradation()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-claude',
      title: 'Preparing file…',
      kind: 'edit',
      status: 'pending',
      locations: [],
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-claude',
      status: 'in_progress',
      title: 'Write /repo/fix-round.txt',
      locations: [{ path: '/repo/fix-round.txt' }],
      rawInput: { file_path: '/repo/fix-round.txt', content: 'resumed-ok' },
      content: [{ type: 'diff', path: '/repo/fix-round.txt', oldText: null, newText: 'resumed-ok' }],
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-claude',
      status: 'completed',
      rawOutput: 'File created successfully at: /repo/fix-round.txt',
    }))
    translator.endTurn()

 // tool/call 落盘即不可变：仍是占位首帧事实（name 恒稳定名，
    // 占位标题落 meta.acpToolCall.title；arguments='{}'）
    const call = at(ofType(sink.events, 'tool/call'), 0)
    expect(call.data.name).toBe(ACP_EXTERNAL_TOOL_NAME)
    expect((call.data as { meta?: { acpToolCall?: { title?: string } } }).meta?.acpToolCall?.title).toBe('Preparing file…')
    expect(call.data.arguments).toBe('{}')

    // 终态快照：title/kind/locations/input 都是终态事实（latest-wins）
    expect(terminalOf(sink.events, 0)).toEqual({
      title: 'Write /repo/fix-round.txt',
      kind: 'edit',
      locations: [{ path: '/repo/fix-round.txt' }],
      input: { file_path: '/repo/fix-round.txt', content: 'resumed-ok' },
    })

    // 终态帧无 content → 回退到最新累积（进行中帧的 [diff]），不再落空 content：
    // diff 摘要块落盘 + acpToolContent meta 与终态快照键共存 + degradation 恰一条
    const texts = toolResultTexts(sink.events, 0)
    expect(texts).toHaveLength(1)
    expect(at(texts, 0)).toContain('[diff 摘要] /repo/fix-round.txt（新建）：+1/−0 行')
    const meta = at(ofType(sink.events, 'tool/result'), 0).data.meta as TerminalMeta
    expect(meta.acpToolContent?.items).toEqual([
      { type: 'diff', path: '/repo/fix-round.txt', operation: '新建', linesAdded: 1, linesRemoved: 0, originalChars: 10, hash16: '62dab328f8d89f9f' },
    ])
    expect(degradations).toHaveLength(1)
    expect(degradations[0]?.code).toBe('unsupported-tool-content')
    // rawOutput 维持不翻译的既定口径：整块事件 JSON 不含其文本
    expect(JSON.stringify(at(ofType(sink.events, 'tool/result'), 0))).not.toContain('File created successfully')
    expect(translator.warnings.map((w) => w.code)).toEqual(['unsupported-tool-content'])
  })

  it('latest-wins：多个 update 帧逐字段覆盖（后帧赢；null/缺席不覆盖）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-lw', title: 'Placeholder', kind: 'read' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-lw',
      status: 'in_progress',
      title: 'First real title',
      rawInput: { path: 'a.txt' },
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-lw',
      status: 'in_progress',
      title: 'Second real title',
      locations: [{ path: '/repo/a.txt', line: 7 }],
      rawInput: { path: 'b.txt' },
    }))
    // patch 语义：null = 不变（title:null 不覆盖 Second real title）
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-lw',
      status: 'completed',
      title: null,
      locations: null,
      rawInput: null,
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }))
    translator.endTurn()

    expect(terminalOf(sink.events, 0)).toEqual({
      title: 'Second real title',
      kind: 'read',
      locations: [{ path: '/repo/a.txt', line: 7 }],
      input: { path: 'b.txt' },
    })
    expect(translator.warnings).toEqual([])
  })

  it('首帧即全量（Devin 形态：update 只带 status/content）→ 不落终态快照键，日志形状与既往一致', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-devin',
      title: 'Read README.md',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/repo/README.md' }],
      rawInput: { path: 'README.md' },
    }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-devin',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '# readme' } }],
      rawOutput: { bytes: 8 },
    }))
    translator.endTurn()

    const result = at(ofType(sink.events, 'tool/result'), 0)
 // 纯文本结果 + 无 update 身份事实 → 无 acpToolContent/终态快照键（前
 // 形状在内容键上逐字节一致）； meta 恒带且仅带展示信封键
    expect(Object.keys(result.data.meta ?? {})).toEqual(['acpToolPresentation'])
    expect(translator.warnings).toEqual([])
  })

  it('孤儿终态帧携带事实 → 终态快照仅含本帧事实（诊断留痕；orphan 警告行为不变）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ghost-facts',
      status: 'completed',
      title: 'Ghost title',
      kind: 'execute',
      content: [{ type: 'content', content: { type: 'text', text: 'late' } }],
    }))
    translator.endTurn()

    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect('sourceEventSeqs' in result).toBe(false)
    expect(terminalOf(sink.events, 0)).toEqual({ title: 'Ghost title', kind: 'execute' })
    expect(warningCodes(translator)).toEqual(['orphan-tool-result'])
  })

  it('占位首帧但 update 帧全程无身份事实 → 不落终态快照（诚实回退：对账按首帧事实，与回放分叉则 fail-closed）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-bare', title: 'Preparing file…' }))
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bare', status: 'in_progress' }))
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bare', status: 'completed' }))
    translator.endTurn()

 // 无身份事实 → 不落终态快照键；meta 仅余 展示信封键
    expect(Object.keys(at(ofType(sink.events, 'tool/result'), 0).data.meta ?? {})).toEqual(['acpToolPresentation'])
    expect(translator.warnings).toEqual([])
  })
})

// ---------- plan 折叠 ----------

describe('plan 折叠', () => {
  it('确定性格式：Agent 计划： 头（agent 侧计划，非 DSH plan-mode）+ "- [<status>] <content>" 行，priority 省略', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'plan',
      entries: [
        { content: 'do a', priority: 'high', status: 'pending' },
        { content: 'do b', priority: 'low', status: 'in_progress' },
        { content: 'do c', priority: 'medium', status: 'completed' },
      ],
    }))
    translator.endTurn()

    const text = 'Agent 计划：\n- [pending] do a\n- [in_progress] do b\n- [completed] do c'
    const chunks = ofType(sink.events, 'assistant/chunk')
    expect(chunks.map(e => e.data.chunk)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    ])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([{ type: 'reasoning', text }])
    expect(translator.warnings).toEqual([])
  })

  it('空 entries 不发事件', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    expect(translator.feed(notification({ sessionUpdate: 'plan', entries: [] }))).toEqual([])
    expect(sink.events).toEqual([])
    // 空 turn 同样不合成 message
    expect(translator.endTurn()).toEqual([])
    expect(translator.warnings).toEqual([])
  })

  it('fold 前先关闭开着的 chunk 块（block-end 先于 plan 的 block-start）', () => {
    const { translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('open text', 'm1')))
    const planEvents = translator.feed(notification({
      sessionUpdate: 'plan',
      entries: [{ content: 'p', priority: 'high', status: 'pending' }],
    }))

    expect(ofType(planEvents, 'assistant/chunk').map(e => e.data.chunk)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'open text' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'Agent 计划：\n- [pending] p' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'Agent 计划：\n- [pending] p' } },
    ])
    translator.endTurn()
    expect(translator.warnings).toEqual([])
  })
})

// ---------- usage_update 与 request/context ----------

describe('usage_update 与 request/context', () => {
  it('{provider, model, contextWindow} 三元组去重；占用记 contextUsage 快照（latest-wins、cost 收窄透传）；不落 usage', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    const first = translator.feed(notification({
      sessionUpdate: 'usage_update',
      used: 100,
      size: 1000,
      cost: { amount: 0.5, currency: 'USD' },
    }))
    expect(typeNames(first)).toEqual(['request/context'])
 // 占用事实进内存快照（live state 通道数据源）；cost 收窄为 amount/currency 透传
    expect(translator.contextUsage).toEqual({ used: 100, size: 1000, percent: 10, cost: { amount: 0.5, currency: 'USD' } })
    // 同三元组重复（used 变化不算）→ 不再发 request/context；快照 latest-wins（无 cost 归 null）
    expect(translator.feed(notification({ sessionUpdate: 'usage_update', used: 200, size: 1000 }))).toEqual([])
    expect(translator.contextUsage).toEqual({ used: 200, size: 1000, percent: 20, cost: null })
    translator.endTurn()

    const contexts = ofType(sink.events, 'request/context')
    expect(contexts).toHaveLength(1)
    // 精确形状：无 cost、无 turn/step
    expect(at(contexts, 0).data).toEqual({ provider: PROVIDER, model: MODEL, contextWindow: 1000 })
 // 只产 usage_update 的 turn 不再合成 assistant/message（不落伪 usage）
    expect(ofType(sink.events, 'assistant/message')).toEqual([])
    expect(translator.warnings).toEqual([])
  })

  it('contextUsage getter：未收到 usage_update 时 undefined（诚实空缺）；size 为 0 时 percent 记 0', () => {
    const { translator } = makeTranslator()
    expect(translator.contextUsage).toBeUndefined()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 5, size: 0 }))
    translator.endTurn()
    expect(translator.contextUsage).toEqual({ used: 5, size: 0, percent: 0, cost: null })
  })

  it('contextWindow(size) 变化触发新的 request/context', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 1, size: 1000 }))
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 2, size: 2000 }))
    translator.endTurn()

    const contexts = ofType(sink.events, 'request/context')
    expect(contexts.map(e => e.data)).toEqual([
      { provider: PROVIDER, model: MODEL, contextWindow: 1000 },
      { provider: PROVIDER, model: MODEL, contextWindow: 2000 },
    ])
  })

  it('去重记忆跨 turn 保持：新 turn 同三元组不发 context；contextUsage 快照跨 turn 存活（latest-wins）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 10, size: 1000 }))
    translator.endTurn()
    // 跨 turn 存活：turn 1 落定的快照在 turn 边界后仍可读
    expect(translator.contextUsage).toEqual({ used: 10, size: 1000, percent: 1, cost: null })

    translator.beginTurn(2)
    expect(translator.feed(notification({ sessionUpdate: 'usage_update', used: 20, size: 1000 }))).toEqual([])
    translator.endTurn()

    expect(ofType(sink.events, 'request/context')).toHaveLength(1)
 // 两个 turn 都只产 usage_update → 均无 assistant/message（不落伪 usage）
    expect(ofType(sink.events, 'assistant/message')).toEqual([])
    // latest-wins：turn 2 的快照覆盖 turn 1
    expect(translator.contextUsage).toEqual({ used: 20, size: 1000, percent: 2, cost: null })
  })

  it('setRoute 本身不发事件；随后 usage_update 以新 route 触发新 context 与 message source', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 10, size: 1000 }))

    const before = sink.events.length
    translator.setRoute({ provider: PROVIDER, model: 'mock-model-b' })
    expect(sink.events).toHaveLength(before)
    expect(translator.route).toEqual({ provider: PROVIDER, model: 'mock-model-b' })

    const fed = translator.feed(notification({ sessionUpdate: 'usage_update', used: 20, size: 1000 }))
    expect(typeNames(fed)).toEqual(['request/context'])
 // usage-only 的 turn 不再合成 message——补一条内容 chunk 让 source 断言有着落
    translator.feed(notification(messageChunk('hi', 'm1')))
    translator.endTurn()

    const contexts = ofType(sink.events, 'request/context')
    expect(contexts.map(e => e.data)).toEqual([
      { provider: PROVIDER, model: MODEL, contextWindow: 1000 },
      { provider: PROVIDER, model: 'mock-model-b', contextWindow: 1000 },
    ])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.source).toEqual({ kind: 'model', provider: PROVIDER, model: 'mock-model-b' })
    expect(translator.warnings).toEqual([])
  })
})

// ---------- 状态槽与忽略的更新 ----------

describe('状态槽与忽略的更新', () => {
  it('config_option_update / current_mode_update / available_commands_update 不产生事件、只更新 getter', () => {
    const { sink, translator } = makeTranslator()
    // 对齐 mock-agent preamble：这些快照在 turn 外到达（session/new 响应前）。
    // turn 外 feed 的通用纪律是记 update-outside-turn 并照常翻译（此处即更新状态槽）。
    expect(translator.feed(notification({ sessionUpdate: 'config_option_update', configOptions: [CONFIG_OPT_A] }))).toEqual([])
    expect(translator.configOptions).toEqual([CONFIG_OPT_A])
    expect(translator.feed(notification({ sessionUpdate: 'config_option_update', configOptions: [CONFIG_OPT_B] }))).toEqual([])
    expect(translator.configOptions).toEqual([CONFIG_OPT_B]) // 全量替换而非合并

    expect(translator.feed(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'smart' }))).toEqual([])
    expect(translator.currentModeId).toBe('smart')
    expect(translator.feed(notification({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' }))).toEqual([])
    expect(translator.currentModeId).toBe('ask')

    expect(translator.feed(notification({ sessionUpdate: 'available_commands_update', availableCommands: [SLASH_COMMAND] }))).toEqual([])
    expect(translator.availableCommands).toEqual([SLASH_COMMAND])

    expect(sink.events).toEqual([])
    expect(warningCodes(translator)).toEqual([
      'update-outside-turn',
      'update-outside-turn',
      'update-outside-turn',
      'update-outside-turn',
      'update-outside-turn',
    ])
  })

  it('构造器 seed 三个状态槽；未 seed 时 getter 为 undefined', () => {
    const sink = new RecordingSink()
    const seeded = new TurnTranslator({
      sink,
      provider: PROVIDER,
      model: MODEL,
      configOptions: [CONFIG_OPT_A],
      currentModeId: 'code',
      availableCommands: [SLASH_COMMAND],
    })
    expect(seeded.configOptions).toEqual([CONFIG_OPT_A])
    expect(seeded.currentModeId).toBe('code')
    expect(seeded.availableCommands).toEqual([SLASH_COMMAND])

    const plain = new TurnTranslator({ sink, provider: PROVIDER, model: MODEL })
    expect(plain.configOptions).toBeUndefined()
    expect(plain.currentModeId).toBeUndefined()
    expect(plain.availableCommands).toBeUndefined()
    expect(sink.events).toEqual([])
  })

  it('session_info_update 忽略：无事件、无状态、无警告', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    expect(translator.feed(notification({ sessionUpdate: 'session_info_update', title: 'A title' }))).toEqual([])
    expect(sink.events).toEqual([])
    expect(translator.warnings).toEqual([])
    translator.endTurn()
  })

  it('plan_update / plan_removed（unstable ACP 扩展）忽略', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    expect(translator.feed(notification({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'p1',
        entries: [{ content: 'x', priority: 'high', status: 'pending' }],
      },
    }))).toEqual([])
    expect(translator.feed(notification({ sessionUpdate: 'plan_removed', planId: 'p1' }))).toEqual([])
    expect(sink.events).toEqual([])
    expect(translator.warnings).toEqual([])
    translator.endTurn()
  })

  it('未知 sessionUpdate 变体忽略 + unknown-session-update 警告（as 断言构造）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    const bogus = {
      sessionUpdate: '_cognition.ai/mcp/serversChanged',
      note: 'vendor extension unknown to this build',
    } as unknown as SessionUpdate
    expect(translator.feed(notification(bogus))).toEqual([])
    expect(sink.events).toEqual([])
    expect(warningCodes(translator)).toEqual(['unknown-session-update'])
    expect(at(translator.warnings, 0).message).toContain('_cognition.ai/mcp/serversChanged')
    translator.endTurn()
  })
})

// ---------- turn 纪律 ----------

describe('turn 纪律', () => {
  it('初始 turn 0 / inTurn false；beginTurn 从 1 编号且无 pending 时返回空', () => {
    const { sink, translator } = makeTranslator()
    expect(translator.turn).toBe(0)
    expect(translator.inTurn).toBe(false)
    expect(translator.warnings).toEqual([])

    expect(translator.beginTurn(1)).toEqual([])
    expect(translator.turn).toBe(1)
    expect(translator.inTurn).toBe(true)

    const fed = translator.feed(notification(messageChunk('hi', 'm1')))
    for (const e of ofType(fed, 'assistant/chunk')) {
      expect(e.data.turn).toBe(1)
      expect(e.data.step).toBe(ACP_STEP)
    }
    translator.endTurn()
    expect(translator.inTurn).toBe(false)
    expect(sink.events.length).toBeGreaterThan(0)
  })

  it('update-outside-turn：记警告仍尽力翻译（turn 0）；beginTurn 隐式 flush 且无 begin-turn-while-active', () => {
    const { translator } = makeTranslator()
    const fed = translator.feed(notification(messageChunk('early', 'm1')))
    expect(typeNames(fed)).toEqual(['assistant/chunk', 'assistant/chunk'])
    for (const e of ofType(fed, 'assistant/chunk')) expect(e.data.turn).toBe(0)
    expect(warningCodes(translator)).toEqual(['update-outside-turn'])
    expect(at(translator.warnings, 0).message).toContain('agent_message_chunk')

    // beginTurn 发现 out-of-turn 聚合的遗留内容 → 按 PREVIOUS turn（0）flush，不记
    // begin-turn-while-active（当时并无活动 turn）
    const flushed = translator.beginTurn(1)
    expect(typeNames(flushed)).toEqual(['assistant/chunk', 'assistant/message'])
    const msg = at(ofType(flushed, 'assistant/message'), 0)
    expect(msg.data.turn).toBe(0)
    expect(msg.data.message.content).toEqual([{ type: 'text', text: 'early' }])
    // 该 turn 的全部 assistant/chunk：block-start(0) + text-delta(1) + flush 时的 block-end(2)
    expect(msg.sourceEventSeqs).toEqual([0, 1, 2])
    expect(warningCodes(translator)).toEqual(['update-outside-turn'])
    expect(translator.turn).toBe(1)
    expect(translator.inTurn).toBe(true)
    translator.endTurn()
  })

  it('beginTurn-while-active：隐式 flush 上一 turn 并记警告', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('x', 'm1')))

    const flushed = translator.beginTurn(2)
    expect(typeNames(flushed)).toEqual(['assistant/chunk', 'assistant/message'])
    const flushedMsg = at(ofType(flushed, 'assistant/message'), 0)
    expect(flushedMsg.data.turn).toBe(1)
    expect(flushedMsg.data.message.content).toEqual([{ type: 'text', text: 'x' }])
    expect(warningCodes(translator)).toEqual(['begin-turn-while-active'])
    expect(translator.turn).toBe(2)
    expect(translator.inTurn).toBe(true)

    translator.feed(notification(messageChunk('y', 'm1')))
    translator.endTurn()
    const messages = ofType(sink.events, 'assistant/message')
    expect(messages).toHaveLength(2)
    expect(at(messages, 1).data.turn).toBe(2)
    expect(at(messages, 1).data.message.content).toEqual([{ type: 'text', text: 'y' }])
    expect(warningCodes(translator)).toEqual(['begin-turn-while-active'])
  })

  it('endTurn 幂等：无活动 turn 记 end-turn-while-inactive 并返回空', () => {
    const { translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('x', 'm1')))

    const first = translator.endTurn()
    expect(typeNames(first)).toEqual(['assistant/chunk', 'assistant/message'])
    expect(translator.warnings).toEqual([])

    expect(translator.endTurn()).toEqual([])
    expect(warningCodes(translator)).toEqual(['end-turn-while-inactive'])
    expect(translator.endTurn()).toEqual([])
    expect(warningCodes(translator)).toEqual(['end-turn-while-inactive', 'end-turn-while-inactive'])
    expect(translator.inTurn).toBe(false)
  })

  it('endTurn 无活动 turn 仍 flush turn 外聚合的内容', () => {
    const { translator } = makeTranslator()
    translator.feed(notification(messageChunk('stray', 'm1'))) // turn 外聚合
    const events = translator.endTurn()
    expect(typeNames(events)).toEqual(['assistant/chunk', 'assistant/message'])
    const msg = at(ofType(events, 'assistant/message'), 0)
    expect(msg.data.turn).toBe(0)
    expect(msg.data.message.content).toEqual([{ type: 'text', text: 'stray' }])
    expect(warningCodes(translator)).toEqual(['update-outside-turn', 'end-turn-while-inactive'])
  })

  it('无内容的 turn 不合成 assistant/message', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    expect(translator.endTurn()).toEqual([])
    expect(sink.events).toEqual([])
    expect(translator.warnings).toEqual([])
  })

 it('只产 usage_update 的 turn 也不合成空 assistant/message（占用走 contextUsage 快照，不落盘）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 50, size: 500 }))
    expect(translator.endTurn()).toEqual([])

    expect(typeNames(sink.events)).toEqual(['request/context'])
    expect(translator.contextUsage).toEqual({ used: 50, size: 500, percent: 10, cost: null })
    expect(translator.warnings).toEqual([])
  })
})

// ---------- append 纪律抽样 ----------

describe('append 纪律抽样', () => {
  it('assistant/chunk、tool/call、request/context 无 surface 元数据；assistant/message、tool/result 带 surfaceOp append', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('hi', 'm1')))
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc', title: 'T' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'r' } }],
    }))
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 1, size: 10 }))
    translator.endTurn()

    expect(typeNames(sink.events)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
 // tool_call 到达前的 segment flush（block-end + assistant/message）
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'request/context',
    ])
    const logOnly = sink.events.filter(
      e => e.type === 'assistant/chunk' || e.type === 'tool/call' || e.type === 'request/context',
    )
    const surfaced = sink.events.filter(e => e.type === 'assistant/message' || e.type === 'tool/result')
    expect(logOnly).toHaveLength(5)
    expect(surfaced).toHaveLength(2)
    for (const e of logOnly) {
      expect('surfaceOp' in e).toBe(false)
      expect('sourceEventSeqs' in e).toBe(false)
    }
    for (const e of surfaced) {
      expect(e.surfaceOp).toBe('append')
    }
    expect(translator.warnings).toEqual([])
  })
})

// ---------- 非文本内容（chunk 有界可见占位；tool result 占位/摘要） ----------

describe('非文本内容（chunk 有界可见占位；tool result 占位/摘要）', () => {
  it('非文本 agent_message_chunk 按有界占位落盘 + unsupported-chunk-content，不污染后续聚合', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    const placed = translator.feed(notification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      messageId: 'm1',
    }))
    const imageHash = createHash('sha256').update('aGVsbG8=', 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
    const placeholder = `[图片占位] image/png，wire 载荷 8 字节（base64），sha256:${imageHash}——v1 无附件 seam，字节不落盘`
    // 占位是独立完整块：block-start/text-delta/block-end 三连
    expect(placed.map(e => (e.data as { chunk: { type: string } }).chunk.type)).toEqual(['block-start', 'text-delta', 'block-end'])
    expect(warningCodes(translator)).toEqual(['unsupported-chunk-content'])
    expect(at(translator.warnings, 0).message).toContain('image')

    // 后续文本 chunk 正常开新块，聚合包含占位块与文本块
    translator.feed(notification(messageChunk('ok', 'm1')))
    translator.endTurn()
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([
      { type: 'text', text: placeholder },
      { type: 'text', text: 'ok' },
    ])
    expect(warningCodes(translator)).toEqual(['unsupported-chunk-content'])
  })

  it('非文本 agent_thought_chunk 按有界占位落盘（reasoning 块） + unsupported-chunk-content', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    const placed = translator.feed(notification({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain', text: 'x' } },
      messageId: 't1',
    }))
    expect(placed.map(e => (e.data as { chunk: { type: string } }).chunk.type)).toEqual(['block-start', 'reasoning-delta', 'block-end'])
    expect(warningCodes(translator)).toEqual(['unsupported-chunk-content'])
    expect(at(translator.warnings, 0).message).toContain('agent_thought_chunk')
    translator.endTurn()
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.message.content).toEqual([{ type: 'reasoning', text: '[资源 file:///x（text/plain）]\nx' }])
  })

  it('tool result 的非文本项按占位/摘要落盘（unsupported-tool-content），文本项保持顺序', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-mixed', title: 'Mixed' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-mixed',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: '/a.ts', newText: 'new' },
        { type: 'terminal', terminalId: 'term-1' },
        { type: 'content', content: { type: 'image', data: 'aA==', mimeType: 'image/png' } },
      ],
    }))

    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.data.message.content).toHaveLength(1)
    const texts = toolResultTexts(sink.events, 0)
    expect(texts).toHaveLength(4)
    expect(at(texts, 0)).toBe('ok')
    expect(at(texts, 1)).toContain('[diff 摘要] /a.ts')
    expect(at(texts, 2)).toContain('[terminal 占位] terminalId=term-1')
    expect(at(texts, 3)).toContain('[图片占位] image/png')
    // 如实口径：占位/摘要落盘而非 dropped
    expect(warningCodes(translator)).toEqual(['unsupported-tool-content'])
    expect(at(translator.warnings, 0).message).toContain('3')
    expect(at(translator.warnings, 0).message).toContain('tc-mixed')
    expect(at(translator.warnings, 0).message).toContain('已按占位/摘要落盘')
  })

  it('fallback（tool_call 帧 content）与终态 update 同源映射：非文本项同样占位落盘', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-fb',
      title: 'Mixed stash',
      content: [
        { type: 'content', content: { type: 'text', text: 'keep' } },
        { type: 'diff', path: '/b.ts', newText: 'n' },
      ],
    }))
    // 终态 update 无 content 字段 → 走 stash；stash 里的 diff 同样按摘要落盘
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-fb', status: 'completed' }))

    const texts = toolResultTexts(sink.events, 0)
    expect(texts).toHaveLength(2)
    expect(at(texts, 0)).toBe('keep')
    expect(at(texts, 1)).toContain('[diff 摘要] /b.ts')
    expect(warningCodes(translator)).toEqual(['unsupported-tool-content'])
    expect(at(translator.warnings, 0).message).toContain('1')
  })
})

// ---------- live/replay 一致性 ----------

describe('live/replay 一致性：同一纯 reducer 对同一事件流跑两遍，输出逐字节相等', () => {
  // live 与重启后回放共享同一个 TurnTranslator 纯状态机（回放期更新在 resume.ts
  // 被抑制，根本不会二次喂入；本套件证明的是翻译映射本身的确定性）：同一 ACP
  // 事件流喂给两个全新翻译器 + 记录型 sink，产出事件流必须逐字节相等——唯一
  // 例外是 message id（dsh-llm createMessage 的 crypto.randomUUID 新鲜身份，
  // 上游原生路径同样如此；落盘后 live 与 reload 读到的是同一份 id）。比对前把
  // UUID 形值归一化，其余字段（类型/seq/turn/step/文本/引用/surface 意图）
  // 全部参与逐字节比对。
  const TURN_TWO: SessionUpdate[] = [
    { sessionUpdate: 'config_option_update', configOptions: [CONFIG_OPT_A] },
    { sessionUpdate: 'current_mode_update', currentModeId: 'smart' },
    { sessionUpdate: 'available_commands_update', availableCommands: [SLASH_COMMAND] },
    { sessionUpdate: 'session_info_update', title: 'ignored title' },
    {
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'p1', entries: [{ content: 'x', priority: 'high', status: 'pending' }] },
    },
    { sessionUpdate: 'plan_removed', planId: 'p1' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'ghost-call', status: 'completed' },
    {
      sessionUpdate: '_vendor/futureThing',
      note: 'vendor extension unknown to this build',
    } as unknown as SessionUpdate,
  ]

  function runStream(): { events: string; warnings: string; counts: string } {
    const { sink, translator } = makeTranslator()
    for (const [index, updates] of [HAPPY_UPDATES, TURN_TWO].entries()) {
      translator.beginTurn(index + 1)
      for (const update of updates) translator.feed(notification(update))
      translator.endTurn()
    }
    const normalizeIds = (text: string): string =>
      text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<fresh-message-id>')
    return {
      events: normalizeIds(JSON.stringify(sink.events)),
      warnings: JSON.stringify(translator.warnings),
      counts: JSON.stringify(translator.warningCounts),
    }
  }

  it('两遍产出（事件流/保留警告/全量计数）逐字节相等，且事件数量符合契约', () => {
    const live = runStream()
    const replay = runStream()
    expect(replay.events).toBe(live.events)
    expect(replay.warnings).toBe(live.warnings)
    expect(replay.counts).toBe(live.counts)
 // 防呆：比对对象不是空流（turn1 16 事件（tool/call 前的 segment flush
    // 多一条 assistant/message）+ turn2 非文本 chunk 占位三连 + 孤儿 tool/result
    // 前的占位段 flush message + 孤儿 tool/result，共 5 事件）
    expect(JSON.parse(live.events)).toHaveLength(21)
    expect(JSON.parse(live.counts)).toEqual({
      'unsupported-chunk-content': 1,
      'orphan-tool-result': 1,
      'unknown-session-update': 1,
    })
  })
})

// ---------- 有界诊断 ----------

describe('有界诊断：warning 保留段封顶，计数/丢弃数构成完整审计摘要', () => {
  it('持续到来的未知更新只留前 TRANSLATOR_WARNINGS_RETAINED_MAX 条样本，其余计数不保留', () => {
    const { translator } = makeTranslator()
    translator.beginTurn(1)
    const total = TRANSLATOR_WARNINGS_RETAINED_MAX + 50
    for (let index = 0; index < total; index += 1) {
      translator.feed(notification({
        sessionUpdate: `_vendor/flood-${String(index)}`,
      } as unknown as SessionUpdate))
    }
    translator.endTurn()

    // 保留段封顶，且保持时间序（首条样本仍是第一条到来者）
    expect(translator.warnings).toHaveLength(TRANSLATOR_WARNINGS_RETAINED_MAX)
    expect(at(translator.warnings, 0).message).toContain('_vendor/flood-0')
    // 审计摘要完整：全量计数 + 丢弃数，二者与保留段互补
    expect(translator.warningCounts['unknown-session-update']).toBe(total)
    expect(translator.droppedWarningCount).toBe(total - TRANSLATOR_WARNINGS_RETAINED_MAX)
    // 翻译全程继续（最后一条也正常返回空事件数组）
    expect(translator.inTurn).toBe(false)
  })

  it('未超上限时 warnings 与 counts 一一对应、dropped 为 0', () => {
    const { translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed' }))
    translator.feed(notification({ sessionUpdate: '_x/unknown' } as unknown as SessionUpdate))
    translator.endTurn()

    expect(warningCodes(translator)).toEqual(['orphan-tool-result', 'unknown-session-update'])
    expect(translator.warningCounts).toEqual({ 'orphan-tool-result': 1, 'unknown-session-update': 1 })
    expect(translator.droppedWarningCount).toBe(0)
  })
})

// ---------- tool result fidelity ----------

describe(' tool result fidelity：每种 ACP content type 在 export 中都有事实，未知类型不静默消失', () => {
  function runToolResult(content: ToolCallContent[] | null, toolCallId = 'tc-m21') {
    const { sink, translator, degradations } = makeTranslatorWithDegradation()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId, title: 'M2.1 call' }))
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content }))
    translator.endTurn()
    const result = at(ofType(sink.events, 'tool/result'), 0)
    const block = result.data.message.content[0]
    if (block?.type !== 'tool-result') throw new Error('test fixture: tool/result without a tool-result block')
    return {
      sink,
      translator,
      degradations,
      result,
      texts: block.content.map(b => (b.type === 'text' ? b.text : `<${b.type}>`)),
      meta: result.data.meta as AcpToolResultMeta | undefined,
    }
  }

 it('text 原样保留：无 acpToolContent meta、无 degradation、无 warning（形状一致）； meta 仅带展示信封键', () => {
    const { translator, degradations, result, texts } = runToolResult([
      { type: 'content', content: { type: 'text', text: 'plain output' } },
    ])
    expect(texts).toEqual(['plain output'])
    expect(Object.keys(result.data.meta ?? {})).toEqual(['acpToolPresentation'])
    expect(degradations).toEqual([])
    expect(translator.warnings).toEqual([])
  })

  it('diff：摘要块（path/操作/+−行数）+ 新内容 preview；结构化事实进 meta（不含完整 patch 字节）', () => {
    const { degradations, texts, meta } = runToolResult([
      { type: 'diff', path: '/src/a.ts', oldText: 'old line\nsecond', newText: 'new line' },
    ])
    expect(texts).toHaveLength(1)
    const summary = at(texts, 0)
    expect(summary).toContain('[diff 摘要] /src/a.ts（修改）：+1/−2 行')
    expect(summary).toContain('新内容预览（原始 8 字符')
    expect(summary).toContain('new line')
    // meta 只有标量事实：path/操作/行数/原始长度——完整 patch 字节不进 meta
    expect(meta?.acpToolContent.truncated).toBe(false)
    expect(meta?.acpToolContent.originalItems).toBe(1)
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'diff',
      path: '/src/a.ts',
      operation: '修改',
      linesAdded: 1,
      linesRemoved: 2,
      originalChars: 8,
      hash16: '42b2829d7d41d79a',
    })
    // 降级审计恰一条：摘要落盘 = 降级（完整 patch 字节不入日志）
    expect(degradations).toHaveLength(1)
    expect(degradations[0]).toMatchObject({
      code: 'unsupported-tool-content',
      toolCallId: 'tc-m21',
      truncated: false,
    })
    expect(degradations[0]?.items).toEqual([{ type: 'diff', reason: '摘要落盘（完整 patch 字节不入日志）', originalSize: 8 + 15 }])
  })

  it('diff 操作类型按 oldText/newText 可空推断：新建 / 删除 / 修改', () => {
    for (const [item, operation] of [
      [{ type: 'diff', path: '/n.ts', newText: 'x\n' } as ToolCallContent, '新建'],
      [{ type: 'diff', path: '/d.ts', oldText: 'x\n', newText: '' } as ToolCallContent, '删除'],
      [{ type: 'diff', path: '/m.ts', oldText: 'x\n', newText: 'y\n' } as ToolCallContent, '修改'],
    ] as const) {
      const { texts, meta } = runToolResult([item])
      expect(at(texts, 0)).toContain(`（${operation}）`)
      expect(at(meta?.acpToolContent.items ?? [], 0)).toMatchObject({ operation })
    }
  })

  it('diff 超界 preview：head/tail 截断标记 + 原始长度 + truncated（界限常量钉版）', () => {
    expect(ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS).toBe(2_000)
    expect(ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS).toBe(2_000)
    expect(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS).toBe(16_000)
    expect(ACP_TOOL_CONTENT_HASH_HEX_CHARS).toBe(16)

    const original = 'H'.repeat(2_000) + 'M'.repeat(100) + 'T'.repeat(2_000)
    const { degradations, texts, meta } = runToolResult([
      { type: 'diff', path: '/big.ts', oldText: null, newText: original },
    ])
    const summary = at(texts, 0)
    expect(summary).toContain('[……已截断：原始 4100 字符，仅保留前 2000 / 后 2000 字符……]')
    expect(summary).toContain('H'.repeat(100))
    expect(summary).not.toContain('M'.repeat(100))
    expect(summary).toContain('T'.repeat(100))
    expect(at(meta?.acpToolContent.items ?? [], 0)).toMatchObject({ truncated: true, originalChars: 4_100 })
    expect(meta?.acpToolContent.truncated).toBe(true)
    expect(degradations[0]).toMatchObject({ truncated: true })
    expect(degradations[0]?.items[0]?.reason).toContain('截断')
  })

  it('terminal：占位块（terminalId + 输出不可得原因）+ meta + degradation', () => {
    const { degradations, texts, meta } = runToolResult([{ type: 'terminal', terminalId: 'term-42' }])
    expect(at(texts, 0)).toBe('[terminal 占位] terminalId=term-42：DSH 未广告 terminal 能力，输出不可得')
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'terminal',
      terminalId: 'term-42',
      reason: 'DSH 未广告 terminal 能力，输出不可得',
    })
    expect(degradations[0]?.items).toEqual([
      { type: 'terminal', reason: 'DSH 未广告 terminal 能力，输出不可得' },
    ])
  })

  it('image/audio：占位块（mime + wire 字节数 + sha256-16 + 无附件 seam 原因），字节不落盘', () => {
    const imageData = 'aGVsbG8td29ybGQ='
    const audioData = 'AAECAwQ='
    const { degradations, result, texts, meta } = runToolResult([
      { type: 'content', content: { type: 'image', data: imageData, mimeType: 'image/png', uri: 'file:///shot.png' } },
      { type: 'content', content: { type: 'audio', data: audioData, mimeType: 'audio/wav' } },
    ])
    const imageHash = createHash('sha256').update(imageData, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
    const audioHash = createHash('sha256').update(audioData, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
    expect(at(texts, 0)).toContain(`[图片占位] image/png，wire 载荷 ${String(imageData.length)} 字节（base64），sha256:${imageHash}`)
    expect(at(texts, 1)).toContain(`[音频占位] audio/wav，wire 载荷 ${String(audioData.length)} 字节（base64），sha256:${audioHash}`)
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'image',
      mimeType: 'image/png',
      size: imageData.length,
      hash16: imageHash,
      uri: 'file:///shot.png',
      reason: 'v1 无附件 seam，字节不落盘',
    })
    expect(at(meta?.acpToolContent.items ?? [], 1)).toMatchObject({ type: 'audio', mimeType: 'audio/wav', hash16: audioHash })
    // 字节不落盘：整个 appended 事件的 JSON 序列化不含 base64 载荷
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(imageData)
    expect(serialized).not.toContain(audioData)
    expect(serialized).toContain('[图片占位]')
    expect(degradations).toHaveLength(1)
    expect(degradations[0]?.items.map(item => item.type)).toEqual(['image', 'audio'])
  })

  it('resource(embedded text)：uri 头 + 原文；未超界不算降级（无 acpToolContent meta、无 degradation）', () => {
    const { translator, degradations, result, texts } = runToolResult([
      { type: 'content', content: { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: 'resource body' } } },
    ])
    expect(at(texts, 0)).toBe('[资源 file:///x.txt（text/plain）]\nresource body')
    expect(Object.keys(result.data.meta ?? {})).toEqual(['acpToolPresentation'])
    expect(degradations).toEqual([])
    expect(translator.warnings).toEqual([])
  })

  it('resource(embedded text) 超界：head/tail 截断 + 原始长度 + meta truncated + degradation', () => {
    const original = 'A'.repeat(2_000) + 'B'.repeat(100) + 'C'.repeat(2_000)
    const { degradations, texts, meta } = runToolResult([
      { type: 'content', content: { type: 'resource', resource: { uri: 'file:///big.txt', text: original } } },
    ])
    const block = at(texts, 0)
    expect(block.startsWith('[资源 file:///big.txt]\n' + 'A'.repeat(100))).toBe(true)
    expect(block).toContain('[……已截断：原始 4100 字符，仅保留前 2000 / 后 2000 字符……]')
    expect(block.endsWith('C'.repeat(100))).toBe(true)
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'resource',
      uri: 'file:///big.txt',
      originalChars: 4_100,
      truncated: true,
    })
    expect(degradations[0]?.items).toEqual([
      { type: 'resource', reason: '超界截断（head/tail preview）', originalSize: 4_100 },
    ])
  })

  it('resource(blob)：占位块（uri/mime/wire 字节数/hash16/原因），字节不落盘', () => {
    const blob = 'AAECAwQFBgc='
    const { degradations, result, texts, meta } = runToolResult([
      { type: 'content', content: { type: 'resource', resource: { uri: 'file:///bin.dat', mimeType: 'application/octet-stream', blob } } },
    ])
    const hash = createHash('sha256').update(blob, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
    expect(at(texts, 0)).toContain(`[二进制资源占位] file:///bin.dat（application/octet-stream），wire 载荷 ${String(blob.length)} 字节（base64），sha256:${hash}`)
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'blob',
      uri: 'file:///bin.dat',
      mimeType: 'application/octet-stream',
      size: blob.length,
      hash16: hash,
      reason: 'v1 无附件 seam，字节不落盘',
    })
    expect(JSON.stringify(result)).not.toContain(blob)
    expect(degradations[0]?.items).toEqual([{ type: 'blob', reason: 'v1 无附件 seam，字节不落盘', originalSize: blob.length }])
  })

  it('resource_link：引用元数据（name/title/uri/mimeType/size）全量记录，不算降级', () => {
    const { translator, degradations, result, texts } = runToolResult([
      { type: 'content', content: { type: 'resource_link', name: 'report.pdf', title: '季度报告', uri: 'file:///report.pdf', mimeType: 'application/pdf', size: 12_345 } },
    ])
    expect(at(texts, 0)).toBe('[资源引用] report.pdf（季度报告） → file:///report.pdf（application/pdf，12345 字节）')
    expect(Object.keys(result.data.meta ?? {})).toEqual(['acpToolPresentation'])
    expect(degradations).toEqual([])
    expect(translator.warnings).toEqual([])
  })

  it('未知内容类型：可见占位点名类型 + meta + degradation，绝不静默', () => {
    const { degradations, texts, meta } = runToolResult([
      { type: 'hologram', payload: 'volumetric' } as unknown as ToolCallContent,
    ])
    expect(at(texts, 0)).toBe('[未知内容类型 hologram] 未知内容类型，已按占位记录，原始字段不落盘')
    expect(at(meta?.acpToolContent.items ?? [], 0)).toEqual({
      type: 'unknown',
      acpType: 'hologram',
      reason: '未知内容类型，已按占位记录',
    })
    expect(degradations[0]?.items).toEqual([{ type: 'hologram', reason: '未知内容类型，已按占位记录' }])
  })

  it('合计上限：超界块就地截断并标记，预算耗尽的后续项折叠为一条占位；truncated 置位', () => {
    const { degradations, texts, meta } = runToolResult([
      { type: 'content', content: { type: 'text', text: 'A'.repeat(10_000) } },
      { type: 'content', content: { type: 'text', text: 'B'.repeat(10_000) } },
      { type: 'content', content: { type: 'text', text: 'C'.repeat(10_000) } },
    ])
    expect(texts).toHaveLength(3)
    expect(at(texts, 0)).toBe('A'.repeat(10_000))
    const truncatedBlock = at(texts, 1)
    expect(truncatedBlock.startsWith('B'.repeat(6_000))).toBe(true)
    expect(truncatedBlock).toContain(`[……因单条结果总量上限 ${String(ACP_TOOL_CONTENT_TOTAL_MAX_CHARS)} 字符截断，本块原始 10000 字符……]`)
    expect(at(texts, 2)).toBe('[……另有 1 项内容因总量上限未显示……]')
    expect(meta?.acpToolContent.truncated).toBe(true)
    expect(meta?.acpToolContent.originalItems).toBe(3)
    expect(degradations[0]?.items.some(item => item.reason.includes('总量上限截断'))).toBe(true)
    expect(degradations[0]?.truncated).toBe(true)
  })

  it('degradation 审计封顶：meta items ≤ ACP_TOOL_CONTENT_META_ITEMS_MAX，degradation items ≤ ACP_DEGRADATION_ITEMS_MAX（originalItems 记全量）', () => {
    const items: ToolCallContent[] = Array.from({ length: 70 }, (_, index) => ({ type: 'terminal', terminalId: `term-${String(index)}` }))
    const { degradations, meta } = runToolResult(items)
    expect(meta?.acpToolContent.items).toHaveLength(64)
    expect(meta?.acpToolContent.originalItems).toBe(70)
    expect(degradations).toHaveLength(1)
    expect(degradations[0]?.items).toHaveLength(ACP_DEGRADATION_ITEMS_MAX)
    expect(degradations[0]?.keptPreviewChars).toBeGreaterThan(0)
  })

  it('一次终态 update 的多项降级只记一条审计（不按 item 拆条）；fallback 路径同样记', () => {
    // 终态 update 直接携带内容
    const first = runToolResult([
      { type: 'terminal', terminalId: 't-1' },
      { type: 'content', content: { type: 'image', data: 'aA==', mimeType: 'image/png' } },
    ])
    expect(first.degradations).toHaveLength(1)
    expect(first.degradations[0]?.items).toHaveLength(2)
    expect(warningCodes(first.translator)).toEqual(['unsupported-tool-content'])

    // fallback（tool_call 帧 content）路径
    const { translator, degradations } = makeTranslatorWithDegradation()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-fallback-degraded',
      title: 'stash',
      content: [{ type: 'terminal', terminalId: 't-9' }],
    }))
    expect(degradations).toEqual([]) // tool_call 帧本身不记（未落盘为结果）
    translator.feed(notification({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-fallback-degraded', status: 'completed' }))
    expect(degradations).toHaveLength(1)
    expect(degradations[0]?.toolCallId).toBe('tc-fallback-degraded')
  })

 it('非文本消息 chunk 占位落盘记一条 unsupported-chunk-content 审计（无 toolCallId，事实取自 映射）', () => {
    const { translator, degradations } = makeTranslatorWithDegradation()
    translator.beginTurn(1)
    translator.feed(notification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      messageId: 'm1',
    }))
    const hash = createHash('sha256').update('aGk=', 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
    const placeholder = `[图片占位] image/png，wire 载荷 4 字节（base64），sha256:${hash}——v1 无附件 seam，字节不落盘`
    expect(degradations).toEqual([
      {
        code: 'unsupported-chunk-content',
        items: [{ type: 'image', reason: 'v1 无附件 seam，字节不落盘', originalSize: 4 }],
        keptPreviewChars: placeholder.length,
        truncated: false,
      },
    ])
    expect(warningCodes(translator)).toEqual(['unsupported-chunk-content'])
  })

  it('degradation 回调缺席时行为不变（只留内存 warning）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'tool_call', toolCallId: 'tc-nocb', title: 'T' }))
    translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-nocb',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 't-1' }],
    }))
    expect(toolResultTexts(sink.events, 0)).toEqual(['[terminal 占位] terminalId=t-1：DSH 未广告 terminal 能力，输出不可得'])
    expect(toolResultMeta(sink.events, 0)?.acpToolContent.originalItems).toBe(1)
    expect(warningCodes(translator)).toEqual(['unsupported-tool-content'])
  })
})

// ---------- PresentationSegmenter 验收矩阵（消息展示顺序） ----------

describe(' PresentationSegmenter 验收矩阵（消息展示顺序：正文与 tool 卡片的稳定相对顺序）', () => {
  const toolCallFrame = (id: string, title = 'Tool'): SessionUpdate => ({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title,
  })
  const toolDoneFrame = (id: string, text = 'done'): SessionUpdate => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  })
  const stepsOf = (events: readonly SessionEvent[]): number[] =>
    events.map(e => (e.data as { step?: number }).step ?? -1)

  it('纯文本 turn：单 segment（step 恒 1），endTurn 收口恰好一条 message', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('a', 'm1')))
    translator.feed(notification(messageChunk('b', 'm1')))
    translator.endTurn()

    const messages = ofType(sink.events, 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(stepsOf(sink.events)).toEqual(sink.events.map(() => ACP_STEP))
    expect(messages[0]?.data.message.content).toEqual([{ type: 'text', text: 'ab' }])
    expect(translator.turnProducedOutput).toBe(true)
    expect(translator.warnings).toEqual([])
  })

  it('纯工具 turn：不产 assistant/message；tool 事件 step 1；turnProducedOutput = true（不触发空响应）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(toolCallFrame('t1', 'Read')))
    translator.feed(notification(toolDoneFrame('t1')))
    const endEvents = translator.endTurn()

    expect(endEvents).toEqual([])
    expect(ofType(sink.events, 'assistant/message')).toEqual([])
    const call = at(ofType(sink.events, 'tool/call'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(call.data.step).toBe(ACP_STEP)
    expect(result.data.step).toBe(ACP_STEP)
    expect(result.sourceEventSeqs).toEqual([call.seq])
    expect(translator.turnProducedOutput).toBe(true)
    expect(translator.warnings).toEqual([])
  })

  it('text→tool→text：message1.seq < tool/call.seq < message2.seq 且 step 单调递增（Kimi 排序不跳变的钉版）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('before.', 'm1')))
    translator.feed(notification(toolCallFrame('t1', 'Read')))
    translator.feed(notification(toolDoneFrame('t1', 'body')))
    translator.feed(notification(messageChunk('after.', 'm2')))
    translator.endTurn()

    const messages = ofType(sink.events, 'assistant/message')
    const call = at(ofType(sink.events, 'tool/call'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(messages).toHaveLength(2)
    // 相对顺序钉死：正文段一恒在 tool 卡片上方（settled 锚点不再跳变）
    expect(at(messages, 0).seq).toBeLessThan(call.seq)
    expect(call.seq).toBeLessThan(result.seq)
    expect(result.seq).toBeLessThan(at(messages, 1).seq)
    // step 按到达序单调递增：文本段 1 → tool 段 2 → 文本段 3
    expect(at(messages, 0).data.step).toBe(1)
    expect(call.data.step).toBe(2)
    expect(result.data.step).toBe(2) // 终态复用配对 call 的 step
    expect(at(messages, 1).data.step).toBe(3)
    // 各段只引本段 chunk、各含本段文本（绝不回写已提交消息）
    expect(at(messages, 0).data.message.content).toEqual([{ type: 'text', text: 'before.' }])
    expect(at(messages, 1).data.message.content).toEqual([{ type: 'text', text: 'after.' }])
    const segmentTwoChunks = ofType(sink.events, 'assistant/chunk').filter(e => e.data.step === 3)
    expect(at(messages, 1).sourceEventSeqs).toEqual(segmentTwoChunks.map(e => e.seq))
    expect(translator.warnings).toEqual([])
  })

  it('tool→text→tool：文本段在第二个 tool 前 flush；step 1/2/3', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(toolCallFrame('a', 'A')))
    translator.feed(notification(messageChunk('mid', 'm1')))
    translator.feed(notification(toolCallFrame('b', 'B')))
    translator.feed(notification(toolDoneFrame('a')))
    translator.feed(notification(toolDoneFrame('b')))
    translator.endTurn()

    const calls = ofType(sink.events, 'tool/call')
    const messages = ofType(sink.events, 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(at(calls, 0).data.step).toBe(1)
    expect(at(messages, 0).data.step).toBe(2)
    expect(at(calls, 1).data.step).toBe(3)
    // 文本段落在两个 tool 卡片之间
    expect(at(calls, 0).seq).toBeLessThan(at(messages, 0).seq)
    expect(at(messages, 0).seq).toBeLessThan(at(calls, 1).seq)
    // 两个 pending 的终态 result 各自复用其 call 的 step
    const results = ofType(sink.events, 'tool/result')
    expect(results.map(e => e.data.step)).toEqual([1, 3])
    expect(translator.warnings).toEqual([])
  })

  it('多工具交错 text→toolA→toolB→text：step 1/2/3/4 按到达序分配', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('start.', 'm1')))
    translator.feed(notification(toolCallFrame('A')))
    translator.feed(notification(toolCallFrame('B')))
    translator.feed(notification(toolDoneFrame('A')))
    translator.feed(notification(toolDoneFrame('B')))
    translator.feed(notification(messageChunk('end.', 'm2')))
    translator.endTurn()

    const calls = ofType(sink.events, 'tool/call')
    const messages = ofType(sink.events, 'assistant/message')
    expect(at(messages, 0).data.step).toBe(1)
    expect(at(calls, 0).data.step).toBe(2)
    expect(at(calls, 1).data.step).toBe(3)
    expect(at(messages, 1).data.step).toBe(4)
    expect(ofType(sink.events, 'tool/result').map(e => e.data.step)).toEqual([2, 3])
    expect(at(messages, 0).seq).toBeLessThan(at(calls, 0).seq)
    expect(at(calls, 1).seq).toBeLessThan(at(messages, 1).seq)
    expect(translator.warnings).toEqual([])
  })

  it('迟到的终态 result（已知 pending）复用 call 的 step，且不 flush 当前开放文本段', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(toolCallFrame('late', 'Slow')))
    translator.endTurn()
    const call = at(ofType(sink.events, 'tool/call'), 0)
    expect(call.data.step).toBe(1)

    translator.beginTurn(2)
    translator.feed(notification(messageChunk('turn two text', 'm1')))
    // ACP 允许终态 update 迟到到后续 turn：已知 pending → 不 flush 开放段
    const out = translator.feed(notification(toolDoneFrame('late', 'late body')))
    expect(typeNames(out)).toEqual(['tool/result'])
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(result.data.turn).toBe(2) // 结果归属到达时的 turn
    expect(result.data.step).toBe(1) // 复用 turn 1 分配的 step（工具卡片身份稳定）
    expect(result.sourceEventSeqs).toEqual([call.seq])

    // 当前开放文本段未被扰动：endTurn 才收口
    expect(typeNames(translator.endTurn())).toEqual(['assistant/chunk', 'assistant/message'])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    expect(msg.data.turn).toBe(2)
    expect(msg.data.step).toBe(1) // turn 2 的首个 segment 从 1 起
    expect(msg.data.message.content).toEqual([{ type: 'text', text: 'turn two text' }])
  })

  it('orphan 终态 result：先 flush 当前开放文本段再分配独立 step（不与已提交文本交错）', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('open text', 'm1')))
    const out = translator.feed(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'ghost',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ghost body' } }],
    }))
    // flush（block-end + message）先于 orphan result
    expect(typeNames(out)).toEqual(['assistant/chunk', 'assistant/message', 'tool/result'])
    const msg = at(ofType(sink.events, 'assistant/message'), 0)
    const result = at(ofType(sink.events, 'tool/result'), 0)
    expect(msg.data.step).toBe(1)
    expect(result.data.step).toBe(2)
    expect(result.sourceEventSeqs).toBeUndefined()
    expect(msg.seq).toBeLessThan(result.seq)
    expect(warningCodes(translator)).toEqual(['orphan-tool-result'])
  })

  it('endTurn 只收口当前开放 segment：已提交消息不被移动/改写', () => {
    const { sink, translator } = makeTranslator()
    translator.beginTurn(1)
    translator.feed(notification(messageChunk('first', 'm1')))
    translator.feed(notification(toolCallFrame('t1')))
    const committed = at(ofType(sink.events, 'assistant/message'), 0)
    const committedSeqs = committed.sourceEventSeqs
    translator.feed(notification(messageChunk('second', 'm2')))
    translator.endTurn()

    const messages = ofType(sink.events, 'assistant/message')
    expect(messages).toHaveLength(2)
    // 已提交消息的内容与引用逐字节不变（后续文本绝不回写旧消息）
    expect(at(messages, 0)).toBe(committed)
    expect(at(messages, 0).sourceEventSeqs).toEqual(committedSeqs)
    expect(at(messages, 0).data.message.content).toEqual([{ type: 'text', text: 'first' }])
    expect(at(messages, 1).data.message.content).toEqual([{ type: 'text', text: 'second' }])
    expect(at(messages, 0).seq).toBeLessThan(at(messages, 1).seq)
  })

  it('turnProducedOutput：空 turn / 只 usage 为 false；beginTurn 复位；segment 提交或 tool 事件置位', () => {
    const { translator } = makeTranslator()
    expect(translator.turnProducedOutput).toBe(false)
    translator.beginTurn(1)
    translator.feed(notification({ sessionUpdate: 'usage_update', used: 50, size: 500 }))
    translator.endTurn()
    expect(translator.turnProducedOutput).toBe(false) // 只产 context 的 turn = 零可见输出

    translator.beginTurn(2)
    translator.feed(notification(messageChunk('x', 'm1')))
    expect(translator.turnProducedOutput).toBe(false) // chunk 未提交前不算产出
    translator.endTurn() // segment 提交
    expect(translator.turnProducedOutput).toBe(true)

    translator.beginTurn(3) // 复位
    expect(translator.turnProducedOutput).toBe(false)
    translator.feed(notification(toolCallFrame('t1')))
    expect(translator.turnProducedOutput).toBe(true) // tool 事件即产出
    translator.endTurn()
  })

  it('live/replay parity：同一更新流经 TurnTranslator 与 ReplayTranslator，可见历史逐条目相等且对账 ok', () => {
    // live 侧：user/message 由 AcpAgent 落盘（此处经同一 recording sink 等价手搭），
    // 内容更新经 TurnTranslator；replay 侧：同一条更新流（含 user chunk）经
    // ReplayTranslator——两侧共享同一个翻译器 + 分段器实现。
    const userChunk = (text: string): SessionUpdate => ({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      messageId: 'u',
    })
    const turn1 = HAPPY_UPDATES
    const turn2: SessionUpdate[] = [
      messageChunk('x', 'm1'),
      toolCallFrame('t2', 'Write'),
      toolDoneFrame('t2', 'wrote'),
      messageChunk('y', 'm2'),
    ]

    const { sink, translator } = makeTranslator()
    sink.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    translator.beginTurn(1)
    for (const update of turn1) translator.feed(notification(update))
    translator.endTurn()
    sink.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q2' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    translator.beginTurn(2)
    for (const update of turn2) translator.feed(notification(update))
    translator.endTurn()

    const replay = new ReplayTranslator({ provider: PROVIDER, model: MODEL })
    for (const update of [userChunk('q1'), ...turn1, userChunk('q2'), ...turn2]) replay.feed(update)
    const staged = replay.finish()

    const liveEntries = expectedVisibleHistory(sink.events, 0, sink.events.length)
    const replayHistory = replayVisibleHistory(staged)
    // 逐条目全等（kind/text/title/status/digest）——共轨的最强钉版
    expect(replayHistory).toEqual(liveEntries)
    expect(reconcileVisibleHistory(replayHistory, liveEntries)).toEqual({ ok: true })
    // 防呆：确实覆盖了 user 锚、多 segment、tool 段
    expect(liveEntries.map(e => e.kind)).toEqual([
      'user', 'assistant', 'tool', 'assistant',
      'user', 'assistant', 'tool', 'assistant',
    ])
  })
})
