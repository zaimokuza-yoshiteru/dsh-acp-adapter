import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** The Host can localize literal ACP labels when the user has set a DSH language. */
export function hostLocale(ctx: Context | undefined): string | undefined {
  try {
    const value = ctx
      ?.get('settings', false)
      ?.describe({ redactSecrets: true })
      .find((row) => row.ns === 'locale')?.value
    return value !== null && typeof value === 'object' && 'preference' in value && typeof value.preference === 'string'
      ? value.preference
      : undefined
  } catch {
    // Optional presentation services can be disposing during a catalog read.
    return undefined
  }
}
