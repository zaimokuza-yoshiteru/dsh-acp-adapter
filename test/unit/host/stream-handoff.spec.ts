import { expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { StreamHandoff } from '../../../src/host/composition/stream-handoff.ts'

it('keeps one pending pull across a native step and preserves later output once', async () => {
  const release = Promise.withResolvers<void>()
  const disposed = vi.fn()
  const abandon = vi.fn()
  const handoff = new StreamHandoff()
  handoff.abandon = abandon
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      try {
        yield { type: 'text-delta', index: 0, text: 'before' }
        await release.promise
        yield { type: 'text-delta', index: 0, text: 'after' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        disposed()
      }
    })(),
  )
  const first = handoff.segment()
  expect((await first.next()).value).toMatchObject({ text: 'before' })
  const pending = first.next()
  handoff.request()
  expect((await pending).value).toMatchObject({ type: 'finish' })
  await first.return(undefined)
  expect(disposed).not.toHaveBeenCalled()
  expect(abandon).not.toHaveBeenCalled()
  release.resolve()
  const chunks = []
  for await (const chunk of handoff.segment()) chunks.push(chunk)
  expect(chunks).toEqual([
    { type: 'text-delta', index: 0, text: 'after' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  expect(disposed).toHaveBeenCalledOnce()
})

it('does not acknowledge a synthetic handoff finish as the cancelled response finish', async () => {
  const release = Promise.withResolvers<void>()
  const onTerminal = vi.fn()
  const handoff = new StreamHandoff()
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      await release.promise
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ACP_ABORTED', message: 'ACP prompt was cancelled' } },
      }
    })(),
  )

  const first = handoff.segment()
  await first.next()
  const pending = first.next()
  handoff.request()
  expect(await pending).toMatchObject({ value: { type: 'finish', reason: { kind: 'stop' } } })
  handoff.afterTerminalFinish(onTerminal)
  await handoff.acknowledgeTerminalFinish()
  expect(onTerminal).not.toHaveBeenCalled()

  await first.next()
  release.resolve()
  const resumed = handoff.segment()
  expect(await resumed.next()).toMatchObject({ value: { type: 'finish', reason: { kind: 'aborted' } } })
  await handoff.acknowledgeTerminalFinish()
  expect(onTerminal).toHaveBeenCalledOnce()
  await resumed.next()
})

it('cancels and drains a suspended execution when native admission rejects the next step', async () => {
  const release = Promise.withResolvers<void>()
  const handoff = new StreamHandoff()
  const disposed = vi.fn()
  const abandon = vi.fn()
  handoff.abandon = abandon
  handoff.cancel = () => release.resolve()
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      try {
        await release.promise
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        disposed()
      }
    })(),
  )
  const first = handoff.segment()
  const next = first.next()
  handoff.request()
  await next
  await first.return(undefined)
  await handoff.drain()
  expect(handoff.ended).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
  expect(abandon).not.toHaveBeenCalled()
})

it('abandons the settlement waiter only when a live consumer returns early', async () => {
  const release = Promise.withResolvers<void>()
  const handoff = new StreamHandoff()
  const abandon = vi.fn()
  handoff.abandon = abandon
  handoff.cancel = () => release.resolve()
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      await release.promise
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )

  const segment = handoff.segment()
  await expect(segment.next()).resolves.toMatchObject({ value: { text: 'answer' } })
  await segment.return(undefined)
  expect(abandon).toHaveBeenCalledOnce()
  expect(handoff.ended).toBe(true)
})

it('does not abandon the settlement waiter when the stream finishes normally', async () => {
  const handoff = new StreamHandoff()
  const abandon = vi.fn()
  handoff.abandon = abandon
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )

  for await (const _chunk of handoff.segment()) {
    /* consume the completed segment */
  }
  expect(abandon).not.toHaveBeenCalled()
  expect(handoff.ended).toBe(true)
})

it('suppresses only the exact local waiter-abandon reason while draining', async () => {
  const localAbandon = new DOMException('local waiter abandoned', 'AbortError')
  const local = new StreamHandoff()
  local.abandon = () => undefined
  local.localSettlementAbortReason = localAbandon
  local.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      throw localAbandon
    })(),
  )
  await expect(local.drainAfterAbandon()).resolves.toBeUndefined()

  const remoteFailure = new Error('remote stream failed')
  const failed = new StreamHandoff()
  failed.abandon = () => undefined
  failed.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      throw remoteFailure
    })(),
  )
  await expect(failed.drainAfterAbandon()).rejects.toBe(remoteFailure)

  const unproven = new StreamHandoff()
  unproven.abandon = () => undefined
  unproven.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      throw localAbandon
    })(),
  )
  await expect(unproven.drainAfterAbandon()).rejects.toBe(localAbandon)
})

it('finishes an image block before handing it to the native assembler', async () => {
  const handoff = new StreamHandoff()
  const block = { type: 'image', attachment: { id: 'image', mediaType: 'image/png' } } as const
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'image' }
      yield { type: 'block-end', index: 0, block: block as never }
      yield { type: 'text-delta', index: 1, text: 'after image' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  const first = handoff.segment()
  const assembler = new BlockAssembler()
  assembler.push((await first.next()).value!)
  handoff.request()
  for await (const chunk of first) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([block])
  const next = new BlockAssembler()
  for await (const chunk of handoff.segment()) next.push(chunk)
  expect(next.blocks()).toEqual([{ type: 'text', text: 'after image' }])
})

it('retains a completed pending tail for a fallback consumer exactly once', async () => {
  const release = Promise.withResolvers<void>()
  const handoff = new StreamHandoff()
  handoff.attach(
    (async function* (): AsyncGenerator<StreamChunk> {
      await release.promise
      yield { type: 'text-delta', index: 3, text: 'old tail' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  const first = handoff.segment()
  const pending = first.next()
  handoff.request()
  await pending
  await first.return(undefined)
  release.resolve()
  await handoff.drain()
  expect(handoff.takeRemainder()).toEqual([
    { type: 'text-delta', index: 3, text: 'old tail' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  expect(handoff.takeRemainder()).toEqual([])
})
