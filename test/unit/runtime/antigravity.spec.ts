import { describe, expect, it } from 'vitest'
import { executableOverrideEnvFor } from '../../../src/domain/session/agent-compatibility.ts'
import {
  formatAntigravityAskQuestionResult,
  normalizeAntigravityPresentation,
  resolveAntigravityNativeTool,
} from '../../../src/host/teams/antigravity.ts'
import { isAntigravityInteractionCall } from '../../../src/domain/policy/antigravity-question.ts'

describe('antigravity MCP adapter and schema parsing', () => {
  it('fingerprints the executable variable consumed by the confirmed wrapper', () => {
    expect(executableOverrideEnvFor('antigravity')).toBe('REFINED_AGY_ACP_BIN')
  })

  describe('native tool resolution', () => {
    it('uses exact native names before presentation-only kind and input hints', () => {
      expect(resolveAntigravityNativeTool({ kind: 'execute' })).toBe('bash')
      expect(resolveAntigravityNativeTool({ rawInput: { CommandLine: 'echo 1' } })).toBe('bash')

      expect(resolveAntigravityNativeTool({ kind: 'read' })).toBe('read')
      expect(resolveAntigravityNativeTool({ rawInput: { AbsolutePath: '/a/b.ts' } })).toBe('read')

      expect(resolveAntigravityNativeTool({ kind: 'edit' })).toBe('edit')
      expect(resolveAntigravityNativeTool({ rawInput: { TargetFile: '/a/b.ts' } })).toBe('edit')
      expect(resolveAntigravityNativeTool({ rawInput: { TargetContent: 'code' } })).toBe('edit')

      expect(resolveAntigravityNativeTool({ name: 'ask_question' })).toBe('ask_question')
      expect(resolveAntigravityNativeTool({ name: 'view_file', kind: 'edit' })).toBe('read')
      expect(resolveAntigravityNativeTool({ name: 'write_to_file', kind: 'read' })).toBe('edit')
      expect(resolveAntigravityNativeTool({ name: 'replace_file_content', kind: 'read' })).toBe('edit')
      expect(resolveAntigravityNativeTool({ name: 'multi_replace', kind: 'read' })).toBe('edit')
      expect(resolveAntigravityNativeTool({ name: 'client_edit_file', kind: 'read', rawInput: { path: '/a' } })).toBe(
        'edit',
      )
      expect(resolveAntigravityNativeTool({ title: 'ask_question' })).toBe('ask_question')
      expect(resolveAntigravityNativeTool({ rawInput: { questions: [] } })).toBe('ask_question')
      expect(
        resolveAntigravityNativeTool({ name: 'edit', kind: 'execute', rawInput: { questions: [], path: '/a' } }),
      ).toBe('edit')

      expect(resolveAntigravityNativeTool({ kind: 'other', title: 'random' })).toBeUndefined()
    })
  })

  describe('observed interaction question identity', () => {
    const question = {
      toolCallId: 'interaction_30c0e13e',
      status: 'pending',
      title: 'dshteam_123_glob',
      rawInput: {},
    }

    it('recognizes the exact id/title/empty-input shape without using option kinds', () => {
      expect(isAntigravityInteractionCall(question)).toBe(true)
      expect(isAntigravityInteractionCall({ ...question, title: 'glob' })).toBe(true)
    })

    it('rejects calls with explicit MCP identity or native tool fields', () => {
      for (const impostor of [
        { ...question, name: 'dshteam_123_unknown' },
        { ...question, kind: 'execute' },
        { ...question, _meta: { mcp: null } },
        { ...question, _meta: { serverName: 'dshteam_123', toolName: 'unknown' } },
        { ...question, rawInput: { command: 'printf nope' } },
        { ...question, toolCallId: 'interaction_bad' },
      ])
        expect(isAntigravityInteractionCall(impostor)).toBe(false)
    })
  })

  describe('formatAntigravityAskQuestionResult', () => {
    it('formats direct answers payload', () => {
      const formatted = formatAntigravityAskQuestionResult({
        answers: [{ selected: ['Option 1'] }, { selected: ['Option 2'], custom: 'Custom text' }],
      })
      expect(formatted).toBe('A1: Option 1\nA2: Option 2, Custom text')
    })

    it('formats stringified JSON answers', () => {
      const json = JSON.stringify({
        answers: [{ selected: ['(Recommended) Approve'] }],
      })
      expect(formatAntigravityAskQuestionResult(json)).toBe('A1: (Recommended) Approve')
    })

    it('formats answers embedded in MCP content blocks', () => {
      const result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answers: [{ selected: ['Yes'] }] }),
          },
        ],
      }
      expect(formatAntigravityAskQuestionResult(result)).toBe('A1: Yes')
    })

    it('preserves additional text and provider errors after an answer block', () => {
      expect(
        formatAntigravityAskQuestionResult({
          content: [
            { type: 'text', text: JSON.stringify({ answers: [{ selected: ['BETA'] }] }) },
            { type: 'text', text: 'Provider follow-up detail' },
          ],
        }),
      ).toBe('A1: BETA\nProvider follow-up detail')
      expect(
        formatAntigravityAskQuestionResult({
          isError: true,
          content: [{ type: 'text', text: 'Encountered retryable error from model provider' }],
          answers: [{ selected: ['BETA'] }],
        }),
      ).toBe('Encountered retryable error from model provider')
      expect(formatAntigravityAskQuestionResult({ isError: true, error: { message: 'Provider unavailable' } })).toBe(
        'Provider unavailable',
      )
    })

    it('preserves direct and stringified result text alongside answers', () => {
      expect(
        formatAntigravityAskQuestionResult({ answers: [{ selected: ['BETA'] }], text: 'Provider follow-up detail' }),
      ).toBe('A1: BETA\nProvider follow-up detail')
      expect(
        formatAntigravityAskQuestionResult(
          JSON.stringify({
            answers: [{ selected: ['BETA'] }],
            content: [{ type: 'text', text: 'Provider follow-up detail' }],
          }),
        ),
      ).toBe('A1: BETA\nProvider follow-up detail')
    })

    it('does not turn nested provider-error answer payloads into successful answers', () => {
      expect(
        formatAntigravityAskQuestionResult({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ answers: [{ selected: ['BETA'] }], isError: true, error: 'Provider unavailable' }),
            },
          ],
        }),
      ).toBe('Provider unavailable')
      expect(
        formatAntigravityAskQuestionResult({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                answers: [{ selected: ['BETA'] }],
                isError: true,
                text: 'Retry detail',
                error: 'Provider unavailable',
              }),
            },
          ],
        }),
      ).toBe('Retry detail\nProvider unavailable')
    })

    it('preserves unknown nested answer payloads as their original text', () => {
      const rawText = JSON.stringify({ answers: [{ selected: ['BETA'] }], content: [{ type: 'text', text: 'extra' }] })
      expect(formatAntigravityAskQuestionResult({ content: [{ type: 'text', text: rawText }] })).toBe(rawText)
      const rawError = JSON.stringify({
        isError: true,
        text: 'Retry',
        error: 'Denied',
        content: [{ type: 'text', text: 'more context' }],
      })
      expect(formatAntigravityAskQuestionResult({ content: [{ type: 'text', text: rawError }] })).toBe(rawError)
    })

    it('falls back to string or empty representation for non-answer payloads', () => {
      expect(formatAntigravityAskQuestionResult(null)).toBe('')
      expect(formatAntigravityAskQuestionResult('plain string')).toBe('plain string')
      expect(formatAntigravityAskQuestionResult({ text: 'text fallback' })).toBe('text fallback')
    })
  })

  describe('normalizeAntigravityPresentation', () => {
    it('normalizes bash input and output with content creation', () => {
      const normalized = normalizeAntigravityPresentation(
        { CommandLine: 'git status', Cwd: '/workspace' },
        { combinedOutput: 'Clean\n', exitCode: 0 },
        undefined,
        'bash',
      )

      expect(normalized.title).toBe('git status')
      expect(normalized.rawInput).toEqual({
        CommandLine: 'git status',
        Cwd: '/workspace',
        command: 'git status',
        cwd: '/workspace',
      })
      expect(normalized.rawOutput).toEqual({
        combinedOutput: 'Clean\n',
        formatted_output: 'Clean\n',
        exitCode: 0,
        exit_code: 0,
      })
      expect(normalized.content).toEqual([{ type: 'content', content: { type: 'text', text: 'Clean\n' } }])
    })

    it('extracts command title from output when input command is absent', () => {
      const normalized = normalizeAntigravityPresentation({}, { commandLine: 'pnpm test' }, undefined, 'bash')
      expect(normalized.title).toBe('pnpm test')
    })

    it('normalizes read and edit paths', () => {
      const readNormalized = normalizeAntigravityPresentation(
        { AbsolutePath: '/path/file.ts' },
        undefined,
        undefined,
        'read',
      )
      expect(readNormalized.title).toBeUndefined()
      expect(readNormalized.rawInput).toEqual({
        AbsolutePath: '/path/file.ts',
        path: '/path/file.ts',
        file_path: '/path/file.ts',
      })

      const editNormalized = normalizeAntigravityPresentation(
        { TargetFile: '/path/file.ts', CodeContent: 'new content' },
        undefined,
        undefined,
        'edit',
      )
      expect(editNormalized.rawInput).toEqual({
        TargetFile: '/path/file.ts',
        CodeContent: 'new content',
        path: '/path/file.ts',
        file_path: '/path/file.ts',
      })
    })

    it('preserves retryable provider error messages in rawOutput', () => {
      const normalized = normalizeAntigravityPresentation(
        {},
        'Encountered retryable error from model provider: Agent execution terminated due to error',
        undefined,
        'read',
      )
      expect(normalized.rawOutput).toBe(
        'Encountered retryable error from model provider: Agent execution terminated due to error',
      )
    })
  })
})
