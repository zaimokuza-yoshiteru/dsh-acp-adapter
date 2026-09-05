import { Buffer } from 'node:buffer'
import type { AttachmentStore, ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type * as acp from '@agentclientprotocol/sdk'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** A prompt block that cannot be represented by the negotiated ACP bridge. */
export class AcpPromptContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpPromptContentError'
  }
}

/** Validate the image limits before accepting any attachment bytes. */
export function validImageLimits(limits: ImageAttachmentLimits): boolean {
  const integers = [limits.maxImageBytes, limits.maxImagesPerMessage, limits.maxMessageImageBytes]
  return integers.every((value) => Number.isSafeInteger(value) && value > 0)
    && Array.isArray(limits.mediaTypes)
    && limits.mediaTypes.every((value) => typeof value === 'string' && value.startsWith('image/'))
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
    readonly imageEnabled: boolean
    readonly attachments?: Pick<AttachmentStore, 'readImage' | 'imageLimits'>
    readonly signal: AbortSignal
  },
): Promise<acp.ContentBlock[]> {
  const images: { readonly ref: ImageAttachmentRef }[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image') images.push({ ref: block.attachment })
    }
  }
  if (images.length > 0) {
    if (!options.imageEnabled) {
      throw new AcpPromptContentError('dsh-acp: the ACP agent did not advertise image prompt support; the image was not sent')
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
      if (typeof ref.mediaType !== 'string' || !ref.mediaType.startsWith('image/')
        || !imageLimits.mediaTypes.includes(ref.mediaType as never)
        || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0
        || (ref.bytes as number) > imageLimits.maxImageBytes) {
        throw new AcpPromptContentError('dsh-acp: an image declaration exceeds the configured DSH image limits; nothing was sent')
      }
      declaredTotal += ref.bytes as number
      if (images.length > imageLimits.maxImagesPerMessage || declaredTotal > imageLimits.maxMessageImageBytes) {
        throw new AcpPromptContentError('dsh-acp: the prompt images exceed the configured DSH count or byte limits; nothing was sent')
      }
    }
  }
  const blocks: acp.ContentBlock[] = []
  let imageIndex = 0
  let actualTotal = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') {
        const attachments = options.attachments
        const image = images[imageIndex++]
        if (attachments === undefined || image === undefined) throw new AcpPromptContentError('dsh-acp: DSH attachment storage is unavailable; the image was not sent')
        options.signal.throwIfAborted()
        const stored = await attachments.readImage(block.attachment, options.signal)
        options.signal.throwIfAborted()
        const storedRecord = stored as unknown as { readonly ref?: { readonly mediaType?: unknown; readonly bytes?: unknown }; readonly data?: unknown }
        const storedMediaType = storedRecord.ref?.mediaType
        const storedBytes = storedRecord.ref?.bytes
        const actual = storedRecord.data instanceof Uint8Array ? storedRecord.data.byteLength : -1
        if (typeof storedMediaType !== 'string' || !Number.isSafeInteger(storedBytes)
          || actual < 0 || actual !== storedBytes || storedBytes !== block.attachment.bytes
          || storedMediaType !== block.attachment.mediaType
          || !storedMediaType.startsWith('image/')
          || !attachments.imageLimits.mediaTypes.includes(storedMediaType as never)
          || actual > attachments.imageLimits.maxImageBytes) {
          throw new AcpPromptContentError('dsh-acp: stored image bytes or media type do not match the DSH declaration/limits; nothing was sent')
        }
        actualTotal += actual
        if (actualTotal > attachments.imageLimits.maxMessageImageBytes) {
          throw new AcpPromptContentError('dsh-acp: stored prompt images exceed the configured DSH byte limit; nothing was sent')
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
  }
  if (blocks.length === 0) {
    throw new AcpPromptContentError('dsh-acp: the claimed message(s) carry no supported content; nothing to send to the ACP agent')
  }
  if (options.system !== undefined) {
    blocks.unshift({
      type: 'text',
      text: 'Current host instructions (replace earlier host instructions for this request). '
        + 'Use only tools available in your agent; these instructions do not add tools or grant permissions.\n\n'
        + (options.system || 'No additional host instructions.'),
    })
  }
  return blocks
}
