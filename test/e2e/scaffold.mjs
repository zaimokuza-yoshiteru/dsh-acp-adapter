import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install the built adapter through the real Loader's package dependency closure. */
export async function launchAdapterWorld() {
  const install = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-install-'))
  try {
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'acp-e2e-profile', dependencies: { '@zaimokuza/dsh-acp-adapter': '*' } }))
    mkdirSync(join(install, 'node_modules/@zaimokuza'), { recursive: true })
    symlinkSync(root, join(install, 'node_modules/@zaimokuza/dsh-acp-adapter'), process.platform === 'win32' ? 'junction' : 'dir')
    const host = await launchWebScaffold({ extraOverlayPath: join(root, 'cordis.patch.yml'), extraInstallAnchors: [join(install, 'package.json')] })
    return { ...host, async close() {
      try { await host.close() } finally { rmSync(install, { recursive: true, force: true }) }
    } }
  } catch (error) {
    rmSync(install, { recursive: true, force: true })
    throw error
  }
}
