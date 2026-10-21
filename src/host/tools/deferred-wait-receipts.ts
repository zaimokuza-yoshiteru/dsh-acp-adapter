import { randomUUID } from 'node:crypto'
import type { AcpHostToolControlOutcome } from '../../contract/tool-control-outcome.ts'

export const DEFERRED_WAIT_META = 'zaimokuza.dsh/acp-control'
export const DEFERRED_WAIT_TEXT =
  'DSH_WAIT_DEFERRED_TEAM_MESSAGE: A Team message is already queued for this caller, so DSH did not execute wait_agent. End this ACP response now; DSH will deliver the queued message for you to handle.'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Scoped to one bridge prompt. Opaque receipts correlate actual replies, not
 * timestamps, arguments, provider labels, or MCP/ACP request-id coincidences. */
export class DeferredWaitReceipts {
  private readonly receipts = new Map<string, string | undefined>()
  private readonly claims = new Map<string, AcpHostToolControlOutcome>()
  private readonly receiptByCall = new Map<string, string>()

  constructor(
    private readonly dshSessionId: string,
    private readonly limit = 256,
  ) {}

  clear(): void {
    this.receipts.clear()
    this.claims.clear()
    this.receiptByCall.clear()
  }

  issue(): Record<string, string> | undefined {
    // Exhaustion loses only enhanced presentation; never evict a claimed
    // identity and then let a replay claim the same receipt again.
    if (this.receipts.size >= this.limit) return undefined
    const id = randomUUID()
    this.receipts.set(id, undefined)
    return { [DEFERRED_WAIT_META]: id }
  }

  observe(toolCallId: string, rawOutput: unknown): void {
    this.revoke(toolCallId)
    if (!toolCallId || !record(rawOutput) || rawOutput.error !== null) return
    if (Object.keys(rawOutput).some((key) => key !== 'result' && key !== 'error')) return
    const result = rawOutput.result
    if (
      !record(result) ||
      Object.keys(result).some((key) => !['content', 'structuredContent', '_meta', 'isError'].includes(key)) ||
      (result.structuredContent !== undefined && result.structuredContent !== null) ||
      (result.isError !== undefined && result.isError !== true) ||
      !record(result._meta) ||
      Object.keys(result._meta).length !== 1 ||
      !Array.isArray(result.content) ||
      result.content.length !== 1
    )
      return
    const content = result.content[0]
    if (
      !record(content) ||
      Object.keys(content).length !== 2 ||
      content.type !== 'text' ||
      content.text !== DEFERRED_WAIT_TEXT
    )
      return
    const receipt = result._meta[DEFERRED_WAIT_META]
    if (typeof receipt !== 'string' || !this.receipts.has(receipt)) return
    const claimedBy = this.receipts.get(receipt)
    if (claimedBy !== undefined && claimedBy !== toolCallId) return
    // One activity cannot adopt two different control replies.
    const previousReceipt = this.receiptByCall.get(toolCallId)
    if (previousReceipt !== undefined && previousReceipt !== receipt) return
    this.receipts.set(receipt, toolCallId)
    this.receiptByCall.set(toolCallId, receipt)
    this.claims.set(toolCallId, {
      source: 'dsh-tool-bridge',
      kind: 'deferred-team-message',
      dshSessionId: this.dshSessionId,
      toolCallId,
      tool: 'wait_agent',
      executed: false,
    })
  }

  outcome(toolCallId: string): AcpHostToolControlOutcome | undefined {
    return this.claims.get(toolCallId)
  }

  revoke(toolCallId: string): void {
    this.claims.delete(toolCallId)
  }
}
