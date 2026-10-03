import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationMatch,
  ConversationLocation,
  ConversationNodeDefinition,
  ConversationTimelineSnapshot,
  ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationEventDefinitions,
  ConversationNodeAssembler as ConversationNodeAssemblerType,
  ConversationViewDefinitions,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AcpActivityNodeData } from '../../src/client/ui/activity-definitions.ts'
import {
  acpPromptAnchorDefinition,
  createAcpEffectiveRouteDefinition,
  createAcpActivityDefinition,
  createAcpLiveActivityDefinition,
} from '../../src/client/ui/activity-definitions.ts'

type EventEntry = SessionEventLikeEntry

type ActivityMarker = ConversationViewNode & {
  readonly kind: 'acp-activity'
  readonly location: ConversationLocation
  readonly visibility?: string
  readonly data: AcpActivityNodeData
}

type ActivitySnapshot = {
  readonly nodes: readonly ConversationViewNode[]
  readonly timeline: ConversationTimelineSnapshot
}

const upstreamAssemblerPath = resolve(
  process.cwd(),
  '../reference/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts',
)
const { ConversationNodeAssembler } = (await import(pathToFileURL(upstreamAssemblerPath).href)) as {
  readonly ConversationNodeAssembler: typeof ConversationNodeAssemblerType
}

let nextSeq = 1
let nextTime = 1

function event(type: string, data: unknown): EventEntry {
  const entry = {
    type,
    seq: nextSeq++,
    time: nextTime++,
    data,
  } as unknown as SessionEvent
  return { type: 'event', event: entry }
}

function userMessage(id: string): EventEntry {
  return inputMessage(id, 'user')
}

function inputMessage(id: string, sourceKind: string): EventEntry {
  const source =
    sourceKind === 'team-message'
      ? {
          kind: 'team-message',
          teamId: 'test-team',
          messageId: `team-${id}`,
          senderId: 'test-sender',
          senderName: 'Test Lead',
        }
      : sourceKind === 'runtime-context'
        ? { kind: 'runtime-context' }
        : { kind: sourceKind }
  return event('user/message', {
    id,
    source,
    content: [{ type: 'text', text: `input ${id}` }],
  })
}

function header(
  provider: string | undefined,
  reason: 'initial' | 'change' | 'series' = 'initial',
  model = 'test-model',
): EventEntry {
  return event('request/header', {
    header: { config: { ...(provider === undefined ? {} : { provider }), model } },
    reason,
  })
}

function requestPromptDefinition(): ConversationNodeDefinition<{ readonly prompt: { readonly config: unknown } }> {
  const promptState = (match: ConversationMatch) => {
    if (match.event.type !== 'request/header') throw new Error('request-prompt requires request/header')
    return { prompt: { config: match.event.data.header.config } }
  }
  return {
    kind: 'request-prompt',
    match: (candidate) => (candidate.type === 'request/header' ? { id: 'request-prompt', role: 'start' } : null),
    start: (_context, match) => promptState(match),
    update: (_context, match) => promptState(match),
  }
}

function makeAssembler(includeRequestPrompt = true, includeSettledActivity = false) {
  const definitions: readonly ConversationNodeDefinition[] = [
    ...(includeRequestPrompt ? [requestPromptDefinition()] : []),
    createAcpEffectiveRouteDefinition(),
    createAcpLiveActivityDefinition((provider) => provider === 'acp-devin'),
    acpPromptAnchorDefinition,
    ...(includeSettledActivity ? [createAcpActivityDefinition((provider) => provider === 'acp-devin')] : []),
  ]
  const view: ConversationViewDefinition<ConversationViewNode, ActivitySnapshot> = {
    target: 'chat',
    create: () => {
      let nodes: readonly ConversationViewNode[] = []
      return {
        empty: { nodes, timeline: { turnOrder: [], turns: new Map() } },
        replace: ({ nodes: nextNodes, timeline }) => {
          nodes = nextNodes
          return { nodes, timeline }
        },
        apply: ({ upserts, timeline }) => {
          const byKey = new Map(nodes.map((node) => [node.key, node]))
          for (const node of upserts) byKey.set(node.key, node)
          nodes = [...byKey.values()]
          return { nodes, timeline }
        },
      }
    },
  }
  const eventDefinitions: ConversationEventDefinitions = {
    entries: () => definitions,
    fallbackEntry: () => undefined,
  }
  const viewDefinitions: ConversationViewDefinitions = { entries: () => [view] }
  const assembler = new ConversationNodeAssembler(eventDefinitions, viewDefinitions)
  assembler.replaceWindow([], false)
  assembler.activateTarget('chat')
  return {
    assembler,
    append(entry: EventEntry) {
      assembler.append(entry)
      assembler.flush()
    },
    replaceWindow(entries: readonly EventEntry[], hasMore: boolean) {
      assembler.replaceWindow(entries, hasMore)
      assembler.flush()
    },
    snapshot(): ActivitySnapshot {
      return assembler.snapshot('chat') as ActivitySnapshot
    },
  }
}

function stepStart(turn: number, step: number): EventEntry {
  return event('step/start', { turn, step })
}

function turnStart(turn: number): EventEntry {
  return event('turn/start', { turn })
}

function isActivityMarker(node: ConversationViewNode): node is ActivityMarker {
  return node.kind === 'acp-activity'
}

function liveNodes(harness: ReturnType<typeof makeAssembler>): ActivityMarker[] {
  return harness.snapshot().nodes.filter(isActivityMarker)
}

function nodeFor(harness: ReturnType<typeof makeAssembler>, messageId: string): ActivityMarker {
  const node = liveNodes(harness).find((candidate) => candidate.data.promptAnchorMessageId === messageId)
  expect(node, `expected live marker anchored to ${messageId}`).toBeDefined()
  return node!
}

it('replays a request header arriving after its direct input and retracts a native-route marker', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler()
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(userMessage('late-header-input'))

  expect(nodeFor(harness, 'late-header-input').visibility).toBe('hidden')
  harness.append(header('acp-devin'))
  expect(nodeFor(harness, 'late-header-input')).toMatchObject({
    visibility: 'visible',
    data: { profileId: 'acp-devin', promptAnchorMessageId: 'late-header-input' },
  })

  harness.append(turnStart(2))
  harness.append(stepStart(2, 1))
  harness.append(userMessage('native-route-input'))
  expect(nodeFor(harness, 'native-route-input').visibility).toBe('visible')
  harness.append(header('native-control', 'change'))
  expect(nodeFor(harness, 'native-route-input').visibility).toBe('hidden')
  expect(nodeFor(harness, 'late-header-input').visibility).toBe('visible')
})

it('keeps historical markers stable across ACP, native, then ACP route changes', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler()
  const promptIds = ['route-one', 'route-two', 'route-three']
  const providers = ['acp-devin', 'native-control', 'acp-devin']

  for (let index = 0; index < promptIds.length; index++) {
    const turn = index + 1
    harness.append(turnStart(turn))
    harness.append(stepStart(turn, 1))
    harness.append(userMessage(promptIds[index]!))
    harness.append(header(providers[index], index === 0 ? 'initial' : 'change'))
  }

  expect(liveNodes(harness).map((node) => [node.data.promptAnchorMessageId, node.visibility])).toEqual([
    ['route-one', 'visible'],
    ['route-two', 'hidden'],
    ['route-three', 'visible'],
  ])
})

it('inherits an omitted duplicate header through a later tool-only step and anchors every input separately', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler()
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(userMessage('seed-route'))
  harness.append(header('acp-devin'))
  harness.append(turnStart(2))
  harness.append(stepStart(2, 1))
  harness.append(userMessage('omitted-header-input'))
  harness.append(event('tool/call', { turn: 2, step: 1, callId: 'tool-1', name: 'read', arguments: '{}' }))

  expect(nodeFor(harness, 'omitted-header-input')).toMatchObject({
    visibility: 'visible',
    data: { profileId: 'acp-devin', promptAnchorMessageId: 'omitted-header-input' },
  })

  harness.append(userMessage('second-input-same-step'))
  harness.append(header('acp-devin', 'series'))
  const sameStep = liveNodes(harness).filter((node) =>
    ['omitted-header-input', 'second-input-same-step'].includes(node.data.promptAnchorMessageId),
  )
  expect(sameStep).toHaveLength(2)
  expect(new Set(sameStep.map((node) => node.key)).size).toBe(2)
  expect(sameStep.map((node) => node.data.promptAnchorMessageId).sort()).toEqual([
    'omitted-header-input',
    'second-input-same-step',
  ])
  const step = harness
    .snapshot()
    .timeline.turns.get(2)
    ?.steps.find((candidate) => candidate.step === 1)
  expect(step?.data.get('acp-activity-live')).toBeUndefined()
})

it('anchors mailbox-only inputs without a header and does not borrow a direct input from an older step', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler(true, true)
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(userMessage('old-direct-input'))
  harness.append(header('acp-devin'))
  harness.append(event('step/end', { turn: 1, step: 1 }))

  harness.append(stepStart(1, 2))
  harness.append(inputMessage('mailbox-only-input', 'team-message'))
  expect(nodeFor(harness, 'mailbox-only-input')).toMatchObject({
    visibility: 'visible',
    data: { profileId: 'acp-devin', promptAnchorMessageId: 'mailbox-only-input' },
  })
  harness.append(header('acp-devin', 'change', 'test-model-next'))
  const request = liveNodes(harness).find(
    (node) =>
      node.id.startsWith('request:') &&
      node.location.kind === 'step' &&
      node.location.turn.turn === 1 &&
      node.location.step.step === 2,
  )
  expect(request?.data.promptAnchorMessageId).toBe('mailbox-only-input')

  harness.append(stepStart(1, 3))
  harness.append(header('acp-devin', 'series', 'test-model-next'))
  const noInputRequest = liveNodes(harness).find(
    (node) => node.id.startsWith('request:') && node.location.kind === 'step' && node.location.step.step === 3,
  )
  expect(noInputRequest?.data.promptAnchorMessageId).toBe(noInputRequest?.id)
})

it.each([
  {
    order: 'runtime before direct',
    inputs: [
      ['runtime-context', 'runtime-first'],
      ['user', 'direct-second'],
    ],
  },
  {
    order: 'direct before runtime',
    inputs: [
      ['user', 'direct-first'],
      ['runtime-context', 'runtime-second'],
    ],
  },
] as const)('uses the last direct input for $order while retaining each candidate window', ({ inputs }) => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler(true, true)
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  for (const [source, id] of inputs) harness.append(inputMessage(id, source))

  harness.append(header('acp-devin'))
  const directId = inputs.find(([source]) => source === 'user')![1]
  const request = liveNodes(harness).find((node) => node.id.startsWith('request:'))
  expect(request?.data.promptAnchorMessageId).toBe(directId)
  const candidates = liveNodes(harness).filter((node) => node.id.startsWith('input:'))
  expect(candidates.map((node) => node.data.promptAnchorMessageId)).toContain(directId)
  if (inputs[0]![0] === 'runtime-context') {
    expect(candidates.map((node) => node.data.promptAnchorMessageId)).toContain('runtime-first')
  }
})

it('anchors mailbox plus runtime context to the last admitted input when no direct input exists', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler(true, true)
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(inputMessage('mailbox-input', 'team-message'))
  harness.append(inputMessage('runtime-input', 'runtime-context'))
  harness.append(header('acp-devin'))

  const request = liveNodes(harness).find((node) => node.id.startsWith('request:'))
  expect(request?.data.promptAnchorMessageId).toBe('runtime-input')
})

it('keeps the last direct input as the step anchor after later runtime context', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler(true, true)
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(inputMessage('runtime-before', 'runtime-context'))
  harness.append(userMessage('direct-input'))
  harness.append(inputMessage('runtime-after', 'runtime-context'))
  harness.append(header('acp-devin'))

  const request = liveNodes(harness).find((node) => node.id.startsWith('request:'))
  expect(request?.data.promptAnchorMessageId).toBe('direct-input')
  expect(liveNodes(harness).filter((node) => node.id.startsWith('input:'))).toHaveLength(3)
})

it('keeps two direct inputs as separate activity windows in one step', () => {
  nextSeq = 1
  nextTime = 1
  const harness = makeAssembler(true, true)
  harness.append(turnStart(1))
  harness.append(stepStart(1, 1))
  harness.append(userMessage('direct-window-one'))
  harness.append(header('acp-devin'))
  harness.append(userMessage('direct-window-two'))
  harness.append(header('acp-devin', 'series'))

  const requests = liveNodes(harness).filter((node) => node.id.startsWith('request:'))
  expect(requests.map((node) => node.data.promptAnchorMessageId)).toEqual(['direct-window-one', 'direct-window-two'])
})

it('fails closed for unknown or damaged headers and partial windows without a prior request prompt', () => {
  nextSeq = 1
  nextTime = 1
  const unknown = makeAssembler()
  unknown.append(turnStart(1))
  unknown.append(stepStart(1, 1))
  unknown.append(userMessage('unknown-provider'))
  unknown.append(header('unknown-provider'))
  expect(nodeFor(unknown, 'unknown-provider').visibility).toBe('hidden')

  unknown.append(header(undefined, 'change'))
  expect(nodeFor(unknown, 'unknown-provider').visibility).toBe('hidden')

  const partialWithoutPrompt = makeAssembler()
  partialWithoutPrompt.replaceWindow([turnStart(7), stepStart(7, 1), userMessage('partial-no-prompt')], true)
  expect(nodeFor(partialWithoutPrompt, 'partial-no-prompt').visibility).toBe('hidden')

  const partialWithPrompt = makeAssembler()
  partialWithPrompt.replaceWindow(
    [header('acp-devin'), turnStart(7), stepStart(7, 1), userMessage('partial-with-prompt')],
    true,
  )
  expect(nodeFor(partialWithPrompt, 'partial-with-prompt')).toMatchObject({
    visibility: 'visible',
    data: { profileId: 'acp-devin', promptAnchorMessageId: 'partial-with-prompt' },
  })
})
