import type { AcpAgentSessionOptionWrite, AcpAgentSessionSnapshotView } from './acp-remote.ts'

const pending = new Map<string, string>()
const listeners = new Set<() => void>()
export const firstTurnWriteTimeoutMs = 5_000

export function firstTurnIntentKey(sessionId: string, provider: string): string {
  return 'dsh-acp:first-turn:' + JSON.stringify([sessionId, provider])
}

/** A dropped reply may outlive this component. Store just the choice and its
 * expected Host revision in this tab; drafts and permissions remain Host-owned. */
export function readFirstTurnIntent(key: string | undefined): string | null {
  if (!key) return null
  try {
    return pending.get(key) ?? globalThis.sessionStorage?.getItem(key) ?? null
  } catch {
    return pending.get(key) ?? null
  }
}

function save(key: string, value: string | null): void {
  if (value === null) pending.delete(key)
  else pending.set(key, value)
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key)
    else globalThis.sessionStorage?.setItem(key, value)
  } catch {
    /* The in-memory guard still covers this page. */
  }
  for (const changed of listeners) changed()
}

export function subscribeFirstTurnIntent(changed: () => void): () => void {
  listeners.add(changed)
  return () => {
    listeners.delete(changed)
  }
}

export function beginFirstTurnIntent(key: string, revision: number, choice: AcpAgentSessionOptionWrite | null): string {
  const intent = JSON.stringify({ revision, choice })
  save(key, intent)
  return intent
}

export function finishFirstTurnIntent(key: string, intent: string): void {
  if (readFirstTurnIntent(key) === intent) save(key, null)
}

export function confirmsFirstTurnIntent(snapshot: AcpAgentSessionSnapshotView, intent: string): boolean {
  // The Host stops offering first-turn controls once another client has
  // already delivered the first message for this same Agent and session.
  if (
    !snapshot.preselection &&
    snapshot.freshness === 'live' &&
    snapshot.preselectionRevision === undefined &&
    !snapshot.preselected?.length
  )
    return true
  try {
    const { revision, choice } = JSON.parse(intent)
    if (
      typeof revision !== 'number' ||
      snapshot.preselectionRevision === undefined ||
      snapshot.preselectionRevision <= revision
    )
      return false
    if (choice === null) return !snapshot.preselected?.length
    return (
      snapshot.preselected?.some(
        (value) =>
          value.kind === choice.kind &&
          value.id === choice.id &&
          (value.kind === 'mode' || value.value === choice.value),
      ) === true
    )
  } catch {
    return false
  }
}

/** RC.5's composer block also disables editing. Fence only this conversation's
 * native primary click and editor submit gestures while a write is unconfirmed. */
export function guardFirstTurnSend(sessionId: string, key: string, nativeStopLabel: () => string): () => void {
  if (typeof document === 'undefined') return () => {}
  const check = (event: Event): void => {
    if (!(event.target instanceof Element) || !readFirstTurnIntent(key)) return
    const card = event.target.closest('[data-composer-card]')
    if (card?.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') !== sessionId) return
    if (event.type === 'click') {
      const button = event.target.closest('button[aria-busy]')
      // RC.5's only own busy button in this bar is its primary action.
      // Nested extension slots own their buttons. A running turn can also
      // put the native localized Stop action in this same primary button.
      if (
        button?.closest('[data-slot]')?.getAttribute('data-slot') !== 'conversation.composer.bar' ||
        button.getAttribute('aria-label') === nativeStopLabel()
      )
        return
    } else {
      if (!event.target.closest('[data-composer-input]')) return
      if (
        event instanceof KeyboardEvent &&
        (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229)
      )
        return
      if (event instanceof InputEvent && (event.inputType !== 'insertParagraph' || event.isComposing)) return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    card.querySelector<HTMLElement>('[data-acp-intent-pending] button')?.focus()
  }
  const abort = new AbortController()
  for (const type of ['click', 'keydown', 'beforeinput'])
    document.addEventListener(type, check, { capture: true, signal: abort.signal })
  return () => abort.abort()
}
