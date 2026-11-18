import type * as acp from '@agentclientprotocol/sdk'
import { isDeepStrictEqual } from 'node:util'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../contract/config-options.ts'

interface OpenCodeDeclaredModel {
  readonly context?: number
  readonly imageInput?: boolean
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Only read numeric limits and input modalities for the exact advertised ids.
 * Other OpenCode settings can include credentials and never leave this function. */
export function openCodeInlineModelFacts(
  content: string,
  models: ReadonlySet<string>,
): ReadonlyMap<string, OpenCodeDeclaredModel> {
  const result = new Map<string, OpenCodeDeclaredModel>()
  if (!content || content.length > 1_048_576) return result
  let config: unknown
  try {
    config = JSON.parse(content)
  } catch {
    return result
  }
  const providers = object(object(config)?.provider)
  if (!providers) return result
  for (const id of models) {
    const boundary = id.indexOf('/')
    if (id.length > ACP_CONFIG_IDENTIFIER_MAX || boundary < 1) continue
    const provider = object(providers[id.slice(0, boundary)])
    const model = object(object(provider?.models)?.[id.slice(boundary + 1)])
    const context = object(model?.limit)?.context
    const inputs = object(model?.modalities)?.input
    const modalities =
      Array.isArray(inputs) && inputs.length > 0 && inputs.every((x) => typeof x === 'string') ? inputs : undefined
    if (model)
      result.set(id, {
        ...(typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? { context } : {}),
        ...(modalities ? { imageInput: modalities.includes('image') } : {}),
      })
  }
  return result
}

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
  const schema = request.requestedSchema
  if (typeof schema !== 'object' || schema === null || !('properties' in schema)) return false
  const fields = schema.properties
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return false
  const fieldCount = Object.keys(fields).length
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
  return isDeepStrictEqual(schema, { type: 'object', properties, required: [] })
}
