import type * as acp from '@agentclientprotocol/sdk'

/** A host capability scoped to one ACP connection and its active prompt. */
export interface AcpMcpLease {
  readonly signal: AbortSignal
  readonly instructions?: string
  readonly servers: readonly acp.McpServer[]
  beginPrompt(signal: AbortSignal): void
  endPrompt(): void
  permission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse | undefined
  elicitation?(request: acp.CreateElicitationRequest, toolCall: acp.ToolCallUpdate | undefined): acp.CreateElicitationResponse | undefined
  presentTool?(toolCall: acp.ToolCallUpdate): acp.ToolCallUpdate
  close(): Promise<void>
}
