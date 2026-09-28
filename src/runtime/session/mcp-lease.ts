import type * as acp from '@agentclientprotocol/sdk'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'

/** A host capability scoped to one ACP connection and its active prompt. */
export interface AcpMcpLease {
  readonly signal: AbortSignal
  readonly instructions?: string
  readonly servers: readonly acp.McpServer[]
  /** Host-only evidence callback for a successful native teammate report in this prompt. */
  beginPrompt(signal: AbortSignal, onTeamReport?: () => void): void
  endPrompt(): void
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
  close(): Promise<void>
}
