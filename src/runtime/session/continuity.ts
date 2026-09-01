/** Host-visible ACP session continuity state. */
export type AcpSessionContinuityState =
  | { readonly status: 'ok'; readonly cause: null; readonly detail: null }
  | { readonly status: 'blocked'; readonly cause: string; readonly detail: string | null }
