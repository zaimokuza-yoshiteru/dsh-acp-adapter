import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install through real profile bundles so ConfigEditor owns writable configuration. */
export async function launchAdapterWorld({ teams = false, teamMembers, terminalShell }: { teams?: boolean; teamMembers?: number; terminalShell?: { path: string; name: string; args: string[] } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-install-'))
  try {
    const upstream = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
    const packages = [{ dir: root, enabled: true }, ...(teams
      ? ['agent-team-profile'].map(name => ({ dir: join(upstream, 'packages/experimental', name), enabled: true })) : [])]
    const patches: string[] = []
    if (teamMembers !== undefined) patches.push(`- id: agent-team\n  config:\n    maxMembers: ${teamMembers}\n`)
    if (terminalShell !== undefined) patches.push(`- id: terminal-controller\n  config:\n    shell: ${JSON.stringify(terminalShell)}\n`)
    const extraOverlayPath = join(directory, 'test.patch.yml')
    writeFileSync(extraOverlayPath, patches.length === 0 ? '[]\n' : patches.join('\n'))
    const host = await launchWebScaffold({ profile: { packages }, extraOverlayPath })
    return { ...host, async close() {
      try { await host.close() } finally { rmSync(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
export type AdapterWorld = Awaited<ReturnType<typeof launchAdapterWorld>>
