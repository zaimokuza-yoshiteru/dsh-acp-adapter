import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { ReplySegments } from '../../../src/host/composition/reply-segments.ts'

it.each([
  { activityArrives: false, nextIndex: 4 },
  { activityArrives: true, nextIndex: 5 },
])('restores a held text segment unless an activity superseded it (activity: $activityArrives)', (testCase) => {
  const chunks: StreamChunk[] = []
  const reply = new ReplySegments(4, (chunk) => chunks.push(chunk))
  reply.text('before', 'answer')
  const restore = reply.holdSteeringBoundary()
  // The tool starts at the next insertion point without allocating a block.
  if (testCase.activityArrives) reply.breakContent()
  restore()
  reply.text('after', 'answer')
  expect(chunks).toEqual([
    { type: 'text-delta', index: 4, text: 'before' },
    { type: 'text-delta', index: testCase.nextIndex, text: 'after' },
  ])
})
