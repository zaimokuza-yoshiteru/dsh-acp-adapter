/** Workspace navigation for an independent session requested by this conversation. */
export interface AcpCreatedAgentSession {
  readonly sessionId: string
  readonly agent: string
  readonly model: string
}
