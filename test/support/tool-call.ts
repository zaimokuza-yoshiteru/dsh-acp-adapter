import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Run one tool call through the selected executor and return its settled result.
 * Tests that assert a single call's outcome use this instead of the batch shape.
 * @param ctx - context owning the selected tool executor.
 * @param input - call identity, raw JSON arguments, optional Agent and signal.
 * @returns the single settled result.
 */
export async function executeSingleTool(
  ctx: Context,
  input: {
    readonly callId: ToolCallId
    readonly name: string
    readonly arguments: unknown
    readonly agent?: Agent
    readonly signal?: AbortSignal
  },
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: input.callId,
        name: input.name,
        arguments: JSON.stringify(input.arguments ?? {}),
      },
    ],
    signal: input.signal ?? new AbortController().signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  })
  const settled = batch.results[0]
  if (settled === undefined) throw new Error('selected executor returned no tool result')
  return settled.result
}
