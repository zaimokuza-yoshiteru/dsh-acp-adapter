import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import { isDeepStrictEqual } from 'node:util'
import { HOOK_UNAVAILABLE, type AgyPreToolUseInput, type AgyPreToolUseReply } from '../process/agy-hook-wire.ts'

/** Official agy omits the ACP call ID from its hook. Only a unique live native command may enter policy. */
function matchAgyPreToolCall(calls: Iterable<ToolCallUpdate>, input: AgyPreToolUseInput): ToolCallUpdate | undefined {
  if (input.toolName !== 'run_command' || typeof input.args.CommandLine !== 'string') return undefined
  let match: ToolCallUpdate | undefined
  for (const call of calls) {
    if (
      call.kind !== 'execute' ||
      (call.name != null && call.name !== 'run_command') ||
      (call.status !== 'in_progress' && call.status !== 'pending') ||
      !call.toolCallId ||
      typeof call.rawInput !== 'object' ||
      call.rawInput === null ||
      Array.isArray(call.rawInput)
    )
      continue
    // toolSummary is CLI presentation metadata, not a run_command argument.
    const { toolSummary: _wireSummary, ...wire } = call.rawInput as Record<string, unknown>
    const { toolSummary: _hookSummary, ...args } = input.args
    if (!isDeepStrictEqual(wire, args)) continue
    if (match !== undefined) return undefined
    match = call
  }
  return match
}

/** A call ID is scoped to a single active prompt. Repeated callbacks share its pending audit and final answer. */
export class AgyPreToolCalls {
  private readonly prompts = new WeakMap<
    Map<string, ToolCallUpdate>,
    Map<string, { rawInput: unknown; reply: Promise<AgyPreToolUseReply> }>
  >()

  async decide(
    input: AgyPreToolUseInput,
    calls: Map<string, ToolCallUpdate>,
    signal: AbortSignal,
    evaluate: (sessionId: string, call: ToolCallUpdate, signal: AbortSignal) => Promise<AgyPreToolUseReply>,
  ): Promise<AgyPreToolUseReply> {
    if (signal.aborted) return HOOK_UNAVAILABLE
    const call = matchAgyPreToolCall(calls.values(), input)
    if (!call) return HOOK_UNAVAILABLE
    let decisions = this.prompts.get(calls)
    if (!decisions) {
      decisions = new Map()
      this.prompts.set(calls, decisions)
    }
    let cached = decisions.get(call.toolCallId)
    if (!cached) {
      cached = { rawInput: structuredClone(call.rawInput), reply: evaluate(input.sessionId, call, signal) }
      decisions.set(call.toolCallId, cached)
    }
    if (!isDeepStrictEqual(cached.rawInput, call.rawInput)) return HOOK_UNAVAILABLE
    const reply = await cached.reply
    return signal.aborted ? HOOK_UNAVAILABLE : reply
  }
}
