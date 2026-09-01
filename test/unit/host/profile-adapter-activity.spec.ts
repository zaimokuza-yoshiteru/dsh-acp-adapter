import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import type { SessionLike } from '../../../src/domain/session/current-step-admission.ts'
import { createAcpSidecar, type AcpSidecar } from '../../../src/persistence/sidecar.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []
afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function testSidecar(root: string): AcpSidecar {
  const sidecar = createAcpSidecar({ root })
  sidecars.push(sidecar)
  return sidecar
}

const profile = (): AcpAgentConfig => ({ name: 'Activity test', command: 'agent', args: [], env: {} })
const claudeProfile = (): AcpAgentConfig => ({ name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, runtime: 'claude' })
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const session = (message: ReturnType<typeof user>): SessionLike => ({
  header: { cwd: os.tmpdir() },
  inheritedEventCount: 0,
  snapshotEvents: () => [{ type: 'step/start', seq: 1, data: { turn: 1, step: 0 } }, { type: 'user/message', seq: 2, data: message }],
})
const seam = (): { ok: true; seam: never } => ({ ok: true, seam: undefined as never })
const request = (id: string, message: ReturnType<typeof user>): GenerateOptions => markAgentLoopRequest({ provider: 'acp-test', model: 'model-a', sessionId: id as never, messages: [message] })

function ledgerFor(sidecar: AcpSidecar) {
  return {
    begin: (record: Parameters<NonNullable<AcpSidecar['beginDispatch']>>[0]) => sidecar.beginDispatch(record),
    settle: (sessionId: string, key: string) => sidecar.settleDispatch(sessionId as never, key),
    read: (sessionId: string, key: string) => sidecar.readDispatch(sessionId as never, key),
  }
}

describe('provider activity bridge', () => {
  it('ignores ACP available commands instead of registering stock slash commands', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-command-wiring-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('discover commands')
    const sessions = new Map<string, SessionLike>([['command-session', session(message)]])
    const register = vi.fn(() => vi.fn())
    const followup = vi.fn()
    const stockAgent = {
      ctx: { commands: { register } },
      followup,
    }
    const runtimeFactory = (options: { onSessionUpdate?: (notification: unknown) => void }): AcpProfileRuntime => ({
      acpSessionId: 'agent-command-session',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        const notification = {
          sessionId: 'agent-command-session',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: 'path or scope' } }],
          },
        }
        options.onSessionUpdate?.(notification)
        onUpdate({ sessionId: 'agent-command-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'activity', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory as never, sidecar, undefined,
      () => ({ userQuestions: {} as never, getAgent: () => stockAgent }),
    )
    for await (const _chunk of adapter.stream(request('command-session', message))) { /* drain */ }
    expect(register).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('stores ACP assistant images as native DSH blocks without reordering content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-native-image-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('show the image')
    const sessions = new Map<string, SessionLike>([['native-image-session', session(message)]])
    const imageRef = {
      attachmentId: 'sha256:test-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as never
    const saveImages = vi.fn(async (_inputs: readonly { mediaType: string; data: Uint8Array }[]) => [imageRef])
    const attachments = {
      imageLimits: {
        maxImageBytes: 1_000, maxImagesPerMessage: 10, maxMessageImageBytes: 10_000,
        maxImagePixels: 1_000, maxImageDimension: 100, mediaTypes: ['image/png'],
      },
      readImage: async () => { throw new Error('not used') },
      saveImages,
    }
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-native-image',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'agent-native-image', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } } } as never)
        onUpdate({ sessionId: 'agent-native-image', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AQ==' } } } as never)
        onUpdate({ sessionId: 'agent-native-image', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'native-image', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar, attachments as never,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('native-image-session', message))) chunks.push(chunk)
    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'text-delta', index: 0, text: 'before' },
      { type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: { type: 'image', attachment: imageRef } },
      { type: 'text-delta', index: 2, text: 'after' },
    ]))
    expect(chunks.map(chunk => (chunk as { type?: string }).type).slice(0, 4)).toEqual(['text-delta', 'block-start', 'block-end', 'text-delta'])
    const saved = saveImages.mock.calls[0]?.[0]?.[0] as { mediaType?: string; data?: Uint8Array } | undefined
    expect(saved?.mediaType).toBe('image/png')
    expect(Array.from(saved?.data ?? [])).toEqual([1])
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish') as { reason?: { kind?: string } } | undefined
    expect(finish?.reason?.kind).toBe('stop')
  })

  it('uses bounded visible fallbacks when non-text ACP output cannot be rendered', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-nontext-fallback-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('return resources')
    const sessions = new Map<string, SessionLike>([['nontext-session', session(message)]])
    const saveImages = vi.fn(async (_inputs: readonly { mediaType: string; data: Uint8Array }[]) => { throw new Error('image store unavailable') })
    const attachments = {
      imageLimits: {
        maxImageBytes: 1_000, maxImagesPerMessage: 10, maxMessageImageBytes: 10_000,
        maxImagePixels: 1_000, maxImageDimension: 100, mediaTypes: ['image/png'],
      },
      readImage: async () => { throw new Error('not used') },
      saveImages,
    }
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-nontext',
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'agent-nontext', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AQ==', uri: 'memory://image' } } } as never)
        onUpdate({ sessionId: 'agent-nontext', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO_BYTES' } } } as never)
        onUpdate({ sessionId: 'agent-nontext', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'report', mimeType: 'application/pdf', uri: 'https://example.test/report?token=super-secret-value' } } } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'resource', resource: { uri: 'memory://notes', mimeType: 'text/markdown', text: 'Visible embedded body\nsecond line' } },
          },
        } as never)
        onUpdate({
          sessionId: 'agent-nontext',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'resource', resource: { uri: 'memory://blob', mimeType: 'application/octet-stream', blob: 'SECRET_RESOURCE_BLOB' } },
          },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'nontext', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar, attachments as never,
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('nontext-session', message))) chunks.push(chunk)
    const visible = chunks
      .filter((chunk): chunk is { type: 'text-delta'; text: string } => (chunk as { type?: string }).type === 'text-delta')
      .map(chunk => chunk.text).join('')
    expect(visible).toContain('ACP image (image/png; memory://image)')
    expect(visible).toContain('ACP audio (audio/wav)')
    expect(visible).toContain('ACP resource: report (application/pdf)')
    expect(visible).toContain('ACP embedded text resource (text/markdown)')
    expect(visible).toContain('Visible embedded body\nsecond line')
    expect(visible).toContain('ACP embedded binary resource (application/octet-stream)')
    expect(visible).not.toContain('AQ==')
    expect(visible).not.toContain('SECRET_AUDIO_BYTES')
    expect(visible).not.toContain('super-secret-value')
    expect(visible).not.toContain('SECRET_RESOURCE_BLOB')
    const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish') as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'stop' })
  })

  it('projects visible fallbacks for a non-text Claude native child without leaking them into the root answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-claude-child-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('delegate this work')
    const sessions = new Map<string, SessionLike>([['claude-root', session(message)]])
    const projected: unknown[] = []
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'claude-agent-root', agentInfo: { name: 'claude-agent-acp', version: '1' }, agentCapabilities: {}, protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'claude-agent-root', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'claude-agent-child', name: 'Research', task: 'Inspect source', capabilities: {} } } as never)
        onUpdate({ sessionId: 'claude-agent-child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AQ==' } } } as never)
        onUpdate({ sessionId: 'claude-agent-child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO' } } } as never)
        onUpdate({ sessionId: 'claude-agent-child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'report', uri: 'https://example.test/child?token=secret' } } } as never)
        onUpdate({ sessionId: 'claude-agent-child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: { uri: 'memory://notes', mimeType: 'text/plain', text: 'child embedded text' } } } } as never)
        onUpdate({ sessionId: 'claude-agent-root', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'claude-agent-child', state: 'completed' } } as never)
        onUpdate({ sessionId: 'claude-agent-root', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root-visible result' } } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter(
      'claude', claudeProfile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar, undefined, undefined,
      async (observation) => { projected.push(observation); return 'projected-child-session' },
    )
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'acp-claude', model: 'claude-model', sessionId: 'claude-root' as never, messages: [message] }))) chunks.push(chunk)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'root-visible result' })
    const rootText = chunks.flatMap(chunk => typeof chunk === 'object' && chunk !== null && (chunk as { type?: unknown }).type === 'text-delta'
      ? [String((chunk as { text?: unknown }).text ?? '')] : []).join('')
    expect(rootText).toBe('root-visible result')
    expect(projected).toHaveLength(1)
    expect(projected[0]).toMatchObject({
      vendorDelegationKey: 'claude-agent-child',
      task: { text: 'Inspect source' },
      result: { completeness: 'final-output' },
      projectionEligible: true,
    })
    const projectedText = (projected[0] as { result: { text: string } }).result.text
    expect(projectedText).toContain('ACP image (image/png)')
    expect(projectedText).toContain('ACP audio (audio/wav)')
    expect(projectedText).toContain('ACP resource: report')
    expect(projectedText).toContain('ACP embedded text resource (text/plain)')
    expect(projectedText).toContain('child embedded text')
    expect(projectedText).not.toContain('AQ==')
    expect(projectedText).not.toContain('SECRET_AUDIO')
    expect(projectedText).not.toContain('token=secret')
  })

  it('journals ACP tool/content updates without creating DSH tool chunks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-adapter-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('inspect the project')
    const sessions = new Map<string, SessionLike>([['session-1', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => {
      let sessionId = 'agent-session-1'
      return {
        get acpSessionId() { return sessionId },
        agentInfo: { name: 'activity-agent', version: '1' },
        agentCapabilities: {},
        protocolVersion: 1,
        start: async () => undefined,
        prompt: async (_content, onUpdate) => {
          onUpdate({ sessionId: sessionId as never, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read project', name: 'read_file', kind: 'read', status: 'in_progress', rawInput: { path: '/tmp/project', apiKey: 'secret-value' }, locations: [{ path: '/tmp/project/app.ts', line: 1 }], content: [{ type: 'diff', path: '/tmp/project/app.ts', oldText: 'a', newText: 'b' }] } } as never)
          // ACP tool_call_update is a sparse patch.  In particular name:null
          // leaves the existing name unchanged and omitted content/locations
          // must survive the terminal frame.
          onUpdate({ sessionId: sessionId as never, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: null, status: 'completed', rawOutput: { result: 'ok' } } } as never)
          onUpdate({ sessionId: sessionId as never, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } as never)
          sessionId = 'agent-session-1'
          return { stopReason: 'end_turn' } as never
        },
        close: async () => undefined,
      }
    }
    const adapter = new AcpProfileAdapter('activity', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-1', message))) chunks.push(chunk)
    const activities = await sidecar.activitySnapshot('session-1' as never)
    expect(activities.map((item) => [item.activityId.slice(item.activityId.indexOf(':') + 1), item.kind, item.status])).toEqual([
      ['tool:tool-1', 'tool', 'completed'],
      ['tool:tool-1:0:diff', 'diff', 'completed'],
    ])
    expect(activities[0]?.activitySeq).toBe(1)
    expect(activities[1]?.activitySeq).toBe(2)
    expect(activities[0]?.rawDetail).not.toContain('secret-value')
    expect(activities[0]?.rawDetail).toContain('"toolKind":"read"')
    expect(activities[0]?.rawDetail).toContain('"toolName":"read_file"')
    expect(activities[0]?.rawDetail).toContain('"rawInput"')
    expect(activities[0]?.rawDetail).toContain('"rawOutput":{"result":"ok"}')
    expect(activities[0]?.rawDetail).toContain('"locations"')
    expect(activities[0]?.rawDetail).toContain('"content"')
    expect(chunks.filter((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'tool-call').length).toBe(0)
    const finish = chunks.find((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'finish') as { replayState?: { response?: { committedActivitySeq?: number } } } | undefined
    expect(finish?.replayState?.response?.committedActivitySeq).toBe(4)
  })

  it('uses a readable fallback for unknown ACP updates and does not block the turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-unknown-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('continue')
    const sessions = new Map<string, SessionLike>([['session-2', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-2', agentInfo: { name: 'activity-agent', version: '1' }, agentCapabilities: {}, protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'agent-session-2' as never, update: { sessionUpdate: 'vendor_progress', detail: 'working' } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter('activity', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-2', message))) chunks.push(chunk)
    expect(chunks.some((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'finish')).toBe(true)
    expect((await sidecar.activitySnapshot('session-2' as never))[0]?.presentation).toBe('Agent activity')
  })

  it('fails a successful ACP turn that emitted reasoning but no visible answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-reasoning-only-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Reply exactly RESPONSE_OK.')
    const sessions = new Map<string, SessionLike>([['session-reasoning-only', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-reasoning-only',
      agentInfo: { name: 'reasoning-only-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({
          sessionId: 'agent-session-reasoning-only' as never,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning RESPONSE_OK.' } },
        } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter('reasoning-only', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-reasoning-only', message))) chunks.push(chunk)
    expect(chunks.some((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'reasoning-delta')).toBe(true)
    const finish = chunks.find((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'finish') as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message: 'ACP agent completed without a visible response' } })
  })

  it('does not treat whitespace-only assistant chunks as a visible answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-whitespace-response-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('Reply exactly RESPONSE_OK.')
    const sessions = new Map<string, SessionLike>([['session-whitespace', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-whitespace',
      agentInfo: { name: 'whitespace-agent', version: '1' },
      agentCapabilities: {},
      protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'agent-session-whitespace' as never, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' \n\t ' } } } as never)
        onUpdate({ sessionId: 'agent-session-whitespace' as never, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning RESPONSE_OK.' } } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter('whitespace', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-whitespace', message))) chunks.push(chunk)
    const finish = chunks.find((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'finish') as { reason?: { kind?: string; failure?: { code?: string } } } | undefined
    expect(finish?.reason).toEqual({ kind: 'error', failure: { code: 'ACP_NO_VISIBLE_RESPONSE', message: 'ACP agent completed without a visible response' } })
  })

  it('ignores standard control frames and closes known children when terminal update has no content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-controls-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const message = user('run')
    const sessions = new Map<string, SessionLike>([['session-3', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-3', agentInfo: { name: 'activity-agent', version: '1' }, agentCapabilities: {}, protocolVersion: 1,
      start: async () => undefined,
      prompt: async (_content, onUpdate) => {
        onUpdate({ sessionId: 'agent-session-3' as never, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-3', title: 'Run', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-3' }] } } as never)
        onUpdate({ sessionId: 'agent-session-3' as never, update: { sessionUpdate: 'usage_update', used: 2 } } as never)
        onUpdate({ sessionId: 'agent-session-3' as never, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-3', status: 'completed' } } as never)
        onUpdate({ sessionId: 'agent-session-3' as never, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } } as never)
        return { stopReason: 'end_turn' } as never
      },
      close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter('activity', profile, seam(), id => sessions.get(id), ledgerFor(sidecar), undefined, runtimeFactory, sidecar)
    for await (const _ of adapter.stream(request('session-3', message))) { /* drain */ }
    const rows = await sidecar.activitySnapshot('session-3' as never)
    expect(rows.map((row) => [row.activityId.slice(row.activityId.indexOf(':') + 1), row.kind, row.status])).toEqual([
      ['tool:tool-3', 'tool', 'completed'],
      ['tool:tool-3:0:terminal', 'terminal', 'completed'],
    ])
    expect(rows[0]?.presentation).toBe('Run')
    expect(rows.some((row) => row.presentation === 'Agent activity')).toBe(false)
  })

  it('does not turn an activity-head read failure into recovery or a missing finish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-activity-head-'))
    roots.push(root)
    const sidecar = testSidecar(root)
    const failingSidecar = Object.create(sidecar) as AcpSidecar
    sidecars.push(failingSidecar)
    failingSidecar.activityHead = async () => { throw new Error('activity head unavailable') }
    const message = user('finish')
    const sessions = new Map<string, SessionLike>([['session-4', session(message)]])
    const runtimeFactory = (): AcpProfileRuntime => ({
      acpSessionId: 'agent-session-4', agentInfo: { name: 'activity-agent', version: '1' }, agentCapabilities: {}, protocolVersion: 1,
      start: async () => undefined, prompt: async () => ({ stopReason: 'end_turn' } as never), close: async () => undefined,
    })
    const adapter = new AcpProfileAdapter('activity', profile, seam(), id => sessions.get(id), ledgerFor(failingSidecar), undefined, runtimeFactory, failingSidecar)
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(request('session-4', message))) chunks.push(chunk)
    expect(chunks.some((chunk) => typeof chunk === 'object' && chunk !== null && 'type' in chunk && (chunk as { type?: unknown }).type === 'finish')).toBe(true)
    expect((await sidecar.readRecoveryState('session-4' as never))?.kind).toBe('healthy')
  })
})
