import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, fileHandleText, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as McpContent } from '@modelcontextprotocol/sdk/types.js'
import { toAcpPrompt } from '../../domain/session/prompt-content.ts'

/** Preserve model-facing tool output; unsupported blocks are disclosed, never silently dropped. */
export async function toolContent(
  blocks: readonly ContentBlock[], signal: AbortSignal, imageEnabled: boolean,
  attachments?: Pick<AttachmentStore, 'readImage' | 'imageLimits'>,
): Promise<McpContent[]> {
  const normalized: ContentBlock[] = []
  const visit = (items: readonly ContentBlock[]): void => {
    for (const block of items) {
      if (block.type === 'text' || block.type === 'image') normalized.push(block)
      else if (block.type === 'file') normalized.push({ type: 'text', text: fileHandleText(block.attachment, undefined) })
      else normalized.push({ type: 'text', text: `[The DSH tool already executed, but this bridge cannot represent its ${block.type} output. Do not claim to have read that output.]` })
    }
  }
  visit(blocks)
  try {
    const resolved = await toAcpPrompt([createUserMessage({ source: { kind: 'user' }, content: normalized })], {
      signal, imageEnabled, ...(attachments === undefined ? {} : { attachments }),
    })
    return resolved.flatMap((item): McpContent[] => item.type === 'text' ? [{ type: 'text', text: item.text }]
      : item.type === 'image' ? [{ type: 'image', data: item.data, mimeType: item.mimeType }] : [])
  } catch {
    signal.throwIfAborted()
    return normalized.map(block => block.type === 'text' ? block
      : { type: 'text', text: '[The DSH tool already executed, but its image output is unavailable on this connection. Do not repeat the operation just to recover the image.]' })
  }
}
