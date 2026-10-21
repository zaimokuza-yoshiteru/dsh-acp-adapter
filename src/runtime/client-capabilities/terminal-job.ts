/** A terminal producer handed to the host's background-job registry. */
export interface AcpTerminalJobHooks {
  cancel(): void
  done: Promise<{
    status: 'completed' | 'killed' | 'failed'
    detail: string
  }>
}

/** Incremental output owned and retained by the host's native job registry. */
export type AcpTerminalJobOutput = (text: string, channel: 'stdout' | 'stderr') => void

export interface AcpTerminalJobHandle {
  cancel(): void
  /** ACP released its output handle; retire the native row only after settlement. */
  release(): void
}

/** Registration preflights admission before invoking the synchronous starter. */
export type AcpTerminalJobStarter = (
  label: string,
  run: (output: AcpTerminalJobOutput) => AcpTerminalJobHooks,
) => AcpTerminalJobHandle
