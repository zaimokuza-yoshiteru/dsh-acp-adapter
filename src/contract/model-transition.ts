/** DSH cannot compact the private context held by an external Agent.
 * Keep the recorded route usable and offer a new, independent session instead. */
export function requiresAcpModelSwitchExit(
  previous: { readonly provider: string; readonly model: string } | null | undefined,
  next: { readonly provider: string; readonly model: string },
  ownsProvider: (provider: string) => boolean,
): boolean {
  return (
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    ownsProvider(next.provider)
  )
}
