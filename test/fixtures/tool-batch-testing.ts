import type { ToolBatchInput, ToolBatchResult, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

type FakeToolResult = Pick<ToolExecutionResult, 'content'> & Partial<Omit<ToolExecutionResult, 'content'>>

/** Keep single-tool body fakes readable while exercising the public batch wire shape. */
export function fakeToolBatch(execute: (input: ToolExecutionInput) => Promise<FakeToolResult>) {
  return async (input: ToolBatchInput): Promise<ToolBatchResult> => {
    const results: ToolBatchResult['results'][number][] = []
    const additionalContexts: ToolBatchResult['additionalContexts'][number][] = []
    for (const call of input.calls) {
      const result = await execute({
        callId: call.id,
        name: call.name,
        arguments: JSON.parse(call.arguments),
        signal: input.signal,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
      })
      results.push({
        callId: call.id,
        result:
          result.isError === true
            ? { content: result.content, isError: true, error: result.error ?? { message: 'Fixture tool failed' } }
            : {
                content: result.content,
                value: result.value ?? null,
                isError: false,
                ...(result.concludesTurn === true ? { concludesTurn: true } : {}),
              },
      })
      additionalContexts.push(...(result.additionalContexts ?? []))
    }
    return { results, additionalContexts, concluded: results.some(({ result }) => result.concludesTurn === true) }
  }
}
