import { acpModelSelection, isAcpModelRouteWithinBounds } from './model-selection.ts'

type ModelRoute = { readonly provider: string; readonly model: string }

/** Only two explicit model choices can be confirmed against the live ACP session. */
export function isAcpPresetModelSwitch(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  preset: unknown,
): boolean {
  return (
    preset === 'acp-adapter' &&
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    isAcpModelRouteWithinBounds(previous.model) &&
    isAcpModelRouteWithinBounds(next.model) &&
    acpModelSelection(previous.model).kind === 'declared-model' &&
    acpModelSelection(next.model).kind === 'declared-model'
  )
}

/** Other presets keep the native compaction boundary and independent-session handoff. */
export function requiresAcpModelSwitchExit(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  ownsProvider: (provider: string) => boolean,
  preset?: unknown,
): boolean {
  return (
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    ownsProvider(next.provider) &&
    !isAcpPresetModelSwitch(previous, next, preset)
  )
}
