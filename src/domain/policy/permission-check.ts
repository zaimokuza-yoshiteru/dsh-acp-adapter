/** Diagnostic facts only; no connection capabilities or Agent credentials. */
export interface AcpPermissionCheck {
  readonly reason:
    | 'approval-required'
    | 'bridge-unavailable'
    | 'inactive-connection'
    | 'inactive-prompt'
    | 'identity-unmatched'
    | 'invalid-tool-name'
  readonly toolName?: string
  readonly identitySource?:
    | 'codex-input'
    | 'codebuddy-deferred-input'
    | 'name'
    | 'claude-meta'
    | 'devin-meta'
    | 'devin-title'
    | 'antigravity-meta'
    | 'antigravity-title'
  readonly structuredIdentityPresent?: boolean
  readonly titleMatchesCurrentTool?: boolean
}
