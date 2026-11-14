import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

const TEAM_ACTION_SLOT = 'conversation.session.header.actions'

/** Follow the native subagent catalog owner; a cached roster does not keep its UI alive. */
export function followNativeSubagentUi(
  slots: Pick<SlotCore, 'entries' | 'subscribe'>,
  mount: () => () => void,
): () => void {
  let stopped = false
  let owner: StoredEntry | undefined
  let unmount: (() => void) | undefined
  const reconcile = (): void => {
    if (stopped) return
    const next = slots.entries(TEAM_ACTION_SLOT).find((entry) => entry.options.id === 'subagent-catalog')
    if (next === owner) return
    owner = next
    const previous = unmount
    unmount = undefined
    previous?.()
    if (next !== undefined) unmount = mount()
  }
  const unsubscribe = slots.subscribe(TEAM_ACTION_SLOT, reconcile)
  try {
    reconcile()
  } catch (error) {
    unsubscribe()
    throw error
  }
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    owner = undefined
    const previous = unmount
    unmount = undefined
    previous?.()
  }
}
