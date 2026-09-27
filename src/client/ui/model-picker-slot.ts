import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelSelectInjected } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { AcpSettings } from '../data/logic.ts'
import { SearchableModelPicker } from './SearchableModelPicker.ts'

export interface PickerSettingsScope {
  getSnapshot(): { status: string; value?: AcpSettings | undefined }
  subscribe(listener: () => void): () => void
}

export interface ModelDirectoryResolverFace {
  directoryFor(sessionId: SessionId): {
    store: ModelSelectInjected['directory']
    load(): Promise<unknown>
    select: ModelSelectInjected['select']
  }
}

export interface ModelPickerSessionsFace {
  subagentAddress(sessionId: SessionId): unknown
}

export interface ModelPickerSlots {
  inject(name: 'conversation.input.model', factory: () => (() => void)): () => void
  register(options: {
    name: 'conversation.input.model'
    priority: -1
    locale: 'acpModelPicker'
    inject(sessionId: SessionId): ModelSelectInjected
  }, component: typeof SearchableModelPicker): () => void
}

/** Subscribe to the opt-in setting and shadow the native single seat only while enabled. */
export function installSearchableModelPickerSlot(
  slots: ModelPickerSlots,
  settings: PickerSettingsScope,
  directories: ModelDirectoryResolverFace,
  sessions: ModelPickerSessionsFace,
): () => void {
  return slots.inject('conversation.input.model', () => {
    let disposePicker: (() => void) | undefined
    const reconcile = (): void => {
      const snapshot = settings.getSnapshot()
      const enabled = snapshot.status === 'ready' && snapshot.value?.searchableModelPicker === true
      if (enabled && disposePicker === undefined) {
        disposePicker = slots.register({
          name: 'conversation.input.model',
          priority: -1,
          locale: 'acpModelPicker',
          inject: (sessionId) => {
            const directory = directories.directoryFor(sessionId)
            const available = sessions.subagentAddress(sessionId) === undefined
            return {
              available,
              directory: directory.store,
              load: () => { if (available) void directory.load().catch(() => { /* the shared store carries failures */ }) },
              select: (selection) => available ? directory.select(selection) : Promise.resolve(undefined),
            }
          },
        }, SearchableModelPicker)
      } else if (!enabled && disposePicker !== undefined) {
        disposePicker()
        disposePicker = undefined
      }
    }
    const unsubscribe = settings.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      disposePicker?.()
    }
  })
}
