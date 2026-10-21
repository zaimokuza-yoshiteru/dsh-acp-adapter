/** Descriptor provider for local, read-only records of an external Agent's delegation. */
export const EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER = 'dsh-acp-adapter'

export interface AcpExecutionView {
  /** Proven by this Session's own external-record descriptor, never an inherited prefix. */
  readonly externalSubagent: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    acpExecution: AcpExecutionView
  }
}
