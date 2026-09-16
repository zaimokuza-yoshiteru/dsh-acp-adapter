import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One ACP execution may span native steps; only the outer stream is handed back to DSH. */
export class StreamHandoff {
  resume: ((options: GenerateOptions) => Promise<boolean>) | undefined
  cancel: (() => void) | undefined
  private iterator: AsyncIterator<StreamChunk> | undefined
  private pending: Promise<IteratorResult<StreamChunk>> | undefined
  private pendingValue: IteratorResult<StreamChunk> | undefined
  private requested = false
  private wake: (() => void) | undefined
  private draining: Promise<void> | undefined
  private readonly incompleteBlocks = new Set<number>()
  private readonly remainder: StreamChunk[] = []
  suspended = false
  ended = false
  get closing(): boolean { return this.draining !== undefined }
  get pendingIndex(): number | undefined {
    const chunk = this.pendingValue?.value as StreamChunk | undefined
    return chunk !== undefined && 'index' in chunk ? chunk.index : undefined
  }

  attach(stream: AsyncIterable<StreamChunk>): void { this.iterator = stream[Symbol.asyncIterator]() }

  request(): void {
    if (this.ended) return
    this.requested = true
    this.wake?.()
  }

  private next(): Promise<IteratorResult<StreamChunk>> {
    return this.pending ??= this.iterator!.next().then(result => { this.pendingValue = result; return result })
  }

  async *segment(): AsyncGenerator<StreamChunk> {
    this.suspended = false
    try {
      while (!this.ended) {
        // Keep a single outstanding pull. Never race two consumers of the ACP stream.
        const changed = new Promise<'handoff'>(resolve => { this.wake = () => resolve('handoff') })
        const canHandoff = this.incompleteBlocks.size === 0
        const result = this.requested && canHandoff ? 'handoff'
          : canHandoff ? await Promise.race([this.next(), changed]) : await this.next()
        this.wake = undefined
        if (result === 'handoff') {
          this.requested = false
          this.suspended = true
          // The native loop commits this assistant segment, then owns pre-step,
          // input rewriting and user/message before resume is allowed to steer.
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        this.pending = undefined
        this.pendingValue = undefined
        if (result.done) { this.ended = true; return }
        if (result.value.type === 'block-start' && !['text', 'reasoning'].includes(result.value.blockType)) this.incompleteBlocks.add(result.value.index)
        if (result.value.type === 'block-end') this.incompleteBlocks.delete(result.value.index)
        if (result.value.type === 'finish') this.ended = true
        yield result.value
      }
    } finally {
      this.wake = undefined
      if (!this.suspended) await this.drain()
    }
  }

  /** Used when Stop, rejected admission or a route change leaves no next consumer. */
  drain(): Promise<void> {
    return this.draining ??= (async () => {
      this.cancel?.()
      try {
        for (;;) {
          const result = await this.next()
          this.pending = undefined
          this.pendingValue = undefined
          if (result.done) break
          this.remainder.push(result.value)
        }
      } finally { this.ended = true; this.suspended = false }
    })()
  }

  /** A fallback consumer must deliver buffered output before its replacement prompt. */
  takeRemainder(): StreamChunk[] { return this.remainder.splice(0) }
}
