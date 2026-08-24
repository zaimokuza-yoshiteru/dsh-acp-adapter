/**
 * The picker seat's composite store. Mechanism ruling:
 * `conversation.input.model` is a `kind: 'single'` slot — one entry declares
 * exactly one `store:` seat, so the picker's three data faces (model
 * directory / live options / capability disclosure) ride as SLICES of one
 * composite store, each with its own semantic transition set (the slice
 * modules own the per-slice write vocabulary; this table only routes drafts).
 * The registration passes the exclusive factory (`store:
 * createModelPickerStore`); the seat's inject factory receives the baked
 * actions as its second parameter and attaches the picker glue to them.
 * @module @zaimokuza/dsh-acp-adapter/client/stores/picker-store
 */

import { INITIAL_DIRECTORY_STATE } from '../selector-logic.ts'
import type {
  LiveOptionsSnapshot,
  ModelDirectoryState,
  PickerModelSelection,
  SessionModelsView,
} from '../selector-logic.ts'
import { defineSnapshotStore } from './engine.ts'
import type { ActionsDecl, BakedActions, StoreHandle } from './engine.ts'
import { directoryTransitions } from './directory-store.ts'
import { initialLiveOptionsState, liveTransitions } from './live-options-store.ts'
import type { LiveOptionsState } from './live-options-store.ts'
import { disclosureTransitions, initialDisclosureState } from './disclosure-store.ts'
import type { CapabilityDisclosureState } from './disclosure-store.ts'

/** The picker seat's composite state: three independently-transitioned slices. */
export interface ModelPickerState {
  directory: ModelDirectoryState
  live: LiveOptionsState
  disclosure: CapabilityDisclosureState
}

const initialPickerState = (): ModelPickerState => ({
  directory: { ...INITIAL_DIRECTORY_STATE },
  live: initialLiveOptionsState(),
  disclosure: initialDisclosureState(),
})

/** The composite write set: one action per slice transition, draft routed to the slice. */
const pickerActions = {
  /** Wholesale directory resync: the attach path replays the glue's authoritative slice in one publish. */
  directoryReplaced(draft: ModelPickerState, next: ModelDirectoryState): void {
    draft.directory = next
  },
  directoryLoadStarted(draft: ModelPickerState): void {
    directoryTransitions.loadStarted(draft.directory)
  },
  directoryLoaded(draft: ModelPickerState, view: SessionModelsView): void {
    directoryTransitions.loaded(draft.directory, view)
  },
  directoryLoadFailed(draft: ModelPickerState, message: string): void {
    directoryTransitions.loadFailed(draft.directory, message)
  },
  directorySelectStarted(draft: ModelPickerState): void {
    directoryTransitions.selectStarted(draft.directory)
  },
  directorySelected(draft: ModelPickerState, selection: PickerModelSelection): void {
    directoryTransitions.selected(draft.directory, selection)
  },
  directorySelectFailed(draft: ModelPickerState, message: string): void {
    directoryTransitions.selectFailed(draft.directory, message)
  },
  directoryReset(draft: ModelPickerState): void {
    directoryTransitions.reset(draft.directory)
  },
  /** Wholesale live resync: the attach path replays the glue's authoritative slice in one publish. */
  liveReplaced(draft: ModelPickerState, next: LiveOptionsState): void {
    draft.live = next
  },
  liveLoadStarted(draft: ModelPickerState): void {
    liveTransitions.loadStarted(draft.live)
  },
  liveLoaded(draft: ModelPickerState, snapshot: LiveOptionsSnapshot): void {
    liveTransitions.loaded(draft.live, snapshot)
  },
  liveLoadFailed(draft: ModelPickerState, message: string): void {
    liveTransitions.loadFailed(draft.live, message)
  },
  liveSwitchStarted(draft: ModelPickerState, configId: string, value: string | boolean): void {
    liveTransitions.switchStarted(draft.live, configId, value)
  },
  liveSwitchSettled(draft: ModelPickerState, snapshot: LiveOptionsSnapshot): void {
    liveTransitions.switchSettled(draft.live, snapshot)
  },
  liveSwitchFailed(draft: ModelPickerState, baseline: LiveOptionsSnapshot, message: string): void {
    liveTransitions.switchFailed(draft.live, baseline, message)
  },
  liveSwitchFinished(draft: ModelPickerState): void {
    liveTransitions.switchFinished(draft.live)
  },
  liveRebindStarted(draft: ModelPickerState): void {
    liveTransitions.rebindStarted(draft.live)
  },
  liveRebindSettled(draft: ModelPickerState, snapshot: LiveOptionsSnapshot): void {
    liveTransitions.rebindSettled(draft.live, snapshot)
  },
  liveRebindFailed(draft: ModelPickerState, message: string): void {
    liveTransitions.rebindFailed(draft.live, message)
  },
  liveReset(draft: ModelPickerState): void {
    liveTransitions.reset(draft.live)
  },
  disclosureUpdated(draft: ModelPickerState, provider: string, preset: string | undefined): void {
    disclosureTransitions.updated(draft.disclosure, provider, preset)
  },
} satisfies ActionsDecl<ModelPickerState>

/** Baked (draft-stripped) form the seat's inject factory hands to the glue. */
export type ModelPickerStoreActions = BakedActions<ModelPickerState, typeof pickerActions>

/** Slice-addressed views of the baked write set — each glue attaches only to its own slice's vocabulary. */
export type DirectoryStoreActions = Pick<
  ModelPickerStoreActions,
  | 'directoryReplaced'
  | 'directoryLoadStarted'
  | 'directoryLoaded'
  | 'directoryLoadFailed'
  | 'directorySelectStarted'
  | 'directorySelected'
  | 'directorySelectFailed'
  | 'directoryReset'
>
export type LiveStoreActions = Pick<
  ModelPickerStoreActions,
  | 'liveReplaced'
  | 'liveLoadStarted'
  | 'liveLoaded'
  | 'liveLoadFailed'
  | 'liveSwitchStarted'
  | 'liveSwitchSettled'
  | 'liveSwitchFailed'
  | 'liveSwitchFinished'
  | 'liveRebindStarted'
  | 'liveRebindSettled'
  | 'liveRebindFailed'
  | 'liveReset'
>
export type DisclosureStoreActions = Pick<ModelPickerStoreActions, 'disclosureUpdated'>

/**
 * The exclusive-factory registration currency of the picker's store seat.
 * @returns a fresh handle (one per entry — never share at module level).
 */
export function createModelPickerStore(): StoreHandle<ModelPickerState, typeof pickerActions> {
  return defineSnapshotStore({ init: initialPickerState, actions: pickerActions })
}
