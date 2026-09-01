import { describe, expect, it } from 'vitest'
import { ExternalDelegationNormalizer } from '../../../src/domain/subagent/external-delegation.ts'

describe('external delegation normalizer', () => {
  it('normalizes a complete live Devin lifecycle and rejects completion without its start', () => {
    const normalizer = new ExternalDelegationNormalizer('devin')
    expect(normalizer.accept({ toolCallId: 'tool-1', _meta: { 'cognition.ai/subagent_completed': { agentId: 'child-1', success: true, summary: 'done' } } }, 20)).toBeUndefined()
    normalizer.accept({ toolCallId: 'tool-1', _meta: { 'cognition.ai/subagent_started': { agentId: 'child-1', title: 'Research', task: 'Find it' } } }, 100)
    expect(normalizer.accept({ toolCallId: 'tool-1', _meta: { 'cognition.ai/subagent_completed': { agentId: 'child-1', success: true, summary: 'done' } } }, 250)).toMatchObject({
      profileKind: 'devin', vendorDelegationKey: 'child-1', projectionEligible: true,
      task: { text: 'Find it', source: 'vendor-meta' },
      result: { text: 'done', completeness: 'summary' },
      timing: { observedStartedAt: 100, observedCompletedAt: 250 },
    })
  })

  it('normalizes Claude structured task/result/model/usage from one live lifecycle', () => {
    const normalizer = new ExternalDelegationNormalizer('claude')
    normalizer.accept({ toolCallId: 'call-1', title: 'Task', rawInput: { description: 'Check', prompt: 'Do work' }, _meta: { claudeCode: { subagent: true } } }, 10)
    expect(normalizer.accept({ toolCallId: 'call-1', _meta: { claudeCode: { toolResponse: {
      status: 'completed', agentId: 'agent-1', prompt: 'Do work', content: [{ type: 'text', text: 'DONE' }],
      resolvedModel: 'model-x', totalDurationMs: 50, totalTokens: 12,
      usage: { input_tokens: 8, output_tokens: 4 },
    } } } }, 70)).toMatchObject({
      profileKind: 'claude', projectionEligible: true, model: { id: 'model-x' },
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      result: { text: 'DONE', completeness: 'final-output' },
    })
  })

  it('normalizes every Claude native child content block in order with bounded visible fallbacks', () => {
    const normalizer = new ExternalDelegationNormalizer('claude')
    expect(normalizer.acceptNotification({
      sessionId: 'root-agent-session',
      update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-agent-session', name: 'Research', task: 'Inspect source', capabilities: { cancel: true } },
    }, 10)).toBeUndefined()
    expect(normalizer.acceptNotification({
      sessionId: 'child-agent-session',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } },
    }, 20)).toBeUndefined()
    expect(normalizer.acceptNotification({
      sessionId: 'child-agent-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } },
    }, 30)).toBeUndefined()
    const childBlocks = [
      { type: 'image', mimeType: 'image/png', data: 'AQ==', uri: 'memory://child-image?token=secret' },
      { type: 'text', text: 'middle' },
      { type: 'audio', mimeType: 'audio/wav', data: 'SECRET_AUDIO' },
      { type: 'resource_link', name: 'child report', mimeType: 'application/pdf', uri: 'https://example.test/report?token=secret' },
      { type: 'resource', resource: { uri: 'memory://notes', mimeType: 'text/plain', text: 'embedded child text' } },
      { type: 'resource', resource: { uri: 'memory://blob', mimeType: 'application/octet-stream', blob: 'SECRET_BLOB' } },
      { type: 'text', text: 'after' },
    ]
    for (const [index, content] of childBlocks.entries()) expect(normalizer.acceptNotification({
      sessionId: 'child-agent-session', update: { sessionUpdate: 'agent_message_chunk', content },
    }, 31 + index)).toBeUndefined()
    const completed = normalizer.acceptNotification({
      sessionId: 'root-agent-session',
      update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-agent-session', state: 'completed' },
    }, 50)
    expect(completed).toMatchObject({
      profileKind: 'claude', vendorDelegationKey: 'child-agent-session', projectionEligible: true,
      task: { text: 'Inspect source', source: 'vendor-meta' },
      result: { source: 'verbatim-child-final', completeness: 'final-output' },
      timing: { observedStartedAt: 10, observedCompletedAt: 50 },
    })
    const result = completed?.result.text ?? ''
    const ordered = [
      'before', 'ACP image (image/png; memory://child-image)', 'middle', 'ACP audio (audio/wav)',
      'ACP resource: child report (application/pdf)', 'ACP embedded text resource (text/plain)',
      'embedded child text', 'ACP embedded binary resource (application/octet-stream)', 'after',
    ]
    let cursor = -1
    for (const item of ordered) {
      const next = result.indexOf(item, cursor + 1)
      expect(next, `missing or reordered child result item: ${item}`).toBeGreaterThan(cursor)
      cursor = next
    }
    expect(result).not.toContain('AQ==')
    expect(result).not.toContain('SECRET_AUDIO')
    expect(result).not.toContain('SECRET_BLOB')
    expect(result).not.toContain('token=secret')
  })

  it('keeps Kimi Activity-only until its live/load identity collision gate passes', () => {
    const normalizer = new ExternalDelegationNormalizer('kimi')
    normalizer.accept({ toolCallId: '0:tool-x', title: 'Launching plan agent: Check', status: 'in_progress', rawInput: { prompt: 'Do work', description: 'Check' } }, 10)
    expect(normalizer.accept({ toolCallId: '0:tool-x', status: 'completed', rawOutput: 'agent_id: agent-0\nstatus: completed\n\nDONE' }, 50)).toMatchObject({
      profileKind: 'kimi', projectionEligible: false, vendorDelegationKey: '0:tool-x',
    })
  })

  it('does not infer a Codex task/result from child identity or wait metadata', () => {
    const normalizer = new ExternalDelegationNormalizer('codex')
    expect(normalizer.accept({ _meta: { codex: { subagent: { threadId: 'child', activity: 'started' } } } }, 1)).toBeUndefined()
    expect(normalizer.accept({ status: 'completed', _meta: { codex: { collaboration: { tool: 'wait' } } } }, 2)).toBeUndefined()
  })
})
