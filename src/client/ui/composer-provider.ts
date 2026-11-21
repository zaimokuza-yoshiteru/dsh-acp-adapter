import { useEffect, useState } from 'react'

export interface ComposerDefaultProvider {
  getDefaultProvider(): Promise<string | undefined>
  watchDefaultProvider(changed: () => void): () => void
}

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { readonly provider?: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

type SelectionProjection<T> = { readonly lastUsed?: T | null; readonly next?: T | null }

/** RC.5 publishes pending ?? lastUsed as next. Older snapshots may carry only lastUsed.
 * An explicit clear alongside history gives no confirmed account or Agent to address. */
export function composerSelection<T>(
  view: SelectionProjection<T> | null | undefined,
  fallback: T | undefined,
): T | undefined {
  if (view?.next === undefined) return view?.lastUsed ?? fallback
  return view.next ?? (view.lastUsed == null ? fallback : undefined)
}

export function selectedAgentProvider(value: unknown, fallbackProvider?: string): string | undefined {
  const view = typeof value === 'object' && value !== null ? (value as SelectionProjection<unknown>) : undefined
  return providerOf(composerSelection(view, { provider: fallbackProvider }))
}

export function useComposerDefault<T>(
  getDefault: () => Promise<T | undefined>,
  watchDefaultProvider: ComposerDefaultProvider['watchDefaultProvider'],
): T | undefined {
  const [defaultProvider, setDefaultProvider] = useState<T | undefined>()
  const [defaultGeneration, setDefaultGeneration] = useState(0)
  useEffect(
    () =>
      watchDefaultProvider(() => {
        setDefaultProvider(undefined)
        setDefaultGeneration((value) => value + 1)
      }),
    [watchDefaultProvider],
  )
  useEffect(() => {
    let active = true
    void getDefault()
      .then((provider) => {
        if (active) setDefaultProvider(provider)
      })
      .catch(() => {
        if (active) setDefaultProvider(undefined)
      })
    return () => {
      active = false
    }
  }, [getDefault, defaultGeneration])
  return defaultProvider
}
