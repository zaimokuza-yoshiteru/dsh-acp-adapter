import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { expect, it } from 'vitest'
import { automaticHandoffInputDefinition } from '../../../src/client/ui/handoff-input-definition.ts'

function input(source: UserMessage['source']): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(1),
    time: 1,
    surfaceOp: 'append',
    data: createUserMessage({ source, content: [{ type: 'text', text: 'read_handoff_history' }] }),
  }
}

it.each(['summary', 'delivery'] as const)('claims only the automatic %s input in Chat', (part) => {
  const source = { kind: 'acp-handoff', part, operationId: 'transfer-id', launchIdentity: null } as const
  const current = input({ ...source, automatic: true })
  const classify = automaticHandoffInputDefinition.match['user/message']
  expect(classify(current)).toEqual({
    id: current.data.id,
    role: 'start',
    exclusive: true,
  })
  expect(automaticHandoffInputDefinition.buildViewNode()).toBeNull()
  expect(classify(input(source))).toBeNull()
  expect(classify(input({ kind: 'user' }))).toBeNull()
})
