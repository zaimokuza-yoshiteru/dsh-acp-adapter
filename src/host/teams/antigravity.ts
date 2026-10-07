import type * as acp from '@agentclientprotocol/sdk'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const ANTIGRAVITY_DUPLICATE_MCP_TOOLS = new Set([
  'bash',
  'pwsh',
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'web_search',
  'web_fetch',
  'job_list',
  'job_output',
  'job_kill',
  'ask_user_question',
])

export function isAntigravityDuplicateTool(name: string): boolean {
  return ANTIGRAVITY_DUPLICATE_MCP_TOOLS.has(name) || name.startsWith('terminal_')
}

export function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export type AntigravityNativeToolName = 'bash' | 'read' | 'edit' | 'ask_question'

export function resolveAntigravityNativeTool(
  call: Pick<acp.ToolCallUpdate, 'kind' | 'name' | 'title' | 'rawInput'>,
): AntigravityNativeToolName | undefined {
  const input = toPlainRecord(call.rawInput)
  if (call.name === 'ask_question' || call.title === 'ask_question' || (input !== undefined && 'questions' in input)) {
    return 'ask_question'
  }
  if (call.kind === 'execute' || (input !== undefined && 'CommandLine' in input)) return 'bash'
  if (call.kind === 'read' || (input !== undefined && 'AbsolutePath' in input)) return 'read'
  if (call.kind === 'edit' || (input !== undefined && ('TargetFile' in input || 'TargetContent' in input))) return 'edit'
  return undefined
}

export interface DshQuestionItem {
  id: string
  question: string
  header?: string
  options?: { label: string }[]
  multi_select: boolean
}

export function parseAntigravityQuestions(args: unknown): DshQuestionItem[] {
  const input = toPlainRecord(args)
  if (input === undefined || !Array.isArray(input.questions)) return []
  return input.questions.map((raw, index) => {
    const q = toPlainRecord(raw)
    if (q === undefined) {
      return { id: `q${index + 1}`, question: '', multi_select: false }
    }
    const id = typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${index + 1}`
    const question = typeof q.question === 'string' ? q.question : ''
    const header = typeof q.header === 'string' ? q.header : undefined
    let options: { label: string }[] | undefined
    if (Array.isArray(q.options)) {
      options = q.options.map((opt) => {
        if (typeof opt === 'string') return { label: opt }
        const optRec = toPlainRecord(opt)
        return { label: String(optRec?.label ?? opt) }
      })
    }
    const multi_select =
      q.is_multi_select === true ||
      q.IsMultiSelect === true ||
      q.multi_select === true ||
      q.multiSelect === true
    return {
      id,
      question,
      ...(header !== undefined ? { header } : {}),
      ...(options !== undefined ? { options } : {}),
      multi_select,
    }
  })
}

function formatAnswers(answers: unknown): string | undefined {
  if (!Array.isArray(answers)) return undefined
  return answers
    .map((entry, index) => {
      const a = toPlainRecord(entry)
      const selected = Array.isArray(a?.selected) ? a.selected.map(String) : []
      const custom = typeof a?.custom === 'string' && a.custom.trim().length > 0 ? [a.custom.trim()] : []
      const chosen = [...selected, ...custom].join(', ')
      return `A${index + 1}: ${chosen}`
    })
    .join('\n')
}

export function formatAntigravityAskQuestionResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      const formatted = formatAnswers(toPlainRecord(parsed)?.answers)
      if (formatted !== undefined) return formatted
    } catch {
      return result
    }
    return result
  }
  if (typeof result !== 'object') return String(result)

  const directFormatted = formatAnswers(toPlainRecord(result)?.answers)
  if (directFormatted !== undefined) return directFormatted

  const record = result as Record<string, unknown>
  if (Array.isArray(record.content)) {
    const textBlocks = record.content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
    const first = textBlocks[0]
    if (first !== undefined) {
      try {
        const parsed = JSON.parse(first)
        const formatted = formatAnswers(toPlainRecord(parsed)?.answers)
        if (formatted !== undefined) return formatted
      } catch {
        return textBlocks.join('\n')
      }
      return textBlocks.join('\n')
    }
  }
  if (typeof record.text === 'string') return record.text
  return ''
}

export interface BridgedToolDefinition extends ToolDefinition {
  readonly underlyingName?: string
  executeBridged?(
    executeHost: (name: string, args: unknown) => Promise<unknown>,
    args: unknown,
  ): Promise<unknown>
}

const askQuestionDefinitions = new WeakMap<ToolDefinition, BridgedToolDefinition>()

export function createAntigravityAskQuestionDefinition(dshAskUser: ToolDefinition): BridgedToolDefinition {
  let existing = askQuestionDefinitions.get(dshAskUser)
  if (existing === undefined) {
    existing = {
      name: 'ask_question',
      underlyingName: 'ask_user_question',
      description: 'Use this tool to ask the user one or more multiple-choice questions.',
      parameters: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['question', 'options'],
              properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                is_multi_select: { type: 'boolean' },
              },
            },
          },
        },
      },
      output: dshAskUser.output,
      execute: dshAskUser.execute,
      async executeBridged(executeHost, args) {
        const hostResult = (await executeHost('ask_user_question', {
          questions: parseAntigravityQuestions(args),
        })) as Record<string, unknown>
        const text = formatAntigravityAskQuestionResult(hostResult)
        return {
          ...hostResult,
          content: [{ type: 'text' as const, text }],
        }
      },
    }
    askQuestionDefinitions.set(dshAskUser, existing)
  }
  return existing
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'number') return val
  }
  return undefined
}

export function normalizeAntigravityPresentation(
  rawInput: unknown,
  rawOutput: unknown,
  content: acp.ToolCallUpdate['content'],
  name: string,
): {
  rawInput: unknown
  rawOutput: unknown
  content: acp.ToolCallUpdate['content']
  title?: string
} {
  const input = toPlainRecord(rawInput)
  const output = toPlainRecord(rawOutput)
  let nextInput = rawInput
  let nextOutput = rawOutput
  let nextContent = content
  let title: string | undefined

  if (name === 'bash') {
    const command = firstString(input, ['command', 'CommandLine', 'command_line'])
    const cwd = firstString(input, ['cwd', 'Cwd', 'working_dir'])
    if (command !== undefined || cwd !== undefined) {
      nextInput = {
        ...(input ?? {}),
        ...(command !== undefined ? { command } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      }
    }
    if (command !== undefined && command.trim().length > 0) {
      title = command
    } else {
      const outCommand = firstString(output, ['commandLine', 'command'])
      if (outCommand !== undefined && outCommand.trim().length > 0) title = outCommand
    }
    const formatted_output = firstString(output, ['formatted_output', 'combinedOutput'])
    const exit_code = firstNumber(output, ['exit_code', 'exitCode'])
    if (formatted_output !== undefined || exit_code !== undefined) {
      nextOutput = {
        ...(output ?? {}),
        ...(formatted_output !== undefined ? { formatted_output } : {}),
        ...(exit_code !== undefined ? { exit_code, exitCode: exit_code } : {}),
      }
      if ((!Array.isArray(nextContent) || nextContent.length === 0) && formatted_output !== undefined) {
        nextContent = [{ type: 'content' as const, content: { type: 'text' as const, text: formatted_output } }]
      }
    }
  } else if (name === 'read') {
    const path = firstString(input, ['path', 'file_path', 'AbsolutePath', 'absolute_path'])
    if (path !== undefined) {
      nextInput = { ...(input ?? {}), path, file_path: path }
    }
  } else if (name === 'edit') {
    const path = firstString(input, ['path', 'file_path', 'TargetFile', 'target_file'])
    if (path !== undefined) {
      nextInput = { ...(input ?? {}), path, file_path: path }
    }
  } else if (name === 'ask_question') {
    if (output !== undefined && (!Array.isArray(nextContent) || nextContent.length === 0)) {
      const formatted = formatAntigravityAskQuestionResult(output)
      if (formatted.length > 0) {
        nextContent = [{ type: 'content' as const, content: { type: 'text' as const, text: formatted } }]
      }
    }
  }

  if (
    typeof nextOutput === 'string' &&
    /^(Encountered retryable error from model provider|Agent execution terminated due to error)/i.test(nextOutput)
  ) {
    nextOutput = undefined
  }

  return {
    rawInput: nextInput,
    rawOutput: nextOutput,
    content: nextContent,
    ...(title !== undefined ? { title } : {}),
  }
}
