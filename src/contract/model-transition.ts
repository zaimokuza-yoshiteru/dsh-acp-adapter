import { acpModelSelection, isAcpAgentManagedModel, isAcpModelRouteWithinBounds } from './model-selection.ts'

type ModelRoute = { readonly provider: string; readonly model: string }

/** Concrete targets can be confirmed on the existing ACP session; a legacy managed source can move to one. */
export function isAcpSessionModelSwitch(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  preset: unknown,
  canSwitchSessionModel = false,
): boolean {
  const ordinary = preset === 'standard' || preset === 'cordis' || preset === 'ptc' || preset === 'minimal'
  return (
    (preset === 'acp-adapter' || (ordinary && canSwitchSessionModel)) &&
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    isAcpModelRouteWithinBounds(previous.model) &&
    isAcpModelRouteWithinBounds(next.model) &&
    (acpModelSelection(previous.model).kind === 'declared-model' ||
      (canSwitchSessionModel && isAcpAgentManagedModel(previous.model))) &&
    acpModelSelection(next.model).kind === 'declared-model'
  )
}

export function requiresAcpModelSwitchExit(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  ownsProvider: (provider: string) => boolean,
  preset?: unknown,
  canSwitchSessionModel = false,
): boolean {
  return (
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    ownsProvider(next.provider) &&
    !isAcpSessionModelSwitch(previous, next, preset, canSwitchSessionModel)
  )
}
