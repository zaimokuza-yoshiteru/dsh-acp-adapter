/** A terminal producer handed to the host's background-job registry. */
export interface AcpTerminalJobHooks {
  cancel(): void
  done: Promise<{
    status: 'completed' | 'killed' | 'failed'
    detail: string
    output: string
  }>
}

/** Registration preflights admission before invoking the synchronous starter. */
export type AcpTerminalJobStarter = (
  label: string,
  run: () => AcpTerminalJobHooks,
) => { cancel(): void }
