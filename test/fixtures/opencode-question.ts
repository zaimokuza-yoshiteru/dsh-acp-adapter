import type * as acp from '@agentclientprotocol/sdk'

/** The tool update and elicitation captured from @opencode/cli 2.3.2. */
export function openCodeQuestionFixture(multiple = false) {
  const options = [
    { const: 'A', title: 'A', description: 'Use plan A' },
    { const: 'B', title: 'B', description: 'Use plan B' },
  ]
  const props = {
    q0: {
      title: 'Plan',
      description: 'Which plan should we use?',
      ...(multiple
        ? { type: 'array' as const, items: { anyOf: options } }
        : { type: 'string' as const, oneOf: options }),
    },
    q0_custom: {
      type: 'string' as const,
      title: 'Plan (other)',
      description: multiple ? 'Add your own answer' : 'Type your own answer',
    },
  }
  const tool = {
    toolCallId: 'question-call',
    name: 'question',
    rawInput: {
      questions: [
        {
          header: 'Plan',
          question: 'Which plan should we use?',
          options: [
            { label: 'A', description: 'Use plan A' },
            { label: 'B', description: 'Use plan B' },
          ],
          ...(multiple ? { multiple } : {}),
        },
      ],
    },
  } satisfies acp.ToolCallUpdate
  const request = {
    mode: 'form',
    sessionId: 'question-session',
    toolCallId: tool.toolCallId,
    message: 'Questions',
    requestedSchema: { type: 'object', properties: props, required: [] },
  } satisfies acp.CreateElicitationRequest
  return { tool, request }
}
