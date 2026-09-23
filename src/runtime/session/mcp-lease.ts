import type * as acp from '@agentclientprotocol/sdk'
import type { AcpPermissionCheck } from '../../domain/policy/permission-check.ts'

/** A host capability scoped to one ACP connection and its active prompt. */
export interface AcpMcpLease {
  readonly signal: AbortSignal
  readonly instructions?: string
  readonly servers: readonly acp.McpServer[]
  beginPrompt(signal: AbortSignal): void
  endPrompt(): void
  permission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse | undefined
  inspectPermission?(request: acp.RequestPermissionRequest): AcpPermissionCheck & { readonly response?: acp.RequestPermissionResponse }
  elicitation?(request: acp.CreateElicitationRequest, toolCall: acp.ToolCallUpdate | undefined): acp.CreateElicitationResponse | undefined
  elicitationToolName?(request: acp.CreateElicitationRequest, toolCall: acp.ToolCallUpdate | undefined): string | undefined
  presentTool?(toolCall: acp.ToolCallUpdate): acp.ToolCallUpdate
  close(): Promise<void>
}
