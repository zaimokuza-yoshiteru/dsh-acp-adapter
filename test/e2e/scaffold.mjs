import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install the built adapter through the real Loader's package dependency closure. */
export async function launchAdapterWorld({ teams = false } = {}) {
  const install = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-install-'))
  try {
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'acp-e2e-profile', dependencies: { '@zaimokuza/dsh-acp-adapter': '*' } }))
    mkdirSync(join(install, 'node_modules/@zaimokuza'), { recursive: true })
    symlinkSync(root, join(install, 'node_modules/@zaimokuza/dsh-acp-adapter'), process.platform === 'win32' ? 'junction' : 'dir')
    let extraOverlayPath = join(root, 'cordis.patch.yml')
    const extraInstallAnchors = [join(install, 'package.json')]
    if (teams) {
      const upstream = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
      const layers = ['agent-team-profile', 'agent-team-web-profile'].map(name => join(upstream, 'packages/experimental', name))
      extraOverlayPath = join(install, 'teams.patch.yml')
      writeFileSync(extraOverlayPath, [join(root, 'cordis.patch.yml'), ...layers.map(path => join(path, 'cordis.patch.yml'))].map(path => readFileSync(path, 'utf8')).join('\n'))
      extraInstallAnchors.push(...layers.map(path => join(path, 'package.json')))
    }
    const host = await launchWebScaffold({ extraOverlayPath, extraInstallAnchors })
    return { ...host, async close() {
      try { await host.close() } finally { rmSync(install, { recursive: true, force: true }) }
    } }
  } catch (error) {
    rmSync(install, { recursive: true, force: true })
    throw error
  }
}
