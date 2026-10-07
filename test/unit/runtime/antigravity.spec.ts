import { describe, expect, it } from 'vitest'
import {
  formatAntigravityAskQuestionResult,
  isAntigravityDuplicateTool,
  normalizeAntigravityPresentation,
  parseAntigravityQuestions,
  resolveAntigravityNativeTool,
} from '../../../src/host/teams/antigravity.ts'

describe('antigravity MCP adapter and schema parsing', () => {
  describe('duplicate tool filtering', () => {
    it('identifies native Antigravity duplicate tools and terminal capabilities', () => {
      expect(isAntigravityDuplicateTool('bash')).toBe(true)
      expect(isAntigravityDuplicateTool('read')).toBe(true)
      expect(isAntigravityDuplicateTool('edit')).toBe(true)
      expect(isAntigravityDuplicateTool('web_search')).toBe(true)
      expect(isAntigravityDuplicateTool('ask_user_question')).toBe(true)
      expect(isAntigravityDuplicateTool('terminal_bash')).toBe(true)

      expect(isAntigravityDuplicateTool('glob')).toBe(false)
      expect(isAntigravityDuplicateTool('ask_question')).toBe(false)
      expect(isAntigravityDuplicateTool('custom_tool')).toBe(false)
    })
  })

  describe('native tool resolution', () => {
    it('resolves tool names from kind, name, title, or structured input', () => {
      expect(resolveAntigravityNativeTool({ kind: 'execute' })).toBe('bash')
      expect(resolveAntigravityNativeTool({ rawInput: { CommandLine: 'echo 1' } })).toBe('bash')

      expect(resolveAntigravityNativeTool({ kind: 'read' })).toBe('read')
      expect(resolveAntigravityNativeTool({ rawInput: { AbsolutePath: '/a/b.ts' } })).toBe('read')

      expect(resolveAntigravityNativeTool({ kind: 'edit' })).toBe('edit')
      expect(resolveAntigravityNativeTool({ rawInput: { TargetFile: '/a/b.ts' } })).toBe('edit')
      expect(resolveAntigravityNativeTool({ rawInput: { TargetContent: 'code' } })).toBe('edit')

      expect(resolveAntigravityNativeTool({ name: 'ask_question' })).toBe('ask_question')
      expect(resolveAntigravityNativeTool({ title: 'ask_question' })).toBe('ask_question')
      expect(resolveAntigravityNativeTool({ rawInput: { questions: [] } })).toBe('ask_question')

      expect(resolveAntigravityNativeTool({ kind: 'other', title: 'random' })).toBeUndefined()
    })
  })

  describe('parseAntigravityQuestions', () => {
    it('parses questions and maps to DSH format with default IDs and options', () => {
      const parsed = parseAntigravityQuestions({
        questions: [
          {
            question: 'Proceed?',
            options: ['Yes', 'No'],
            is_multi_select: false,
          },
          {
            id: 'custom_2',
            question: 'Which files?',
            options: [{ label: 'File A' }, { label: 'File B' }],
            IsMultiSelect: true,
          },
        ],
      })

      expect(parsed).toEqual([
        {
          id: 'q1',
          question: 'Proceed?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          multi_select: false,
        },
        {
          id: 'custom_2',
          question: 'Which files?',
          options: [{ label: 'File A' }, { label: 'File B' }],
          multi_select: true,
        },
      ])
    })

    it('handles empty or malformed inputs gracefully', () => {
      expect(parseAntigravityQuestions(null)).toEqual([])
      expect(parseAntigravityQuestions({})).toEqual([])
      expect(parseAntigravityQuestions({ questions: ['not an object'] })).toEqual([
        { id: 'q1', question: '', multi_select: false },
      ])
    })
  })

  describe('formatAntigravityAskQuestionResult', () => {
    it('formats direct answers payload', () => {
      const formatted = formatAntigravityAskQuestionResult({
        answers: [
          { selected: ['Option 1'] },
          { selected: ['Option 2'], custom: 'Custom text' },
        ],
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
      expect(normalized.content).toEqual([
        { type: 'content', content: { type: 'text', text: 'Clean\n' } },
      ])
    })

    it('extracts command title from output when input command is absent', () => {
      const normalized = normalizeAntigravityPresentation(
        {},
        { commandLine: 'pnpm test' },
        undefined,
        'bash',
      )
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

    it('strips spurious retryable provider error messages from rawOutput', () => {
      const normalized = normalizeAntigravityPresentation(
        {},
        'Encountered retryable error from model provider: Agent execution terminated due to error',
        undefined,
        'read',
      )
      expect(normalized.rawOutput).toBeUndefined()
    })
  })
})
