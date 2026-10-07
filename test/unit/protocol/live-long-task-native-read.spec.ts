import { expect, it } from 'vitest'
import { createNativeReadObserver, wrapObservedCallback } from '../../e2e/live-long-task-native-read.ts'

const sourcePath = '/tmp/workspace/public-dsh-source/inbox.ts'
const sourceText = [
  'export function claimInboxMessages(agentId: string): ClaimedMessage[] {',
  '  const claimed = inbox.claimAvailableMessages(agentId)',
  '  return claimed.map((message) => ({ message, turn }))',
].join('\n')
const sources = [
  { absolutePath: sourcePath, relativePath: 'packages/core/agent-loop/src/inbox.ts', content: sourceText },
]
const hashIdentifier = (kind: string, value: string): string => `${kind}:hashed:${value.length}`

it('merges a live partial tool update and emits only verified safe evidence on completion', () => {
  const observe = createNativeReadObserver({
    activeSessionId: 'acp-session-1',
    sessionEvidenceId: 'host-session-9',
    sources,
    hashIdentifier,
  })
  const initial = {
    sessionId: 'acp-session-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'raw-tool-id',
      kind: 'read',
      status: 'in_progress',
      rawInput: { file_path: sourcePath },
      content: [{ type: 'content', content: { type: 'text', text: sourceText.split('\n')[0] } }],
    },
  }
  expect(observe(initial)).toEqual([])
  expect(
    observe({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'raw-tool-id',
        status: 'completed',
        locations: [{ path: sourcePath, line: 1 }],
        content: [{ type: 'content', content: { type: 'text', text: sourceText.split('\n').slice(1).join('\n') } }],
      },
    }),
  ).toEqual([
    {
      session: 'dsh-session:hashed:14',
      callId: 'acp-tool-call:hashed:11',
      path: 'packages/core/agent-loop/src/inbox.ts',
      matchedLines: 3,
      verified: true,
    },
  ])
  expect(
    observe({
      sessionId: 'acp-session-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'raw-tool-id', status: 'completed' },
    }),
  ).toEqual([])
})

it('ignores child and historical-session updates outside the active prompt session', () => {
  const observe = createNativeReadObserver({ activeSessionId: 'parent-session', sources, hashIdentifier })
  for (const sessionId of ['child-session', 'old-session']) {
    expect(
      observe({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          kind: 'read',
          status: 'completed',
          rawInput: { file_path: sourcePath },
          locations: [{ path: sourcePath }],
          content: [{ type: 'content', content: { type: 'text', text: sourceText } }],
        },
      }),
    ).toEqual([])
  }
})

it('rejects unlisted paths, mismatched locations, non-read kinds, and insufficient source text', () => {
  const observe = createNativeReadObserver({ activeSessionId: 'session', sources, hashIdentifier })
  const notify = (toolCallId: string, patch: Record<string, unknown>) =>
    observe({ sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId, status: 'completed', ...patch } })
  const sourceOutput = [{ type: 'content', content: { type: 'text', text: sourceText } }]
  expect(
    notify('outside', {
      kind: 'read',
      rawInput: { file_path: '/tmp/workspace/private.txt' },
      locations: [{ path: '/tmp/workspace/private.txt' }],
      content: sourceOutput,
    }),
  ).toEqual([])
  expect(
    notify('mismatch', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: '/tmp/workspace/private.txt' }],
      content: sourceOutput,
    }),
  ).toEqual([])
  expect(
    notify('terminal', {
      kind: 'terminal',
      rawInput: { file_path: sourcePath },
      locations: [{ path: sourcePath }],
      content: sourceOutput,
    }),
  ).toEqual([])
  expect(
    notify('summary-only', {
      kind: 'read',
      rawInput: { files: [{ filePath: sourcePath }] },
      locations: [{ path: sourcePath }],
      content: [{ type: 'content', content: { type: 'text', text: 'The inbox handles messages.' } }],
    }),
  ).toEqual([])
  expect(
    notify('diff-output', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [{ type: 'diff', unified_diff: sourceText }],
    }),
  ).toEqual([])
  expect(
    notify('resource-link', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [{ type: 'resource_link', uri: sourcePath, name: 'inbox.ts' }],
    }),
  ).toEqual([])
  expect(
    notify('comment-only', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [
        { type: 'content', content: { type: 'text', text: '// This source comment is not implementation evidence.' } },
      ],
    }),
  ).toEqual([])
  expect(
    notify('error-output', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      isError: true,
      content: [{ type: 'content', content: { type: 'text', text: sourceText } }],
    }),
  ).toEqual([])
})

it('accepts one allowlisted path source alone and rejects conflicting supplied paths', () => {
  const observe = createNativeReadObserver({ activeSessionId: 'acp', sources, hashIdentifier })
  const notify = (toolCallId: string, patch: Record<string, unknown>) =>
    observe({
      sessionId: 'acp',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        kind: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: sourceText } }],
        ...patch,
      },
    })
  expect(notify('raw-only', { rawInput: { file_path: sourcePath } })).toHaveLength(1)
  expect(notify('locations-only', { locations: [{ path: sourcePath }] })).toHaveLength(1)
  expect(notify('empty-locations', { rawInput: { file_path: sourcePath }, locations: [] })).toHaveLength(1)
  expect(notify('empty-input', { rawInput: {}, locations: [{ path: sourcePath }] })).toHaveLength(1)
  expect(
    notify('conflict', {
      rawInput: { path: sourcePath },
      locations: [{ path: '/tmp/workspace/private.txt' }],
    }),
  ).toEqual([])
})

it('preserves callback receiver and every argument and invokes the original once even if observation fails', () => {
  const receiver = { owner: 'runtime' }
  const calls: unknown[][] = []
  let observations = 0
  let failures = 0
  const original = function (this: unknown, ...args: unknown[]) {
    calls.push([this, ...args])
    return 'forwarded'
  }
  const wrapped = wrapObservedCallback(
    original,
    () => {
      observations += 1
      throw new Error('observer failure')
    },
    () => {
      failures += 1
    },
  )
  expect(wrapped.call(receiver, { id: 1 }, 'second-argument', 3)).toBe('forwarded')
  expect(observations).toBe(1)
  expect(failures).toBe(1)
  expect(calls).toEqual([[receiver, { id: 1 }, 'second-argument', 3]])
})

it('requires two informative lines unique to the located file in the same successful read call', () => {
  const otherPath = '/tmp/workspace/public-dsh-source/runtime-context.ts'
  const otherText = [
    'export function claimInboxMessages(agentId: string): ClaimedMessage[] {',
    '  const context = runtimeContext.forAgent(agentId)',
    '  return context.withCurrentTurn(turn)',
  ].join('\n')
  const observe = createNativeReadObserver({
    activeSessionId: 'session',
    sources: [
      ...sources,
      { absolutePath: otherPath, relativePath: 'packages/core/agent-loop/src/runtime-context.ts', content: otherText },
    ],
    hashIdentifier,
  })
  const notify = (toolCallId: string, patch: Record<string, unknown>) =>
    observe({ sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId, status: 'completed', ...patch } })
  const sharedOnly = 'export function claimInboxMessages(agentId: string): ClaimedMessage[] {'
  expect(
    notify('generic', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [{ type: 'content', content: { type: 'text', text: `${sharedOnly}\n${sharedOnly}` } }],
    }),
  ).toEqual([])
  expect(
    notify('wrong-file-output', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [{ type: 'content', content: { type: 'text', text: otherText } }],
    }),
  ).toEqual([])
  expect(
    notify('cross-call', {
      kind: 'read',
      rawInput: { path: sourcePath },
      locations: [{ path: sourcePath }],
      content: [{ type: 'content', content: { type: 'text', text: sourceText.split('\n')[1] } }],
    }),
  ).toEqual([])
})
