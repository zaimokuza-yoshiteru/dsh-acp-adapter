/**
 * Internal picker slice carrying the current provider and DSH permission
 * preset. The historical name is retained for store compatibility, but this
 * state is no longer rendered as a permanent disclosure panel. It lets ACP
 * selection request the host's native Full Access confirmation when needed;
 * the plugin never writes the preset itself.
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
