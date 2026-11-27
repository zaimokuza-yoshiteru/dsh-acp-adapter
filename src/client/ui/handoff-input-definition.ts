import type { ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '../../contract/handoff.ts'

/** Hide the adapter's automatic model instructions from Chat. Their original events remain available in Trajectory. */
export const automaticHandoffInputDefinition = {
  kind: 'acp-automatic-handoff-input',
  target: 'chat',
  match: {
    'user/message'(event) {
      if (event.type !== 'user/message' || event.surfaceOp !== 'append') return null
      const source = event.data.source
      if (source.kind !== 'acp-handoff' || source.automatic !== true || typeof source.operationId !== 'string')
        return null
      return source.part === 'summary' || source.part === 'delivery'
        ? { id: String(event.data.id), role: 'start', exclusive: true }
        : null
    },
  },
  start: () => null,
  update: () => null,
  buildViewNode: () => null,
} satisfies ConversationNodeDefinitionInput<null>
