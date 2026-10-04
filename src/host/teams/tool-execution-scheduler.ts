/** A session-local barrier for the ToolRuntime's native execution modes. */
export class ToolExecutionScheduler {
  private readonly waiting: Waiter[] = []
  private activeParallel = 0
  private activeExclusive = false

  acquire(classify: () => unknown, signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const waiter: Waiter = { classify, signal, resolve }
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        signal.removeEventListener('abort', waiter.onAbort!)
        resolve(undefined)
        this.drain()
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiting.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    if (this.activeExclusive) return
    while (this.waiting.length > 0) {
      const waiter = this.waiting[0]!
      if (waiter.signal.aborted) {
        this.waiting.shift()
        waiter.signal.removeEventListener('abort', waiter.onAbort!)
        waiter.resolve(undefined)
        continue
      }
      let mode: unknown
      try {
        mode = waiter.classify()
      } catch {
        mode = 'exclusive'
      }
      if (mode !== 'parallel') {
        if (this.activeParallel > 0) return
        this.waiting.shift()
        waiter.signal.removeEventListener('abort', waiter.onAbort!)
        this.activeExclusive = true
        waiter.resolve(this.once(this.releaseExclusive))
        return
      }
      this.waiting.shift()
      waiter.signal.removeEventListener('abort', waiter.onAbort!)
      this.activeParallel += 1
      waiter.resolve(this.once(this.releaseParallel))
    }
  }

  private once(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  private readonly releaseExclusive = (): void => {
    this.activeExclusive = false
    this.drain()
  }

  private readonly releaseParallel = (): void => {
    this.activeParallel -= 1
    this.drain()
  }
}

interface Waiter {
  readonly classify: () => unknown
  readonly signal: AbortSignal
  readonly resolve: (release: (() => void) | undefined) => void
  onAbort?: () => void
}
