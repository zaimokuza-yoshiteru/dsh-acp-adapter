/**
 * Capability disclosure slice of the picker seat store: the DSH
 * permission scope's read-only mirror (renamed from the former
 * `SessionPolicyState` — "policy" suggested gate semantics that deleted;
 * this face only ever DISCLOSES). `preset` comes from the permissions
 * projection (absent = undefined, the UI shows unknown honestly). This is a
 * DSH session attribute — the security boundary is enforced by the host
 * sandbox; this plugin never writes, blocks, or re-confirms it.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/disclosure-store
 */

/** The disclosure slice state: route provider + DSH permission preset id. */
export interface CapabilityDisclosureState {
  provider: string
  preset: string | undefined
}

/** Fresh pre-load slice value (provider unknown, preset unknown). */
export const initialDisclosureState = (): CapabilityDisclosureState => ({
  provider: '',
  preset: undefined,
})

/** The disclosure slice's complete write set. */
export const disclosureTransitions = {
  /** The PickerService's merged recompute (directory route + permissions projection) landed. */
  updated(draft: CapabilityDisclosureState, provider: string, preset: string | undefined): void {
    draft.provider = provider
    draft.preset = preset
  },
}
