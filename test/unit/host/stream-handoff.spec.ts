import { expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { StreamHandoff } from '../../../src/host/composition/stream-handoff.ts'

it('keeps one pending pull across a native step and preserves later output once', async () => {
  const release = Promise.withResolvers<void>()
  const disposed = vi.fn()
  const handoff = new StreamHandoff()
  handoff.attach((async function* (): AsyncGenerator<StreamChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'before' }
      await release.promise
      yield { type: 'text-delta', index: 0, text: 'after' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { disposed() }
  })())
  const first = handoff.segment()
  expect((await first.next()).value).toMatchObject({ text: 'before' })
  const pending = first.next()
  handoff.request()
  expect((await pending).value).toMatchObject({ type: 'finish' })
  await first.return(undefined)
  expect(disposed).not.toHaveBeenCalled()
  release.resolve()
  const chunks = []
  for await (const chunk of handoff.segment()) chunks.push(chunk)
  expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'after' }, { type: 'finish', reason: { kind: 'stop' } }])
  expect(disposed).toHaveBeenCalledOnce()
})

it('cancels and drains a suspended execution when native admission rejects the next step', async () => {
  const release = Promise.withResolvers<void>()
  const handoff = new StreamHandoff()
  const disposed = vi.fn()
  handoff.cancel = () => release.resolve()
  handoff.attach((async function* (): AsyncGenerator<StreamChunk> {
    try { await release.promise; yield { type: 'finish', reason: { kind: 'stop' } } }
    finally { disposed() }
  })())
  const first = handoff.segment()
  const next = first.next()
  handoff.request()
  await next
  await first.return(undefined)
  await handoff.drain()
  expect(handoff.ended).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
})

it('finishes an image block before handing it to the native assembler', async () => {
  const handoff = new StreamHandoff()
  const block = { type: 'image', attachment: { id: 'image', mediaType: 'image/png' } } as const
  handoff.attach((async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'image' }
    yield { type: 'block-end', index: 0, block: block as never }
    yield { type: 'text-delta', index: 1, text: 'after image' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
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
  handoff.attach((async function* (): AsyncGenerator<StreamChunk> {
    await release.promise
    yield { type: 'text-delta', index: 3, text: 'old tail' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
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
