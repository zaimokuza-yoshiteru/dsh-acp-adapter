import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Read the host's effective prompt before current-step input filtering.
 * ACP does not declare in-history system updates: DSH normalizes its system
 * surface to the leading message. An empty prompt explicitly clears the
 * previously transmitted host instructions on the external conversation. */
export function hostSystemPrompt(options: Pick<GenerateOptions, 'system' | 'messages'>): string {
  if (options.system !== undefined) return options.system
  const system = options.messages[0]
  if (system?.role !== 'system') return ''
  return system.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
