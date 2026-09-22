/** Import the former ACP settings section into this profile without replacing existing configuration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-config-editor'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { acpSettingsSchema, type AcpSettings } from './config.ts'

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Read either side of the native import's atomic rename; never modify its source or backup. */
export async function readLegacyAcpSettings(home: string): Promise<AcpSettings | undefined> {
  const text = await readOptional(join(home, 'settings.yaml'))
    ?? await readOptional(join(home, 'settings.yaml.imported'))
  if (text === undefined) return undefined
  const value: unknown = parse(text)
  if (value === null || typeof value !== 'object' || !('dsh-acp' in value)) return undefined
  return acpSettingsSchema(value['dsh-acp'])
}

/** Run after Loader settles so ConfigEditor can address the installed bundle entry. */
export function installLegacySettingsImport(ctx: Context): void {
  ctx.inject(['configEditor', 'profileContext'], child => {
    let disposed = false
    child.effect(() => () => { disposed = true })
    void child.root.loader.await().then(async () => {
      const entry = ctx.fiber.entry
      if (disposed || entry === undefined) return
      const identity = createHash('sha256').update(JSON.stringify([child.profileContext.dir, entry.options.id])).digest('hex')
      const directory = join(child.profileContext.home, 'dsh-acp', 'settings-imports')
      const marker = join(directory, `${identity}.json`)
      if (await readOptional(marker) !== undefined) return
      const legacy = await readLegacyAcpSettings(child.profileContext.home)
      if (disposed || legacy === undefined) return
      await child.configEditor.edit(entry, current => {
        if (disposed) throw new Error('ACP settings import cancelled during plugin disposal')
        // An explicit map (including an empty one) belongs to the current profile.
        return Object.hasOwn(current, 'agents') ? current : { ...current, agents: legacy.agents }
      })
      await mkdir(directory, { recursive: true })
      // The marker contains no configuration or credentials. A failed write is retried;
      // the now-explicit agents map makes a repeated import harmless.
      await writeFile(marker, '{"version":1}\n', { mode: 0o600 })
    }).catch(() => {
      // YAML validation errors can include credential values from the source.
      child.logger.error('ACP legacy settings import failed; the original settings file is preserved.')
    })
  })
}
