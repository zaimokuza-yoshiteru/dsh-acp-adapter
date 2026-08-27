import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AcpPromptContentError, toAcpPrompt, validImageLimits } from '../../../src/domain/session/prompt-content.ts'

const limits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 4096,
  maxImagePixels: 1024,
  maxImageDimension: 1024,
  mediaTypes: ['image/png'],
} as const

const text = (value: string) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })

describe('prompt content conversion', () => {
  it('preserves text ordering and reads durable images into ACP blocks', async () => {
    const image = { attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const readImage = vi.fn().mockResolvedValue({ ref: image, data: Uint8Array.of(1, 2, 3) })

    await expect(toAcpPrompt([
      text('before'),
      createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } }),
      text('after'),
    ], { imageEnabled: true, attachments: { readImage, imageLimits: limits }, signal: new AbortController().signal })).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'after' },
    ])
    expect(readImage).toHaveBeenCalledWith(image, expect.any(AbortSignal))
  })

  it('rejects image input before reading when the negotiated capability or local store is missing', async () => {
    const image = { attachmentId: 'att-2' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } })
    await expect(toAcpPrompt([message], { imageEnabled: false, signal: new AbortController().signal })).rejects.toBeInstanceOf(AcpPromptContentError)
    await expect(toAcpPrompt([message], { imageEnabled: true, signal: new AbortController().signal })).rejects.toThrow('attachment storage is unavailable')
  })

  it('enforces aggregate declaration limits and validates stored bytes before producing a prompt', async () => {
    const first = { attachmentId: 'att-a' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const second = { attachmentId: 'att-b' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const message = createUserMessage({ content: [{ type: 'image', attachment: first }], source: { kind: 'user' } })
    await expect(toAcpPrompt([message], {
      imageEnabled: true,
      attachments: { readImage: vi.fn(), imageLimits: { ...limits, maxMessageImageBytes: 2 } },
      signal: new AbortController().signal,
    })).rejects.toThrow('prompt images exceed')
    await expect(toAcpPrompt([createUserMessage({ content: [
      { type: 'image', attachment: first },
      { type: 'image', attachment: second },
    ], source: { kind: 'user' } })], {
      imageEnabled: true,
      attachments: { readImage: vi.fn(), imageLimits: { ...limits, maxImagesPerMessage: 1 } },
      signal: new AbortController().signal,
    })).rejects.toThrow('prompt images exceed')

    const mismatched = vi.fn().mockResolvedValue({ ref: { ...first, bytes: 4 }, data: Uint8Array.of(1, 2, 3, 4) })
    await expect(toAcpPrompt([message], { imageEnabled: true, attachments: { readImage: mismatched, imageLimits: limits }, signal: new AbortController().signal })).rejects.toThrow('stored image bytes')
  })

  it('rejects empty and unsupported content, and validates limit shape', async () => {
    await expect(toAcpPrompt([createUserMessage({ content: [], source: { kind: 'user' } })], { imageEnabled: true, signal: new AbortController().signal })).rejects.toThrow('no supported content')
    expect(validImageLimits(limits)).toBe(true)
    expect(validImageLimits({ ...limits, maxImageBytes: 0 })).toBe(false)
    expect(validImageLimits({ ...limits, mediaTypes: ['text/plain'] as never })).toBe(false)
  })
})
