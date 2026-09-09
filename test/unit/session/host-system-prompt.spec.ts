import { describe, expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { hostSystemPrompt } from '../../../src/domain/session/host-system-prompt.ts'

describe('native system prompt boundary', () => {
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'user input' }] })
  it('reads each finalized leading system value, including removal', () => {
    expect(hostSystemPrompt({ messages: [createSystemMessage('A', 'host'), user] })).toBe('A')
    expect(hostSystemPrompt({ messages: [createSystemMessage('B', 'host'), user] })).toBe('B')
    expect(hostSystemPrompt({ messages: [createSystemMessage('', 'host'), user] })).toBe('')
    expect(hostSystemPrompt({ messages: [user] })).toBe('')
  })
  it('preserves explicit one-shot prompt precedence and whitespace', () => {
    const messages = [createSystemMessage('history', 'host')]
    expect(hostSystemPrompt({ messages, system: '' })).toBe('')
    expect(hostSystemPrompt({ messages, system: '  override\n' })).toBe('  override\n')
    expect(hostSystemPrompt({ messages: [createSystemMessage(' \n ', 'host')] })).toBe(' \n ')
  })
  it('does not promote user input or a later system message on an incapable route', () => {
    expect(hostSystemPrompt({ messages: [user, createSystemMessage('late', 'host')] })).toBe('')
  })
})
