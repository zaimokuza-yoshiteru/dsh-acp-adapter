import type * as acp from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AcpDegradationAuditData, AcpDegradationItem } from '../../domain/policy/events.ts'
import { nonTextContentFallback, type AcpNonTextContent } from '../../domain/session/assistant-content.ts'

type DeltaKind = 'text' | 'reasoning'
type Segment = { kind: DeltaKind; index: number; messageId?: string } | { kind: 'steering' }

/** Allocate native blocks in ACP delivery order for one prompt. */
export class ReplySegments {
  private segment: Segment | undefined
  private readonly omissions: AcpDegradationItem[] = []
  private omissionsTruncated = false

  constructor(
    private nextIndex: number,
    private readonly emit: (chunk: StreamChunk) => void,
  ) {}

  get position(): number {
    return this.nextIndex
  }

  breakContent(): void {
    this.segment = undefined
  }

  /** Declined steering can rejoin the old delta only while this exact boundary
   * is untouched. Even an activity without a content block supersedes it. */
  holdSteeringBoundary(): () => void {
    const previous = this.segment
    const boundary = { kind: 'steering' } as const
    this.segment = boundary
    return () => {
      if (this.segment === boundary) this.segment = previous
    }
  }

  private delta(kind: DeltaKind, text: string, messageId?: string | null): void {
    if (
      this.segment?.kind !== kind ||
      (messageId != null && this.segment.messageId !== undefined && this.segment.messageId !== messageId)
    ) {
      this.segment = { kind, index: this.nextIndex++ }
    }
    if (messageId != null) this.segment.messageId = messageId
    this.emit({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: this.segment.index, text })
  }

  text(text: string, messageId?: string | null): void {
    this.delta('text', text, messageId)
  }

  thought(content: acp.ContentBlock, messageId?: string | null): void {
    if (content.type === 'text') {
      this.delta('reasoning', content.text, messageId)
      return
    }
    this.noteOmission(content.type, 'non-text ACP thought content was omitted from the safe reasoning preview')
    this.delta('reasoning', `[ACP ${content.type} reasoning content omitted.]`, messageId)
  }

  image(attachment: ImageAttachmentRef): void {
    this.breakContent()
    const index = this.nextIndex++
    this.emit({ type: 'block-start', index, blockType: 'image' })
    this.emit({ type: 'block-end', index, block: { type: 'image', attachment } })
  }

  fallback(content: AcpNonTextContent): void {
    this.breakContent()
    this.noteOmission(content.type, 'non-text ACP answer content was rendered with a safe text fallback')
    this.emit({ type: 'text-delta', index: this.nextIndex++, text: `\n\n${nonTextContentFallback(content)}\n\n` })
  }

  private noteOmission(type: string, reason: string): void {
    if (this.omissions.length < 32) this.omissions.push({ type, reason })
    else this.omissionsTruncated = true
  }

  get degradation(): AcpDegradationAuditData | undefined {
    if (this.omissions.length === 0) return undefined
    return {
      code: 'unsupported-chunk-content',
      items: this.omissions,
      keptPreviewChars: 0,
      truncated: this.omissionsTruncated,
    }
  }
}
