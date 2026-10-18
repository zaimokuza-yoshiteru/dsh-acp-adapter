import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationNodeAssembler as NativeAssembler,
  ConversationNodeDefinition,
  ConversationViewDefinition,
  ConversationGroupDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatSnapshot, ProcessGroupData } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  acpPromptAnchorDefinition,
  createAcpActivityDefinition,
  createAcpEffectiveRouteDefinition,
  createAcpLiveActivityDefinition,
} from '../../src/client/ui/activity-definitions.ts'
import {
  normalizeAcpChatNodes,
  activityWindowKey,
  type ActivityWindow,
} from '../../src/client/ui/acp-chat-normalization.ts'
import type { AcpActivityView } from '../../src/contract/remote.ts'

// The adapter's pure normalizer shares a module with React views. No primitive
// is rendered here; the real native builders and ProcessState below remain the
// consumers under test, without loading browser-only published UI imports.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const unused = () => {
    throw new Error('Grouping checks must not render UI primitives')
  }
  return {
    Button: unused,
    DiffBlock: unused,
    DisclosureRow: unused,
    JsonTree: unused,
    StateDot: unused,
    TerminalBlock: unused,
  }
})

// This source-scaffold check drives native grouping without starting a Host.
// Published-host browser scenarios separately verify the shipped Client bundles.
const scaffold = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(process.cwd(), '../reference/deepseek-harness')
const chatPackage = join(scaffold, 'packages/client/ui-chat')
const conversationPackage = join(scaffold, 'packages/client/ui-conversation')
const chatModule = (name: string) =>
  import(pathToFileURL(join(chatPackage, `src/client/conversation-nodes/${name}.ts`)).href)
const [{ ConversationNodeAssembler }, { chatViewDefinition }, { processGroupDefinition }, ...nativeDefinitions] =
  (await Promise.all([
    import(pathToFileURL(join(conversationPackage, 'src/client/conversation/assembler.ts')).href),
    chatModule('chat-snapshot-builder'),
    chatModule('process-groups'),
    chatModule('message'),
    chatModule('assistant'),
    chatModule('turn-process'),
    chatModule('tool'),
  ])) as [
    { ConversationNodeAssembler: typeof NativeAssembler },
    { chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> },
    { processGroupDefinition: ConversationGroupDefinition<ChatConversationViewNode, unknown, ProcessGroupData> },
    ...Record<string, ConversationNodeDefinition>[],
  ]

const markerData = {
  ownerDshSessionId: 'session',
  promptAnchorMessageId: 'input-1',
  profileId: 'acp-codex',
  agentSessionId: '',
  committedActivitySeq: 0,
}
const replay = {
  kind: 'dsh-acp',
  version: 1,
  ...markerData,
  profileGeneration: 1,
  bindingEpoch: 1,
  launchFingerprint: 'test',
  committedPromptOrdinal: 1,
  activityAnchorMessageId: 'input-1',
}
function harness(acp = true, normalize = false) {
  let seq = 0
  const definitions = [
    nativeDefinitions[0]!.messageDefinition!,
    nativeDefinitions[1]!.assistantDefinition!,
    nativeDefinitions[2]!.turnProcessDefinition!,
    nativeDefinitions[3]!.toolDefinition!,
    ...(acp
      ? [
          createAcpEffectiveRouteDefinition(),
          createAcpLiveActivityDefinition((provider) => provider === 'acp-codex'),
          acpPromptAnchorDefinition,
          createAcpActivityDefinition((provider) => provider === 'acp-codex'),
        ]
      : []),
  ]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  const builder = chatViewDefinition.create()
  const group = { state: processGroupDefinition.create() }
  const events: SessionEventLikeEntry[] = []
  const windows = new Map<string, ActivityWindow>()
  let rendered = builder.empty
  assembler.replaceWindow([], false)
  assembler.activateTarget('chat')
  const project = () => {
    assembler.flush()
    const original = assembler.snapshot('chat') as ChatSnapshot
    rendered = builder.replace({
      nodes: normalize
        ? normalizeAcpChatNodes(original.nodes.values(), windows, undefined, undefined, 'session')
        : original.nodes.values(),
      timeline: original.timeline,
    })
    group.state = processGroupDefinition.update(group, builder.groupInput!())
  }
  const append = (type: string, data: unknown) => {
    const event = { type, seq: ++seq, time: seq, data, surfaceOp: 'append' } as SessionEvent
    const entry: SessionEventLikeEntry = { type: 'event', event }
    events.push(entry)
    assembler.append(entry)
    project()
  }
  const start = (turn = 1, provider = 'acp-codex') => {
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    append('user/message', { id: `input-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] })
    append('request/header', { header: { config: { provider, model: 'fixture' } }, reason: 'initial' })
  }
  return {
    start,
    append,
    chunk(type: 'reasoning-delta' | 'text-delta', text: string, turn = 1, step = 1) {
      append('assistant/live-chunk', { turn, step, chunk: { type, index: 0, text } })
    },
    restore() {
      assembler.replaceWindow(events, false)
      project()
    },
    nodes: () => (assembler.snapshot('chat') as ChatSnapshot).nodes.values(),
    projectedNodes: () => rendered.nodes.values(),
    activities: (rows: readonly AcpActivityView[]) => {
      windows.set(activityWindowKey(markerData), { rows, unavailable: false })
      project()
    },
    groupKeys: () => {
      const result = processGroupDefinition.buildGroups(group)
      if (result?.groups.kind !== 'replace') throw new Error('expected native replacement grouping')
      return result.groups.snapshots.map((snapshot) => snapshot.key)
    },
    order: () => builder.groupInput!().order.map((key) => builder.groupInput!().readNode(key)?.kind),
    groups: () => {
      const result = processGroupDefinition.buildGroups(group)
      if (result?.groups.kind !== 'replace') throw new Error('expected native replacement grouping')
      return result.groups.snapshots.map((snapshot) => snapshot.data)
    },
  }
}

describe('ACP markers through the native Chat builder and ProcessState', () => {
  it('retains the native process group and tool seat when the first tool precedes every assistant chunk', () => {
    const current = harness(true, true)
    current.start()
    expect(current.groups()).toEqual([])
    const row = {
      ...markerData,
      dshSessionId: 'session',
      activityId: 'tool:first',
      activitySeq: 1,
      revisionSeq: 1,
      kind: 'tool',
      status: 'running',
      contentIndex: 0,
      time: 1,
      presentation: 'Export report',
      rawDetail: JSON.stringify({ toolName: 'export_report', rawInput: {} }),
    } as AcpActivityView
    current.activities([row])
    const tool = current.projectedNodes().find((node) => node.kind === 'tool-call')!
    const groups = current.groupKeys()
    expect(tool).toBeDefined()
    expect(tool.groupTree).toBeUndefined()
    expect(groups).toHaveLength(1)
    expect(current.groups()).toMatchObject([{ closed: false, summary: { counts: [{ kind: 'tools', count: 1 }] } }])
    current.activities([{ ...row, status: 'completed', revisionSeq: 2 }])
    current.chunk('text-delta', 'Done')
    expect(current.groupKeys()).toEqual(groups)
    expect(current.projectedNodes().find((node) => node.kind === 'tool-call')!.key).toBe(tool.key)
    current.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        source: { kind: 'model', provider: 'acp-codex', replayState: { response: replay } },
      },
    })
    expect(current.groupKeys()).toEqual(groups)
    expect(current.projectedNodes().find((node) => node.kind === 'tool-call')!.key).toBe(tool.key)
    current.restore()
    expect(current.groupKeys()).toEqual(groups)
    expect(current.projectedNodes().find((node) => node.kind === 'tool-call')!.key).toBe(tool.key)
  })

  it('keeps an empty journal outside process groups and after the native Turn control', () => {
    const current = harness()
    current.start()
    expect(current.order()).toEqual(['user', 'turn-process', 'acp-activity', 'acp-activity'])
    expect(current.groups()).toEqual([])
  })

  it.each(['reasoning-delta', 'text-delta'] as const)(
    'matches native groups for the first %s without tool activity',
    (type) => {
      const native = harness(false)
      const current = harness()
      native.start()
      current.start()
      native.chunk(type, 'First content\n')
      current.chunk(type, 'First content\n')
      expect(current.groups()).toEqual(native.groups())
      expect(current.groups().every((group) => !group.closed)).toBe(true)
    },
  )

  it('preserves native tool activity without an extra analysis group', () => {
    const current = harness()
    current.start()
    expect(current.groups()).toEqual([])
    current.append('tool/call', { turn: 1, step: 1, callId: 'read', name: 'read', arguments: '{"path":"fixture.txt"}' })
    expect(current.groups()).toMatchObject([{ closed: false, summary: { counts: [{ kind: 'read', count: 1 }] } }])
    current.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'read-result',
        role: 'tool',
        toolCallId: 'read',
        source: { kind: 'tool', callId: 'read' },
        content: [{ type: 'text', text: 'fixture' }],
      },
    })
    expect(current.groups()).toMatchObject([{ closed: false, summary: { counts: [{ kind: 'read', count: 1 }] } }])
  })

  it('still closes real reasoning when a reply arrives before the Turn ends', () => {
    const current = harness()
    current.start()
    current.chunk('reasoning-delta', 'Thinking\n')
    current.append('assistant/live-chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 1, text: 'Reply' },
    })
    expect(current.groups()).toMatchObject([{ closed: true, summary: { counts: [] } }])
  })

  it('retains journal fallback markers inside the Turn process without claiming analysis completion', () => {
    const current = harness()
    current.start()
    current.chunk('reasoning-delta', 'Thinking\n')
    expect(current.nodes().some((node) => node.kind === 'acp-activity')).toBe(true)
    expect(current.groups()).toMatchObject([{ closed: false, summary: { counts: [] } }])
    expect(
      current
        .nodes()
        .filter((node) => node.kind === 'acp-activity')
        .every((node) => node.groupTree === 'process'),
    ).toBe(true)
  })

  it('keeps later steps and a restored journal from creating empty completed groups', () => {
    const current = harness()
    current.start()
    current.chunk('reasoning-delta', 'Thinking\n')
    current.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        source: { kind: 'model', provider: 'acp-codex', replayState: { response: replay } },
      },
    })
    current.append('step/end', { turn: 1, step: 1 })
    current.append('step/start', { turn: 1, step: 2 })
    current.chunk('reasoning-delta', 'Follow-up\n', 1, 2)
    expect(current.groups()).toMatchObject([{ closed: false }])
    current.restore()
    expect(current.groups()).toMatchObject([{ closed: false }])
  })

  it('keeps native route changes and later turns free of ACP-only groups', () => {
    const current = harness()
    current.start()
    current.append('step/end', { turn: 1, step: 1 })
    current.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    current.start(2, 'native-control')
    current.chunk('text-delta', 'Native answer', 2)
    expect(current.groups()).toEqual([])
    expect(current.nodes().filter((node) => node.kind === 'acp-activity' && node.visibility === 'visible')).toSatisfy(
      (nodes: readonly ChatConversationViewNode[]) =>
        nodes.every((node) => node.location.kind === 'step' && node.location.turn.turn === 1),
    )
    current.restore()
    expect(current.groups()).toEqual([])
  })
})
