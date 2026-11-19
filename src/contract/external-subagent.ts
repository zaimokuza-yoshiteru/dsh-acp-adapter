/** Descriptor provider for local, read-only records of an external Agent's delegation. */
export const EXTERNAL_SUBAGENT_DESCRIPTOR_PROVIDER = 'dsh-acp-adapter'

export interface AcpExecutionView {
  /** Proven by this Session's own external-record descriptor, never an inherited prefix. */
  readonly externalSubagent: boolean
  /** Completed history with no recorded model request, including DeepSeek chat imports. */
  readonly completedWithoutModel?: true | undefined
  /** A claimed user input that the Agent has not received. */
  readonly unsentModelSwitch?: { readonly failureSeq: number } | undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    acpExecution: AcpExecutionView
  }
}
