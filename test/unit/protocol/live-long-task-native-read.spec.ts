import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  createNativeReadObserver,
  MAX_NATIVE_READ_DIAGNOSTICS,
  wrapObservedCallback,
} from '../../e2e/live-long-task-native-read.ts'
import type { NativeReadDiagnostic, NativeReadEvidence } from '../../e2e/live-long-task-native-read.ts'

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

it('reports why native candidates were declined without retaining arbitrary input or output', () => {
  const diagnostics: NativeReadDiagnostic[] = []
  const hash = (kind: string, value: string): string => createHash('sha256').update(`${kind}:${value}`).digest('hex')
  const observe = createNativeReadObserver({
    activeSessionId: 'session',
    sources,
    hashIdentifier: hash,
    onDiagnostic: (entry) => diagnostics.push(entry),
  })
  const notify = (toolCallId: string, patch: Record<string, unknown>) =>
    observe({
      sessionId: 'session',
      update: { sessionUpdate: 'tool_call', toolCallId, kind: 'read', status: 'completed', ...patch },
    })
  const content = [{ type: 'text', text: sourceText }]
  const outsidePath = '/home/private/account-token.txt'
  notify('unknown-kind', { kind: 'private-provider-label', rawInput: { path: sourcePath }, content })
  notify('in-progress', { status: 'in_progress', rawInput: { path: sourcePath }, content })
  notify('conflict', { rawInput: { path: sourcePath }, locations: [{ path: outsidePath }], content })
  notify('unlisted', { rawInput: { path: outsidePath }, content })
  notify('missing-path', { rawInput: { command: 'private command string' }, content })
  notify('unsupported-output', {
    rawInput: { path: sourcePath },
    rawOutput: { text: sourceText, token: 'private-token' },
  })
  notify('few-lines', { rawInput: { path: sourcePath }, content: [{ type: 'text', text: sourceText.split('\n')[0] }] })
  notify('error', { rawInput: { path: sourcePath }, content, isError: true })
  notify('failed-status', { status: 'failed', rawInput: { path: sourcePath }, content })
  notify('diff-content', { rawInput: { path: sourcePath }, content: [{ type: 'diff', unified_diff: sourceText }] })
  notify('verified', { rawInput: { path: sourcePath }, content })
  notify('verified', {})
  expect(diagnostics.map(({ reason }) => reason)).toEqual([
    'kind-not-read',
    'status-not-completed',
    'path-conflict',
    'path-not-allowlisted',
    'path-missing',
    'typed-text-missing',
    'source-lines-insufficient',
    'tool-failed',
    'tool-failed',
    'typed-text-missing',
    'verified-source-lines',
    'already-verified',
  ])
  expect(diagnostics[0]).toMatchObject({ kind: 'other', decision: 'declined' })
  expect(diagnostics[1]).toMatchObject({ status: 'in_progress', decision: 'pending' })
  expect(diagnostics[2]?.paths).toEqual([
    { source: 'input', identity: sources[0]!.relativePath, allowlisted: true },
    { source: 'location', identity: hash('native-read-path', outsidePath), allowlisted: false },
  ])
  expect(diagnostics[5]).toMatchObject({ rawOutputShape: 'record', textCharacters: 0 })
  expect(diagnostics[6]?.matches).toEqual([{ path: sources[0]!.relativePath, matchedLines: 1, alreadyVerified: false }])
  expect(diagnostics[9]).toMatchObject({
    outputFormats: ['array', 'diff'],
    contentShape: 'array',
    reason: 'typed-text-missing',
  })
  const serialized = JSON.stringify(diagnostics)
  for (const privateValue of [
    sourcePath,
    sourceText,
    outsidePath,
    'private-provider-label',
    'private command string',
    'private-token',
    'unknown-kind',
  ]) {
    expect(serialized).not.toContain(privateValue)
  }
})

it('rejects missing current-session identity and diagnoses malformed read candidates', () => {
  const diagnostics: NativeReadDiagnostic[] = []
  const options = { sources, hashIdentifier, onDiagnostic: (entry: NativeReadDiagnostic) => diagnostics.push(entry) }
  const missingSession = createNativeReadObserver({ ...options, activeSessionId: undefined })
  expect(
    missingSession({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'read',
        kind: 'read',
        status: 'completed',
        rawInput: { path: sourcePath },
        content: [{ type: 'text', text: sourceText }],
      },
    }),
  ).toEqual([])
  const observe = createNativeReadObserver({ ...options, activeSessionId: 'session' })
  expect(observe(null)).toEqual([])
  expect(observe({ sessionId: 'session' })).toEqual([])
  expect(
    observe({ sessionId: 'session', update: { sessionUpdate: 'tool_call', kind: 'read', status: 'completed' } }),
  ).toEqual([])
  expect(diagnostics.map(({ reason }) => reason)).toEqual([
    'active-session-missing',
    'notification-shape',
    'update-shape',
    'call-id-missing',
  ])
})

it('bounds diagnostic emission and skips ordinary non-tool session traffic', () => {
  const diagnostics: NativeReadDiagnostic[] = []
  const observe = createNativeReadObserver({
    activeSessionId: 'session',
    sources,
    hashIdentifier,
    onDiagnostic: (entry) => diagnostics.push(entry),
  })
  for (let index = 0; index < MAX_NATIVE_READ_DIAGNOSTICS * 2; index += 1) {
    observe({
      sessionId: 'session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ordinary traffic' } },
    })
  }
  expect(diagnostics).toEqual([])
  for (let index = 0; index < MAX_NATIVE_READ_DIAGNOSTICS * 2; index += 1) {
    observe({
      sessionId: 'session',
      update: { sessionUpdate: 'tool_call_update', toolCallId: String(index), kind: 'other', status: 'completed' },
    })
  }
  expect(diagnostics).toHaveLength(MAX_NATIVE_READ_DIAGNOSTICS + 1)
  expect(diagnostics.at(-1)).toMatchObject({ decision: 'limit', reason: 'diagnostic-limit' })
})

it('records an exhausted text window while preserving the two-line acceptance requirement', () => {
  const diagnostics: NativeReadDiagnostic[] = []
  const observe = createNativeReadObserver({
    activeSessionId: 'session',
    sources,
    hashIdentifier,
    onDiagnostic: (entry) => diagnostics.push(entry),
  })
  expect(
    observe({
      sessionId: 'session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'truncated',
        kind: 'read',
        status: 'completed',
        rawInput: { path: sourcePath },
        content: [{ type: 'text', text: `${'x'.repeat(64 * 1024)}\n${sourceText}` }],
      },
    }),
  ).toEqual([])
  expect(diagnostics[0]).toMatchObject({
    textCharacters: 64 * 1024,
    textLimitReached: true,
    reason: 'source-lines-insufficient',
  })
})

it('keeps two owners separate even when provider call IDs collide and one owner attempts to borrow another read', () => {
  const otherPath = '/tmp/workspace/public-dsh-source/mailbox.ts'
  const otherText = [
    'export function appendMailboxMessage(recipient: string): void {',
    '  const mailbox = mailboxes.getOrCreate(recipient)',
    '  mailbox.append({ sender, recipient, content })',
  ].join('\n')
  const sourcePair = [
    ...sources,
    { absolutePath: otherPath, relativePath: 'packages/core/agent-team/src/mailbox.ts', content: otherText },
  ]
  const hash = (kind: string, value: string): string => createHash('sha256').update(`${kind}:${value}`).digest('hex')
  const ownerA: NativeReadEvidence[] = []
  const ownerB: NativeReadEvidence[] = []
  const diagnosticA: NativeReadDiagnostic[] = []
  const observeA = createNativeReadObserver({
    activeSessionId: 'acp-owner-a',
    sessionEvidenceId: 'host-owner-a',
    sources: sourcePair,
    hashIdentifier: hash,
    onDiagnostic: (entry) => diagnosticA.push(entry),
  })
  const observeB = createNativeReadObserver({
    activeSessionId: 'acp-owner-b',
    sessionEvidenceId: 'host-owner-b',
    sources: sourcePair,
    hashIdentifier: hash,
  })
  const notifyBoth = (notification: unknown): void => {
    ownerA.push(...observeA(notification))
    ownerB.push(...observeB(notification))
  }
  // A has declared its own path but has not returned any source content.
  notifyBoth({
    sessionId: 'acp-owner-a',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'shared-provider-call',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: sourcePath },
    },
  })
  // B's complete call cannot finish A's colliding call or satisfy A's expected path.
  notifyBoth({
    sessionId: 'acp-owner-b',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'shared-provider-call',
      kind: 'read',
      status: 'completed',
      rawInput: { path: otherPath },
      content: [{ type: 'text', text: otherText }],
    },
  })
  expect(ownerA).toEqual([])
  expect(ownerB).toEqual([
    expect.objectContaining({ session: hash('dsh-session', 'host-owner-b'), path: sourcePair[1]!.relativePath }),
  ])
  expect(diagnosticA.at(-1)).toMatchObject({
    reason: 'foreign-session',
    activeAcpSession: hash('acp-session', 'acp-owner-a'),
    observedAcpSession: hash('acp-session', 'acp-owner-b'),
  })
  // A's own completed call with B's source text is still not proof of A's declared source read.
  notifyBoth({
    sessionId: 'acp-owner-a',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shared-provider-call',
      status: 'completed',
      content: [{ type: 'text', text: otherText }],
    },
  })
  expect(ownerA).toEqual([])
  expect(diagnosticA.at(-1)).toMatchObject({
    reason: 'source-lines-insufficient',
    matches: [{ path: sources[0]!.relativePath, matchedLines: 0 }],
  })
  notifyBoth({
    sessionId: 'acp-owner-a',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shared-provider-call',
      status: 'completed',
      content: [{ type: 'text', text: sourceText }],
    },
  })
  expect(ownerA).toEqual([
    expect.objectContaining({
      session: hash('dsh-session', 'host-owner-a'),
      path: sources[0]!.relativePath,
      matchedLines: 3,
    }),
  ])
  expect(ownerB).toHaveLength(1)
})
