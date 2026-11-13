import { Buffer } from 'node:buffer'
import type { AttachmentStore, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type * as acp from '@agentclientprotocol/sdk'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ModelContextSnapshot } from './model-context-snapshots.ts'
import { generatedContextBlock, generatedContextSeparator } from '../../runtime/text-block-boundary.ts'

/** A prompt block that cannot be represented by the negotiated ACP bridge. */
export class AcpPromptContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpPromptContentError'
  }
}

/** The skill route available in this exact model request. */
export type SkillRoute = 'direct' | 'ptc' | 'disabled'

/** Resolve the route from the final tool presentation for the current request. */
export function skillRouteForTools(tools: readonly { readonly name: string }[] | undefined): SkillRoute {
  if (tools?.some((tool) => tool.name === 'skill') === true) return 'direct'
  if (tools?.some((tool) => tool.name === 'run_code') === true) return 'ptc'
  return 'disabled'
}

/**
 * Restore DSH-owned instructions only when explicitly creating a blank remote
 * session. The frozen request projection is authoritative: retain its ordered
 * baseline, replacement and removal messages without reading shadowed history
 * or replaying ordinary users. Already admitted messages are excluded.
 */
export function reboundAgentInstructions(
  admitted: readonly UserMessage[],
  projected: readonly RequestMessage[],
): readonly UserMessage[] {
  const seen = new Set(admitted.map((message) => String(message.id)))
  const instructions: UserMessage[] = []
  const eligible = projected.filter((message): message is UserMessage => {
    if (message.role !== 'user' || typeof message.id !== 'string' || message.id.length === 0) return false
    const source: unknown = message.source
    return (
      typeof source === 'object' &&
      source !== null &&
      'kind' in source &&
      source.kind === 'agent-instructions' &&
      'form' in source &&
      source.form === 'instructions' &&
      message.content.length > 0 &&
      message.content.every((block) => block.type === 'text' && typeof block.text === 'string')
    )
  })
  for (const message of eligible) {
    if (seen.has(String(message.id))) continue
    seen.add(String(message.id))
    instructions.push(message)
  }
  return instructions
}

const UNDELIVERED_HISTORY_MAX_CHARS = 60_000
const UNDELIVERED_ENTRY_MAX_CHARS = 12_000

/**
 * Conversation the Agent never received: turns answered by another plugin on
 * this route, or input from a first turn that failed before an Agent session
 * existed. Only for the first prompt of a session with no ACP history. Text is
 * carried as context; the newest entries win when the bound is reached.
 */
export function undeliveredHistoryText(
  admitted: readonly UserMessage[],
  projected: readonly RequestMessage[],
): string | undefined {
  const current = new Set(admitted.map((message) => String(message.id)))
  const entries: string[] = []
  for (const message of projected) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'user') {
      if (current.has(String(message.id))) continue
      const kind = (message.source as { readonly kind?: unknown } | undefined)?.kind
      // Host instructions and context snapshots are re-supplied through their own channels.
      if (kind === 'agent-instructions' || kind === 'runtime-context' || kind === 'skill-catalog') continue
    }
    const parts: string[] = []
    for (const block of message.content as readonly { readonly type: string; readonly text?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
      else if (block.type === 'image' || block.type === 'file') parts.push(`[${block.type} attachment not included]`)
    }
    if (parts.length === 0) continue
    const text = parts.join('\n')
    entries.push(
      `[${message.role === 'user' ? 'User' : 'Assistant'}]\n${
        text.length > UNDELIVERED_ENTRY_MAX_CHARS ? `${text.slice(0, UNDELIVERED_ENTRY_MAX_CHARS)}… [truncated]` : text
      }`,
    )
  }
  if (entries.length === 0) return undefined
  const kept: string[] = []
  let size = 0
  for (const entry of entries.toReversed()) {
    if (size + entry.length > UNDELIVERED_HISTORY_MAX_CHARS && kept.length > 0) break
    kept.unshift(entry)
    size += entry.length
  }
  const omitted = entries.length - kept.length
  return [
    'Earlier messages of this DSH conversation that were not delivered to you. They are context only; answer the current request that follows.',
    ...(omitted === 0 ? [] : [`[${String(omitted)} earlier message(s) omitted]`]),
    ...kept,
  ].join('\n\n')
}

const PTC_SKILL_ROUTE_NOTICE =
  'For any instruction above to call `skill`, use only `tools.skill(...)` inside `run_code` through its generated SDK; do not call `skill` as a standalone tool. This note adds no tools or permissions.'
const DISABLED_SKILL_ROUTE_NOTICE =
  'DSH Skill route for this request: no direct `skill` or PTC `run_code` entry point is available. Do not call either tool or rely on older DSH skill names.'
const UNAVAILABLE_SKILL_CATALOG_NOTICE =
  'DSH Skill catalog is omitted because the `skill` tool is not available in this Agent scope; do not apply older DSH skill names.'

function isSkillCatalogMessage(message: UserMessage): boolean {
  const source: unknown = message.source
  return typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'skill-catalog'
}

function isGeneratedModelContextMessage(message: UserMessage): boolean {
  const source: unknown = message.source
  return (
    typeof source === 'object' &&
    source !== null &&
    'kind' in source &&
    (source.kind === 'runtime-context' || source.kind === 'skill-catalog')
  )
}

/** Validate the image limits before accepting any attachment bytes. */
export function validImageLimits(limits: ImageAttachmentLimits): boolean {
  const integers = [limits.maxImageBytes, limits.maxImagesPerMessage, limits.maxMessageImageBytes]
  return (
    integers.every((value) => Number.isSafeInteger(value) && value > 0) &&
    Array.isArray(limits.mediaTypes) &&
    limits.mediaTypes.every((value) => typeof value === 'string' && value.startsWith('image/'))
  )
}

/**
 * Resolve claimed DSH messages into ordered ACP prompt blocks. Images are read
 * only through DSH's durable attachment service; UI paths and arbitrary file
 * URLs are never trusted as attachment bytes.
 */
export async function toAcpPrompt(
  messages: readonly UserMessage[],
  options: {
    /** ACP has no system role. Supply the host's current instructions as
     * explicitly labelled request context, including an empty replacement. */
    readonly system?: string
    /** Current DSH-owned model context snapshots, already source-allow-listed. */
    readonly modelContextSnapshots?: readonly ModelContextSnapshot[]
    /** Effective frozen request history, supplied only for an explicit blank rebind. */
    readonly reboundAgentInstructions?: readonly RequestMessage[]
    /** Effective frozen request history, supplied only when starting an Agent session over undelivered conversation. */
    readonly undeliveredHistory?: readonly RequestMessage[]
    /** Route exposed by the final tool presentation for this model request. */
    readonly skillRoute?: SkillRoute
    /** Whether the current Agent scope has the Skill tool used by either route. */
    readonly skillCatalogAvailable?: boolean
    readonly imageEnabled: boolean
    readonly attachments?: Pick<AttachmentStore, 'readImage' | 'imageLimits'>
    readonly signal: AbortSignal
  },
): Promise<acp.ContentBlock[]> {
  const skillRoute = options.skillRoute ?? 'direct'
  const snapshots = options.modelContextSnapshots ?? []
  const skillCatalogAvailable =
    options.skillCatalogAvailable ?? snapshots.some((snapshot) => snapshot.source === 'skill-catalog')
  const skillCatalogReferenced =
    messages.some(isSkillCatalogMessage) || snapshots.some((snapshot) => snapshot.source === 'skill-catalog')
  const canDeliverSkillCatalog = skillCatalogAvailable && skillRoute !== 'disabled'
  const admittedMessages = messages.filter((message) => !isSkillCatalogMessage(message) || canDeliverSkillCatalog)
  const images: { readonly ref: ImageAttachmentRef }[] = []
  for (const message of admittedMessages) {
    for (const block of message.content) {
      if (block.type === 'image') images.push({ ref: block.attachment })
    }
  }
  if (images.length > 0) {
    if (!options.imageEnabled) {
      throw new AcpPromptContentError(
        'dsh-acp: the ACP agent did not advertise image prompt support; the image was not sent',
      )
    }
    const attachments = options.attachments
    if (attachments === undefined) {
      throw new AcpPromptContentError('dsh-acp: DSH attachment storage is unavailable; the image was not sent')
    }
    if (!validImageLimits(attachments.imageLimits)) {
      throw new AcpPromptContentError('dsh-acp: DSH image limits are unavailable or invalid; the image was not sent')
    }
    const { imageLimits } = attachments
    let declaredTotal = 0
    for (const image of images) {
      const ref = image.ref as { readonly mediaType?: unknown; readonly bytes?: unknown }
      if (
        typeof ref.mediaType !== 'string' ||
        !ref.mediaType.startsWith('image/') ||
        !imageLimits.mediaTypes.includes(ref.mediaType as never) ||
        !Number.isSafeInteger(ref.bytes) ||
        (ref.bytes as number) < 0 ||
        (ref.bytes as number) > imageLimits.maxImageBytes
      ) {
        throw new AcpPromptContentError(
          'dsh-acp: an image declaration exceeds the configured DSH image limits; nothing was sent',
        )
      }
      declaredTotal += ref.bytes as number
      if (images.length > imageLimits.maxImagesPerMessage || declaredTotal > imageLimits.maxMessageImageBytes) {
        throw new AcpPromptContentError(
          'dsh-acp: the prompt images exceed the configured DSH count or byte limits; nothing was sent',
        )
      }
    }
  }
  const blocks: acp.ContentBlock[] = []
  let imageIndex = 0
  let actualTotal = 0
  for (const message of admittedMessages) {
    const generatedModelContext = isGeneratedModelContextMessage(message)
    const messageBlockStart = blocks.length
    for (const block of message.content) {
      // Native settlement notices embed the child's whole assistant output. ACP has no
      // reasoning input block; keep the closing answer without promoting private thoughts to text.
      if (message.source.kind === 'subagent-settled' && block.type === 'reasoning') continue
      if (block.type === 'text') {
        blocks.push({
          type: 'text',
          text: block.text,
        })
        continue
      }
      if (block.type === 'image') {
        const attachments = options.attachments
        const image = images[imageIndex++]
        if (attachments === undefined || image === undefined)
          throw new AcpPromptContentError('dsh-acp: DSH attachment storage is unavailable; the image was not sent')
        options.signal.throwIfAborted()
        const stored = await attachments.readImage(block.attachment, options.signal)
        options.signal.throwIfAborted()
        const storedRecord = stored as unknown as {
          readonly ref?: { readonly mediaType?: unknown; readonly bytes?: unknown }
          readonly data?: unknown
        }
        const storedMediaType = storedRecord.ref?.mediaType
        const storedBytes = storedRecord.ref?.bytes
        const actual = storedRecord.data instanceof Uint8Array ? storedRecord.data.byteLength : -1
        if (
          typeof storedMediaType !== 'string' ||
          !Number.isSafeInteger(storedBytes) ||
          actual < 0 ||
          actual !== storedBytes ||
          storedBytes !== block.attachment.bytes ||
          storedMediaType !== block.attachment.mediaType ||
          !storedMediaType.startsWith('image/') ||
          !attachments.imageLimits.mediaTypes.includes(storedMediaType as never) ||
          actual > attachments.imageLimits.maxImageBytes
        ) {
          throw new AcpPromptContentError(
            'dsh-acp: stored image bytes or media type do not match the DSH declaration/limits; nothing was sent',
          )
        }
        actualTotal += actual
        if (actualTotal > attachments.imageLimits.maxMessageImageBytes) {
          throw new AcpPromptContentError(
            'dsh-acp: stored prompt images exceed the configured DSH byte limit; nothing was sent',
          )
        }
        blocks.push({
          type: 'image',
          data: Buffer.from(storedRecord.data as Uint8Array).toString('base64'),
          mimeType: storedMediaType,
        })
        continue
      }
      throw new AcpPromptContentError(
        `dsh-acp: cannot represent a "${block.type}" prompt block on the negotiated ACP connection; nothing was sent`,
      )
    }
    if (isSkillCatalogMessage(message) && skillRoute === 'ptc')
      blocks.push({ type: 'text', text: generatedContextBlock(PTC_SKILL_ROUTE_NOTICE) })
    if (generatedModelContext && blocks.length > messageBlockStart) {
      blocks.splice(messageBlockStart, 0, { type: 'text', text: generatedContextSeparator })
      blocks.push({ type: 'text', text: generatedContextSeparator })
    }
  }
  if (blocks.length === 0) {
    throw new AcpPromptContentError(
      'dsh-acp: the claimed message(s) carry no supported content; nothing to send to the ACP agent',
    )
  }
  if (options.undeliveredHistory !== undefined) {
    const history = undeliveredHistoryText(admittedMessages, options.undeliveredHistory)
    if (history !== undefined) blocks.unshift({ type: 'text', text: generatedContextBlock(history) })
  }
  if (options.reboundAgentInstructions !== undefined) {
    const instructions = reboundAgentInstructions(admittedMessages, options.reboundAgentInstructions)
    const instructionBlocks: acp.ContentBlock[] = []
    for (const message of instructions) {
      instructionBlocks.push({ type: 'text', text: generatedContextSeparator })
      for (const block of message.content) {
        if (block.type === 'text') instructionBlocks.push({ type: 'text', text: block.text })
      }
      instructionBlocks.push({ type: 'text', text: generatedContextSeparator })
    }
    blocks.unshift(...instructionBlocks)
  }
  if (options.system !== undefined) {
    blocks.unshift({
      type: 'text',
      text: generatedContextBlock(
        'Current host instructions (replace earlier host instructions for this request). ' +
          'Use only tools available in your agent; these instructions do not add tools or grant permissions.\n\n' +
          (options.system || 'No additional host instructions.'),
      ),
    })
  }
  const currentIds = new Set(admittedMessages.map((message) => String(message.id)))
  if (options.modelContextSnapshots !== undefined) {
    const snapshotsByKind = new Map(
      snapshots
        .filter((snapshot) => snapshot.source !== 'skill-catalog' || canDeliverSkillCatalog)
        .map((snapshot) => [snapshot.source, snapshot]),
    )
    const contextLines = (['runtime-context', 'skill-catalog'] as const)
      .map((kind) => {
        if (kind === 'skill-catalog' && !canDeliverSkillCatalog && skillCatalogReferenced) return ''
        const snapshot = snapshotsByKind.get(kind)
        if (snapshot === undefined) {
          return `${kind}: no current snapshot; do not apply older DSH ${kind === 'skill-catalog' ? 'skill names' : 'context'}.`
        }
        if (snapshot.id !== undefined && currentIds.has(snapshot.id))
          return `${kind}: current replacement snapshot is already present in this request.`
        const route = kind === 'skill-catalog' && skillRoute === 'ptc' ? `\n\n${PTC_SKILL_ROUTE_NOTICE}` : ''
        return `[${kind}]\n${snapshot.text}${route}`
      })
      .filter((line) => line !== '')
    blocks.unshift({
      type: 'text',
      text: generatedContextBlock(
        [
          'Complete current DSH model context projection. This replaces earlier DSH runtime-context and skill-catalog projections for this ACP session; it does not add tools or permissions:',
          ...contextLines,
        ].join('\n\n'),
      ),
    })
  }
  if (skillCatalogReferenced && !canDeliverSkillCatalog) {
    const notice = skillRoute === 'disabled' ? DISABLED_SKILL_ROUTE_NOTICE : UNAVAILABLE_SKILL_CATALOG_NOTICE
    blocks.unshift({ type: 'text', text: generatedContextBlock(notice) })
  }
  return blocks
}
