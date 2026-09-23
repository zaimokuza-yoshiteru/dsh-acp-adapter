/** Diagnostic facts only; no connection capabilities or Agent credentials. */
export interface AcpPermissionCheck {
  readonly reason: 'auto-approved' | 'bridge-unavailable' | 'inactive-connection' | 'inactive-prompt' | 'identity-unmatched' | 'not-coordination' | 'allow-once-unavailable'
  readonly toolName?: string
  readonly identitySource?: 'codex-input' | 'name' | 'claude-meta' | 'devin-meta' | 'devin-title' | 'kimi-title'
  readonly structuredIdentityPresent?: boolean
  readonly titleMatchesCurrentTool?: boolean
}
