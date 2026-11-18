export type NativeForkIntent =
  | { readonly phase: 'creating' | 'abandoned' }
  | { readonly phase: 'created' | 'workspace-attach'; readonly child: string }

export interface NativeForkJournal {
  read(): NativeForkIntent | undefined
  write(intent: NativeForkIntent): void
  clear(): void
  /** Preserve an unknown creation separately before permitting an explicitly confirmed new attempt. */
  abandon(): void
}

export class NativeForkJournalError extends Error {
  override readonly name = 'NativeForkJournalError'

  constructor(cause: unknown) {
    super('ACP fork recovery journal is unavailable', { cause })
  }
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Recovery facts for one tab, Host Sidecar and exact fork request. They are never
 * authorization: every recovered child still passes the Host's resource and seed
 * checks. Unlike a viewing-store preference, failed persistence must stop dispatch.
 */
export function createNativeForkJournal(
  storage: () => Storage,
  scope: string,
  source: string,
  atSeq: number,
): NativeForkJournal {
  const key = `dsh.acp.native-fork.v1:${JSON.stringify([scope, source, atSeq])}`
  const checked = <T>(operation: (storage: Storage) => T): T => {
    try {
      return operation(storage())
    } catch (cause) {
      throw new NativeForkJournalError(cause)
    }
  }
  return {
    read: () =>
      checked((storage) => {
        const raw = storage.getItem(key)
        if (raw === null) return undefined
        const value: unknown = JSON.parse(raw)
        if (typeof value !== 'object' || value === null || !('phase' in value)) throw new Error('Invalid fork intent')
        if ((value.phase === 'creating' || value.phase === 'abandoned') && Object.keys(value).length === 1)
          return { phase: value.phase }
        if (
          (value.phase === 'created' || value.phase === 'workspace-attach') &&
          'child' in value &&
          typeof value.child === 'string' &&
          /^[A-Za-z0-9._-]{1,256}$/.test(value.child) &&
          Object.keys(value).length === 2
        )
          return { phase: value.phase, child: value.child }
        throw new Error('Invalid fork intent')
      }),
    write: (intent) =>
      checked((storage) => {
        const raw = JSON.stringify(intent)
        storage.setItem(key, raw)
        if (storage.getItem(key) !== raw) throw new Error('Fork intent was not retained')
      }),
    clear: () =>
      checked((storage) => {
        storage.removeItem(key)
        if (storage.getItem(key) !== null) throw new Error('Fork intent was not cleared')
      }),
    abandon: () =>
      checked((storage) => {
        const raw = storage.getItem(key)
        const intent: unknown = raw === null ? null : JSON.parse(raw)
        if (
          raw === null ||
          typeof intent !== 'object' ||
          intent === null ||
          !('phase' in intent) ||
          intent.phase !== 'creating' ||
          Object.keys(intent).length !== 1
        )
          throw new Error('Fork creation is no longer unknown')
        const archivedKey = `${key}:abandoned:${crypto.randomUUID()}`
        storage.setItem(archivedKey, raw)
        if (storage.getItem(archivedKey) !== raw) throw new Error('Unknown fork outcome was not retained')
        const abandoned = JSON.stringify({ phase: 'abandoned' })
        storage.setItem(key, abandoned)
        if (storage.getItem(key) !== abandoned) throw new Error('Fork abandonment was not retained')
      }),
  }
}
