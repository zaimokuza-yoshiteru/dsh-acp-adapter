/** Locale-safe formatting for host/transport diagnostics shown by plugin UI. */

/** Translation function narrowed by each caller's own locale-key union. */
export type DiagnosticTranslate<K extends string> = (
  key: K,
  params?: Record<string, string | number>,
) => string

/** Stable references are safe to retain while locale-specific host prose is not. */
export function diagnosticReference(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  return message.match(/acperr-\d{8}T\d{6}Z-[0-9a-z]+-[0-9a-f]{6,16}\b/i)?.[0]
    ?? message.match(/\bACP_[A-Z0-9_]+\b/)?.[0]
}

/** Render an optional diagnostic reference as a locale-neutral suffix. */
export function diagnosticReferenceSuffix(message: string | undefined): string {
  const reference = diagnosticReference(message)
  return reference === undefined ? '' : ` (${reference})`
}

/**
 * Localize an operation failure without interpolating arbitrary host prose.
 * Agent-authored messages are not passed through this helper.
 */
export function localizedDiagnostic<K extends string>(
  t: DiagnosticTranslate<K>,
  key: K,
  rawMessage: string | undefined,
  params: Record<string, string | number> = {},
): string {
  return t(key, { ...params, reference: diagnosticReferenceSuffix(rawMessage) })
}
