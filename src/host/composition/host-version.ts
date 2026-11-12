import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'

export interface HostVersionMismatch {
  readonly adapter: string
  readonly required: string
  readonly running: string
}

/** Only an exact `engines.dsh` pin against a positively read Host version is a mismatch. */
export function hostVersionMismatch(
  manifest: { readonly version?: unknown; readonly engines?: { readonly dsh?: unknown } },
  running: unknown,
): HostVersionMismatch | undefined {
  const required = manifest.engines?.dsh
  if (typeof required !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(required)) return undefined
  if (typeof running !== 'string' || running.length === 0 || running === required) return undefined
  return { adapter: typeof manifest.version === 'string' ? manifest.version : 'unknown', required, running }
}

function readVersions(): HostVersionMismatch | undefined {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as object
  // A Host package this adapter already runs against; all DSH packages share one version.
  const host = createRequire(import.meta.url)('@deepseek-ai/dsh-tools/package.json') as { version?: unknown }
  return hostVersionMismatch(manifest, host.version)
}

/** Read current installed versions; unreadable metadata is not evidence of a mismatch. */
export function currentHostVersionMismatch(): HostVersionMismatch | undefined {
  try {
    return readVersions()
  } catch {
    return undefined
  }
}

/**
 * The Host lets a user exempt an incompatible plugin version. Name that
 * situation once at activation, so later failures are not read as defects.
 * Unreadable versions are not evidence of a mismatch.
 */
export function warnOnHostVersionMismatch(
  ctx: Context,
  read: () => HostVersionMismatch | undefined = currentHostVersionMismatch,
): void {
  let mismatch: HostVersionMismatch | undefined
  try {
    mismatch = read()
  } catch {
    return
  }
  if (mismatch === undefined) return
  ctx.logger.error(
    'dsh-acp-adapter %s is built for DSH %s but this Host runs DSH %s. ACP sessions and DSH tools may fail. Install the adapter version that matches this Host.',
    mismatch.adapter,
    mismatch.required,
    mismatch.running,
  )
}
