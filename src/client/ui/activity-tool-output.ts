/** ACP display content rendered as plain text in the native tool output surface. */
import { redactSecretText } from '../../contract/redaction.ts'
import type { AcpLocaleKey } from './locales.ts'

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

export interface ActivityToolOutputItem {
  readonly kind: 'text' | 'image' | 'audio' | 'resource' | 'diff' | 'terminal' | 'unknown'
  readonly text: string
}

export interface ActivityToolOutput {
  /** Ordered content atoms; equal kinds or equal text do not imply duplicate content. */
  readonly items: readonly ActivityToolOutputItem[]
  /** Plain text only: this is not Markdown, a link, or a saved DSH attachment reference. */
  readonly text: string
  /** Native read/diff/terminal cards do not render these resource descriptions themselves. */
  readonly hasUnrepresentedSupplement: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function metadata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = redactSecretText(value)
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/** Keep only inert, bounded location metadata; never expose payload URIs or credentials. */
function resourceUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  try {
    const uri = new URL(value)
    if (!['https:', 'http:', 'file:'].includes(uri.protocol)) return undefined
    uri.username = ''
    uri.password = ''
    uri.search = ''
    uri.hash = ''
    return metadata(uri.toString())
  } catch {
    return undefined
  }
}

function resourceMetadata(value: Record<string, unknown>): string {
  return [metadata(value.title) ?? metadata(value.name), metadata(value.mimeType), resourceUri(value.uri)]
    .filter((item): item is string => item !== undefined)
    .join(' · ')
}

function boundedText(value: string, t: Translate): string {
  const clean = redactSecretText(value)
  return clean.length > 4_096 ? `${clean.slice(0, 4_096)}\n${t('activity.output.truncated')}` : clean
}

function contentItems(value: unknown, t: Translate): ActivityToolOutputItem[] {
  if (Array.isArray(value)) return value.flatMap((item) => contentItems(item, t))
  if (!record(value)) return []
  if (value.type === 'content') return contentItems(value.content, t)
  if (value.type === 'text' && typeof value.text === 'string') return [{ kind: 'text', text: value.text }]
  if (value.type === 'image' || value.type === 'audio')
    return [
      {
        kind: value.type,
        text: t(value.type === 'image' ? 'activity.output.image' : 'activity.output.audio', {
          metadata: resourceMetadata(value),
        }),
      },
    ]
  if (value.type === 'resource_link')
    return [{ kind: 'resource', text: t('activity.output.resource', { metadata: resourceMetadata(value) }) }]
  if (value.type === 'resource' && record(value.resource)) {
    const resource = value.resource
    const description = resourceMetadata(resource)
    return [
      {
        kind: 'resource',
        text:
          typeof resource.text === 'string'
            ? `${t('activity.output.embeddedText', { metadata: description })}\n${boundedText(resource.text, t)}`
            : t('activity.output.binaryResource', { metadata: description }),
      },
    ]
  }
  if (value.type === 'diff')
    return [{ kind: 'diff', text: t('activity.output.diff', { path: metadata(value.path) ?? '' }) }]
  if (value.type === 'terminal')
    return [{ kind: 'terminal', text: t('activity.output.terminal', { id: metadata(value.terminalId) ?? '' }) }]
  if (typeof value.type === 'string')
    return [{ kind: 'unknown', text: t('activity.output.unknown', { type: metadata(value.type) ?? '' }) }]
  return []
}

function mcpContent(value: unknown): boolean {
  if (!record(value)) return false
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string'
    case 'image':
    case 'audio':
      return typeof value.mimeType === 'string' && typeof value.data === 'string'
    case 'resource_link':
      return typeof value.name === 'string' && typeof value.uri === 'string'
    case 'resource':
      return (
        record(value.resource) &&
        typeof value.resource.uri === 'string' &&
        (typeof value.resource.text === 'string' || typeof value.resource.blob === 'string')
      )
    default:
      return false
  }
}

/** Codex wraps MCP content in a transport result. Unwrap only its known shape:
 * unknown result fields and meaningful metadata/errors retain their raw view.
 * This is display decoding, never evidence of execution or a successful status.
 */
function mcpEnvelopeContent(value: unknown): readonly unknown[] | undefined {
  if (
    !record(value) ||
    value.error !== null ||
    Object.keys(value).some((key) => key !== 'result' && key !== 'error') ||
    !record(value.result)
  )
    return undefined
  const result = value.result
  if (
    Object.keys(result).some((key) => !['content', 'structuredContent', '_meta', 'isError'].includes(key)) ||
    result.structuredContent != null ||
    result._meta != null ||
    (result.isError !== undefined && typeof result.isError !== 'boolean') ||
    !Array.isArray(result.content) ||
    !result.content.every(mcpContent)
  )
    return undefined
  return result.content
}

function rawItems(value: unknown, t: Translate): ActivityToolOutputItem[] {
  const envelope = mcpEnvelopeContent(value)
  if (envelope !== undefined) return contentItems(envelope, t)
  const items = contentItems(record(value) && Array.isArray(value.content) ? value.content : value, t)
  if (items.length > 0) return items
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value === '' ? [] : [{ kind: 'text', text: value }]
  if ((Array.isArray(value) && value.length === 0) || (record(value) && Object.keys(value).length === 0)) return []
  try {
    const text = JSON.stringify(value)
    return text === undefined ? [] : [{ kind: 'text', text }]
  } catch {
    return [{ kind: 'unknown', text: t('activity.output.unknown', { type: '' }) }]
  }
}

export function joinActivityToolOutput(items: readonly ActivityToolOutputItem[]): string {
  let text = ''
  for (const item of items) {
    if (item.text === '') continue
    if (text !== '' && !text.endsWith('\n') && !item.text.startsWith('\n')) text += '\n'
    text += item.text
  }
  return text
}

/** ACP text content is the user-facing representation. Raw output is its fallback,
 * not a second copy; resource-only content still retains the raw textual result.
 * MCP raw results may themselves carry a content array or a known Codex envelope.
 * A dedicated native card must additionally render the returned resource atoms
 * inside the same tool row, because its body bypasses generic output text.
 */
export function activityToolOutput(
  rawOutput: unknown,
  content: unknown,
  t: Translate,
  terminal?: { readonly output?: string | undefined; readonly exitCode?: number | null | undefined },
): ActivityToolOutput {
  // The terminal projection already renders this protocol status as a native
  // exit badge. Only remove that exact standalone atom when its code is known.
  const display = contentItems(content, t).filter(
    (item) =>
      terminal?.exitCode === undefined ||
      terminal.exitCode === null ||
      item.kind !== 'text' ||
      item.text.trim() !== `Exited with code ${terminal.exitCode}`,
  )
  const hasDisplay = display.some((item) => item.text.trim() !== '')
  const hasText = display.some((item) => item.kind === 'text' && item.text.trim() !== '')
  const raw = !hasDisplay || !hasText ? rawItems(rawOutput, t) : []
  let items = !hasDisplay ? raw : hasText ? display : [...raw.filter((item) => item.kind === 'text'), ...display]
  // Shell stdout is already identified by the terminal projection. A provider
  // may add a separate display caption; that caption must not erase stdout.
  // Avoid adding stdout only when complete text atoms already represent it.
  const stdout = terminal?.output
  const textItems = items.filter((item) => item.kind === 'text')
  if (
    stdout !== undefined &&
    stdout !== '' &&
    !textItems.some((item) => item.text === stdout) &&
    joinActivityToolOutput(textItems) !== stdout
  )
    items = [{ kind: 'text', text: stdout }, ...items]
  return {
    items,
    text: joinActivityToolOutput(items),
    hasUnrepresentedSupplement: items.some((item) => item.kind !== 'text' && item.kind !== 'diff'),
  }
}
