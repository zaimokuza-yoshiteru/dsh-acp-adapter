/**
 * Internal picker slice carrying the current backend route and DSH access
 * preset. PickerService uses it to detect a downgraded ACP session and restore
 * Native Agent Access.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/backend-access-store
 */

/** The backend access state: route provider + DSH permission preset id. */
export interface BackendAccessState {
  provider: string
  preset: string | undefined
}

/** Fresh pre-load value (provider unknown, preset unknown). */
export const initialBackendAccessState = (): BackendAccessState => ({
  provider: '',
  preset: undefined,
})

/** The backend access slice's complete write set. */
export const backendAccessTransitions = {
  /** PickerService's merged route/preset recompute landed. */
  updated(draft: BackendAccessState, provider: string, preset: string | undefined): void {
    draft.provider = provider
    draft.preset = preset
  },
}
