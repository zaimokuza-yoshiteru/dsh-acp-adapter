import type * as acp from '@agentclientprotocol/sdk'
import { isDeepStrictEqual } from 'node:util'

/** OpenCode 2's question tool expands each prompt into a select and a custom
 * answer carrier. Recognize only its exact projection of the live tool input. */
export function isOpenCodeQuestion(
  agentName: string | undefined,
  request: acp.CreateElicitationRequest,
  tool: acp.ToolCallUpdate | undefined,
): boolean {
  if (
    agentName !== 'OpenCode' ||
    request.mode !== 'form' ||
    request._meta?.codex_approval_kind !== undefined ||
    !('toolCallId' in request) ||
    tool?.name !== 'question' ||
    request.toolCallId !== tool.toolCallId
  )
    return false
  const input = tool.rawInput
  if (typeof input !== 'object' || input === null || !('questions' in input) || !Array.isArray(input.questions))
    return false
  const fieldCount = Object.keys(request.requestedSchema?.properties ?? {}).length
  if (fieldCount === 0 || fieldCount !== 2 * input.questions.length) return false
  const properties: Record<string, unknown> = {}
  for (const [index, prompt] of input.questions.entries()) {
    if (
      typeof prompt?.header !== 'string' ||
      typeof prompt.question !== 'string' ||
      !Array.isArray(prompt.options) ||
      prompt.options.length === 0 ||
      !prompt.options.every(
        (option: { label?: unknown; description?: unknown } | null) =>
          typeof option?.label === 'string' && typeof option.description === 'string',
      )
    )
      return false
    const options = prompt.options.map((option: { label: string; description: string }) => ({
      const: option.label,
      title: option.label,
      description: option.description,
    }))
    const name = `q${index}`
    const multi = prompt.multiple === true
    properties[name] = {
      title: prompt.header,
      description: prompt.question,
      ...(multi ? { type: 'array', items: { anyOf: options } } : { type: 'string', oneOf: options }),
    }
    properties[`${name}_custom`] = {
      type: 'string',
      title: `${prompt.header} (other)`,
      description: multi ? 'Add your own answer' : 'Type your own answer',
    }
  }
  return isDeepStrictEqual(request.requestedSchema, { type: 'object', properties, required: [] })
}
