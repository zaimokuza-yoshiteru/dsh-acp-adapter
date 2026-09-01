export interface InstallGateArgs {
  hostRoot: string
  tgz: string | undefined
  skipBoot: boolean
  help: boolean
}

export interface AuthenticatedBootstrapResult {
  status: number
  body: string
}

export interface WaitForAuthenticatedBootstrapOptions {
  readOutput: () => string
  fetchImpl?: typeof fetch
  isAlive?: () => boolean
  timeoutMs?: number
  intervalMs?: number
}

export function parseArgs(argv: readonly string[]): InstallGateArgs
export function parseAuthenticatedStartupUrl(output: string): string | undefined
export function redactGateOutput(value: string): string
export function authenticatedBootstrap(launchUrl: string, fetchImpl?: typeof fetch): Promise<AuthenticatedBootstrapResult>
export function waitForAuthenticatedBootstrap(options: WaitForAuthenticatedBootstrapOptions): Promise<AuthenticatedBootstrapResult>
export function assertTarballEntries(entries: readonly string[]): void
export function assertComposedDump(dump: string): void
export function usage(): string
