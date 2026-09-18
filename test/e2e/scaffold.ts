import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install the built adapter through the real Loader's package dependency closure. */
export async function launchAdapterWorld({ teams = false, teamMembers, terminalShell }: { teams?: boolean; teamMembers?: number; terminalShell?: { path: string; name: string; args: string[] } } = {}) {
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
      writeFileSync(extraOverlayPath, [join(root, 'cordis.patch.yml'), ...layers.map(path => join(path, 'cordis.patch.yml'))].map(path => readFileSync(path, 'utf8')).join('\n') + (teamMembers === undefined ? '' : `\n- id: agent-team\n  config:\n    maxMembers: ${teamMembers}\n`))
      // Resolve native Teams from the selected host before the adapter's pinned
      // development dependencies, which may carry a different generated RPC ABI.
      extraInstallAnchors.unshift(...layers.map(path => join(path, 'package.json')))
    }
    if (terminalShell !== undefined) {
      const source = readFileSync(extraOverlayPath, 'utf8')
      extraOverlayPath = join(install, 'terminal.patch.yml')
      writeFileSync(extraOverlayPath, `${source}\n- id: terminal-controller\n  config:\n    shell: ${JSON.stringify(terminalShell)}\n`)
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

export type AdapterWorld = Awaited<ReturnType<typeof launchAdapterWorld>>
