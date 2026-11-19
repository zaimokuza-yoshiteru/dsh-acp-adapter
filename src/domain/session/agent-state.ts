import type { AcpAgentConfigState } from '../../contract/remote.ts'

type ProbeResult = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly failureKind: string }

/** A successful handshake proves protocol readiness. Only an explicit auth_required response requests login. */
export function deriveAcpAgentState(hostCompatible: boolean, result: ProbeResult | undefined): AcpAgentConfigState {
  if (!hostCompatible) return 'incompatible'
  if (result === undefined) return 'saved-unverified'
  if (result.kind === 'error') return result.failureKind === 'auth_required' ? 'auth-required' : 'unavailable'
  return 'ready'
}
