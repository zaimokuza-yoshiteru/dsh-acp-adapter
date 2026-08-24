/**
 * Model directory slice of the picker seat store: the
 * `conversation.input.model` seat is a `kind: 'single'` slot — one entry
 * carries exactly one store seat, so the picker's three data faces ride as
 * slices of the composite picker store (picker-store.ts). This module owns
 * the directory slice's pure transitions; the composite actions table
 * delegates to them.
 *
 * The slice mirrors the built-in ModelDirectoryState (selector-logic.ts);
 * every transition is a draft mutator over the slice alone.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/directory-store
 */

import { INITIAL_DIRECTORY_STATE } from '../selector-logic.ts'
import type {
  ModelDirectoryState,
  PickerModelSelection,
  SessionModelsView,
} from '../selector-logic.ts'

/** The directory slice's complete write set (draft mutators over the slice). */
export const directoryTransitions = {
  /** A catalog load started; the last good groups/current ride through. */
  loadStarted(draft: ModelDirectoryState): void {
    draft.status = 'loading'
    draft.error = null
  },
  /** A load landed: adopt the host's view wholesale. */
  loaded(draft: ModelDirectoryState, view: SessionModelsView): void {
    draft.current = view.current
    draft.routable = view.routable
    draft.groups = view.groups
    draft.failures = view.failures
    draft.status = 'ready'
    draft.error = null
  },
  /** A load failed: keep the last good groups/current, surface the message. */
  loadFailed(draft: ModelDirectoryState, message: string): void {
    draft.status = 'error'
    draft.error = message
  },
  /** A selection submission started. */
  selectStarted(draft: ModelDirectoryState): void {
    draft.status = 'selecting'
    draft.error = null
  },
  /** The host accepted a selection: adopt it (already route-validated host-side). */
  selected(draft: ModelDirectoryState, selection: PickerModelSelection): void {
    draft.current = selection
    draft.routable = true
    draft.status = 'ready'
    draft.error = null
  },
  /** The host refused (or the wire failed): surface the message. */
  selectFailed(draft: ModelDirectoryState, message: string): void {
    draft.status = 'error'
    draft.error = message
  },
  /** Connection reset: drop the previous host generation's projection. */
  reset(draft: ModelDirectoryState): void {
    Object.assign(draft, INITIAL_DIRECTORY_STATE)
  },
}
