import { describe, expect, it, vi } from 'vitest'
import { toolContent } from '../../../src/host/teams/tool-content.ts'

const image = { attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
const limits = { maxImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, maxImagesPerMessage: 4, maxMessageImageBytes: 2048, mediaTypes: ['image/png' as const] }
describe('native tool result conversion', () => {
  it('preserves text and durable images in order through MCP', async () => {
    const readImage = vi.fn().mockResolvedValue({ ref: image, data: Uint8Array.of(1, 2, 3) })
    expect(await toolContent([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: image },
      { type: 'text', text: 'after' },
    ], new AbortController().signal, true, { readImage, imageLimits: limits })).toEqual([
      { type: 'text', text: 'before' }, { type: 'image', data: 'AQID', mimeType: 'image/png' }, { type: 'text', text: 'after' },
    ])
  })
  it('retains text and explains missing images when total result limits are exceeded', async () => {
    const readImage = vi.fn()
    const result = await toolContent([{ type: 'text', text: 'Operation completed' }, { type: 'image', attachment: image }, { type: 'image', attachment: image }],
      new AbortController().signal, true, { readImage, imageLimits: { ...limits, maxImagesPerMessage: 1 } })
    expect(readImage).not.toHaveBeenCalled()
    expect(result[0]).toEqual({ type: 'text', text: 'Operation completed' })
    expect(JSON.stringify(result)).toContain('Do not repeat the operation')
  })
  it('propagates cancellation while attachment bytes are being read', async () => {
    const controller = new AbortController()
    const readImage = vi.fn(async () => { controller.abort(new Error('cancelled')); throw controller.signal.reason })
    await expect(toolContent([{ type: 'image', attachment: image }], controller.signal, true, { readImage, imageLimits: limits })).rejects.toThrow('cancelled')
  })
})
