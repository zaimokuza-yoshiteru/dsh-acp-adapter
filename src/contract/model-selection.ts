import type * as acp from '@agentclientprotocol/sdk'
import { ACP_CONFIG_IDENTIFIER_MAX, normalizeAcpConfigOptionKey } from './config-options.ts'

const ROUTE_PREFIX = 'dsh-acp:'
const DECLARED_PREFIX = `${ROUTE_PREFIX}model:`

/** An escaped route includes adapter framing around an otherwise bounded Agent value. */
export const ACP_MODEL_ROUTE_MAX = ACP_CONFIG_IDENTIFIER_MAX + DECLARED_PREFIX.length

/** Host routing identity for using the Agent's current configuration, never an ACP model value. */
export const ACP_CURRENT_CONFIG_MODEL_ID = `${ROUTE_PREFIX}current-config`

export type AcpModelSelection =
  { readonly kind: 'current-config' } | { readonly kind: 'declared-model'; readonly value: string }

/** A category enhances native model selection; absent or unknown categories remain generic controls. */
export function acpModelConfigOption(
  options: readonly acp.SessionConfigOption[] | undefined,
): Extract<acp.SessionConfigOption, { type: 'select' }> | undefined {
  return options?.find(
    (option): option is Extract<acp.SessionConfigOption, { type: 'select' }> =>
      option.type === 'select' && normalizeAcpConfigOptionKey(option.category ?? '') === 'model',
  )
}

/** Escape only the adapter's routing namespace, preserving existing ordinary model identities. */
export function acpDeclaredModelRoute(value: string): string {
  return value.startsWith(ROUTE_PREFIX) ? `${DECLARED_PREFIX}${value}` : value
}

export function isAcpCurrentConfigModel(model: string): boolean {
  return model === ACP_CURRENT_CONFIG_MODEL_ID
}

/** Decode the routing identity once; an Agent value equal to the current-config token stays a real value. */
export function acpModelSelection(model: string): AcpModelSelection {
  if (isAcpCurrentConfigModel(model)) return { kind: 'current-config' }
  const encoded = model.startsWith(DECLARED_PREFIX) ? model.slice(DECLARED_PREFIX.length) : undefined
  return {
    kind: 'declared-model',
    value: encoded !== undefined && encoded.startsWith(ROUTE_PREFIX) ? encoded : model,
  }
}

/** Keep protocol identifier bounds intact while admitting the adapter's route framing. */
export function isAcpModelRouteWithinBounds(model: string): boolean {
  if (model.length === 0 || model.length > ACP_MODEL_ROUTE_MAX) return false
  const selection = acpModelSelection(model)
  return selection.kind === 'current-config' || selection.value.length <= ACP_CONFIG_IDENTIFIER_MAX
}
