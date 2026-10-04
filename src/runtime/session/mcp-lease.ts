import type * as acp from '@agentclientprotocol/sdk'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'

export type AcpHostSettlementFailure =
  | 'ACP_HOST_CALL_DRAIN_TIMEOUT'
  | 'ACP_HOST_TOOL_RECONCILIATION_REQUIRED'
  | 'ACP_HOST_TOOL_NOT_DISPATCHED'
  | 'ACP_HOST_GENERATION_STILL_ACTIVE'
  | 'ACP_HOST_FEEDBACK_COMMIT_FAILED'

export class AcpHostSettlementError extends Error {
  readonly code: AcpHostSettlementFailure
  readonly remoteOutcomeKnown: boolean | undefined
  readonly remoteResponse: acp.PromptResponse | undefined
  constructor(
    code: AcpHostSettlementFailure,
    options?: {
      readonly remoteOutcomeKnown?: boolean
      readonly remoteResponse?: acp.PromptResponse
    },
  ) {
    super(code)
    this.code = code
    this.remoteOutcomeKnown = options?.remoteOutcomeKnown
    this.remoteResponse = options?.remoteResponse
    this.name = 'AcpHostSettlementError'
  }
}

/** A host capability scoped to one ACP connection and its active prompt. */
export interface AcpMcpLease {
  readonly signal: AbortSignal
  /** Run-local HMAC alias exposed only to the opt-in live-test trace sink. */
  readonly diagnosticLeaseId?: string
  readonly instructions?: string
  readonly servers: readonly acp.McpServer[]
  /** Host-only evidence callback for a successful native teammate report in this prompt. */
  beginPrompt(
    signal: AbortSignal,
    onTeamReport?: () => void,
    adapterPromptOrdinal?: number,
    onTurnConcluded?: () => void,
    bodySignal?: AbortSignal,
    onSuccessfulToolResult?: () => void,
  ): void
  endPrompt(options?: {
    readonly stopReason?: string
    readonly externallyAborted?: boolean
    readonly remoteOutcomeKnown?: boolean
  }): void
  /** Wait for the generation just closed by endPrompt; it never admits new work. */
  drainPrompt?(): Promise<void>
  /** Retry only locally retained feedback; never reexecute the Host tool. */
  flushHostFeedback?(): Promise<void>
  hasPendingCalls?(): boolean
  hasUncommittedFeedback?(): boolean
  hasRetainedFeedback?(): boolean
  waitForCallsSettled?(): Promise<void>
  permission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse | undefined> | acp.RequestPermissionResponse | undefined
  inspectPermission?(
    request: acp.RequestPermissionRequest,
  ):
    | Promise<AcpPermissionCheck & { readonly response?: acp.RequestPermissionResponse }>
    | (AcpPermissionCheck & { readonly response?: acp.RequestPermissionResponse })
  /** Revalidate the captured decision after audit I/O without resolving policy again. */
  validatePermissionDecision?(request: acp.RequestPermissionRequest): boolean
  elicitation?(
    request: acp.CreateElicitationRequest,
    toolCall: acp.ToolCallUpdate | undefined,
  ): Promise<acp.CreateElicitationResponse | undefined> | acp.CreateElicitationResponse | undefined
  elicitationToolName?(
    request: acp.CreateElicitationRequest,
    toolCall: acp.ToolCallUpdate | undefined,
  ): string | undefined
  presentTool?(toolCall: acp.ToolCallUpdate): acp.ToolCallUpdate
  close(graceMs?: number): Promise<void>
}
