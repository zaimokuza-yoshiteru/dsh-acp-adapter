import { describe, it, expect } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { normalizeAcpChatNodes, activityWindowKey } from '../../../src/client/ui/acp-chat-normalization.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AcpActivityView } from '../../../src/client/data/acp-remote.ts'
import { activityBoundaries, finalAnswerStart, installAcpAssistantStream, uniqueViewTabs } from '../../../src/client/ui/AcpAssistantStream.ts'

describe('native assistant renderer composition', () => {
  it('keeps legacy and not-yet-delivered activity out of the inline boundaries', () => {
    const rows = [{ activityId: 'old' }, { activityId: 'tail', contentIndex: 2 },
      { activityId: 'future', contentIndex: 3 }, { activityId: 'head', contentIndex: 0 }] as AcpActivityView[]
    expect([...activityBoundaries(rows, 2)]).toEqual([[2, [rows[1]]], [0, [rows[3]]]])
    expect([...activityBoundaries(rows, 2, true)]).toEqual([[2, [rows[1], rows[2]]], [0, [rows[3]]]])
  })

  it('keeps all trailing answer paragraphs and images visible when folding the process', () => {
    const blocks = [{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'progress' },
      { kind: 'text', text: 'answer paragraph one' }, { kind: 'text', text: 'answer paragraph two' }] as never
    expect(finalAnswerStart(blocks, new Map([[2, []], [4, []]]))).toBe(2)
    expect(finalAnswerStart(blocks, new Map())).toBe(1)
  })

  it('composes the native Chat and header trees without redeclaring their child slots', async () => {
    const slots = new SlotCore()
    const root = slots.register({ name: 'root', children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'conversation.session.header': { kind: 'single', scope: 'session' },
    } } as never, (() => null) as never)
    const Native = () => null
    const inject = () => ({ hooks: { presentation: {} } })
    slots.register({ name: 'conversation.view', id: 'chat', inject, children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    } } as never, Native as never)
    slots.register({ name: 'conversation.session.header' } as never, Native as never)
    slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, Native as never)
    const releases: Array<() => void> = []
    installAcpAssistantStream({ slots: {
      entries: slots.entries.bind(slots), entriesOfSlot: slots.entriesOfSlot.bind(slots),
      subscribe: slots.subscribe.bind(slots), register: slots.register.bind(slots), registerFactory: slots.registerFactory,
      inject: (_name: string, setup: () => () => void) => { releases.push(setup()) },
    } } as never, {} as never)
    await Promise.resolve()
    const chat = slots.entriesOfSlot('conversation.view')[0]!
    expect(chat.inject).toBe(inject)
    const child = Object.keys(chat.children!)[0]!
    expect(child).not.toBe('conversation.chat.node')
    expect(slots.entriesOfSlot(child).map(entry => entry.options.key).sort()).toEqual(['acp-inline-activity', 'tool-call'])
    expect(uniqueViewTabs(slots.entries('conversation.view').map(entry => ({ id: entry.options.id! })))).toEqual([{ id: 'chat' }])
    releases.reverse().forEach(release => release())
    expect(slots.entriesOfSlot('conversation.view')[0]!.component).toBe(Native)
    expect(slots.entriesOfSlot(child)).toEqual([])
    root()
  })

  it('normalizes interleaved tools into native nodes, preserves ordinary nodes and falls back on journal errors', () => {
    const data = { ownerDshSessionId: 'owner', promptAnchorMessageId: 'prompt', profileId: 'codex', agentSessionId: 'remote', committedActivitySeq: 4 }
    const location = { kind: 'step', turn: { turn: 1 }, step: { data: { get: (key: string) => key === 'acp-activity' ? data : undefined } } }
    const assistant = { key: 'answer', id: 'answer', kind: 'assistant-step', target: 'chat', visibility: 'visible', anchorSeq: 10,
      location, data: { status: 'settled', turn: 1, step: 1, blocks: [
        { kind: 'reasoning', text: '\n\nThink' }, { kind: 'text', text: 'Progress' },
        { kind: 'text', text: 'Answer one' }, { kind: 'text', text: 'Answer two' },
      ] } } as unknown as ChatConversationViewNode
    const marker = { ...assistant, key: 'marker', kind: 'acp-activity', data }
    const native = { ...assistant, key: 'native', location: { kind: 'session' } } as ChatConversationViewNode
    const row = { activityId: 'tool:one', kind: 'tool', status: 'completed', contentIndex: 2, rawDetail: JSON.stringify({ toolName: 'send_message', rawInput: { target: 'worker' } }) } as AcpActivityView
    const key = activityWindowKey(data)
    const result = normalizeAcpChatNodes([native, assistant, marker], new Map([[key, { rows: [row], unavailable: false }]]))
    expect(result[0]).toBe(native)
    expect(result.map(node => node.kind)).toEqual(['assistant-step', 'assistant-step', 'tool-call', 'assistant-step'])
    expect(result[1]!.data).toMatchObject({ blocks: [{ kind: 'reasoning', text: 'Think' }, { kind: 'text', text: 'Progress' }] })
    expect(result[2]!.data).toMatchObject({ root: { call: { name: 'send_message' } } })
    expect(result[3]!.data).toMatchObject({ blocks: [{ kind: 'text', text: 'Answer one' }, { kind: 'text', text: 'Answer two' }] })
    expect(normalizeAcpChatNodes([assistant, marker], new Map([[key, { rows: [], unavailable: true }]]))).toEqual([assistant, marker])
  })
  it('preserves a later native answer while adding ACP tool counts to the same Turn', () => {
    const data = { ownerDshSessionId: 'owner', promptAnchorMessageId: 'prompt' }
    const location = { kind: 'step', turn: { turn: 1 }, step: { data: { get: (key: string) => key === 'acp-activity' ? data : undefined } } }
    const assistant = { key: 'acp', id: 'acp', kind: 'assistant-step', target: 'chat', visibility: 'visible', anchorSeq: 10,
      location, data: { status: 'settled', turn: 1, step: 1, blocks: [{ kind: 'text', text: 'ACP result' }] } } as unknown as ChatConversationViewNode
    const process = { ...assistant, key: 'process', kind: 'turn-process', data: {
      turn: 1, answerStep: 2, answerAnchorSeq: 20, inlineReasoning: true, toolCallCount: 2,
    } } as ChatConversationViewNode
    const row = { activityId: 'call', activitySeq: 1, kind: 'tool', presentation: 'list_agents', status: 'completed', contentIndex: 0 } as AcpActivityView
    const result = normalizeAcpChatNodes([process, assistant], new Map([[activityWindowKey(data as never), { rows: [row], unavailable: false }]]))
    expect(result[0]!.data).toEqual({ turn: 1, answerStep: 2, answerAnchorSeq: 20, inlineReasoning: true, toolCallCount: 3 })
  })

})
