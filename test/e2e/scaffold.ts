import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Install through real profile bundles so ConfigEditor owns writable configuration. */
export async function launchAdapterWorld({
  teams = false,
  schedule = false,
  timedAskUser,
  teamMembers,
  terminalShell,
}: {
  teams?: boolean
  schedule?: boolean
  timedAskUser?: { timeout: number }
  teamMembers?: number
  terminalShell?: { path: string; name: string; args: string[] }
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-install-'))
  try {
    const upstream = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
    const packages = [
      { dir: root, enabled: true },
      ...(teams ? [{ dir: join(upstream, 'packages/experimental/agent-team-profile'), enabled: true }] : []),
      ...(schedule ? [{ dir: join(upstream, 'packages/experimental/schedule-bundle'), enabled: true }] : []),
    ]
    const patches: string[] = []
    if (teamMembers !== undefined) patches.push(`- id: agent-team\n  config:\n    maxMembers: ${teamMembers}\n`)
    if (terminalShell !== undefined)
      patches.push(`- id: terminal-controller\n  config:\n    shell: ${JSON.stringify(terminalShell)}\n`)
    const extraOverlayPath = join(directory, 'test.patch.yml')
    writeFileSync(extraOverlayPath, patches.length === 0 ? '[]\n' : patches.join('\n'))
    const host = await launchWebScaffold({
      profile: { packages },
      extraOverlayPath,
      ...(timedAskUser === undefined
        ? {}
        : {
            agentPresets: {
              default: 'timed-ask-user',
              definitions: [
                {
                  id: 'timed-ask-user',
                  name: 'Timed ask user fixture',
                  plugins: [
                    {
                      id: 'tool-ask-user',
                      name: '@deepseek-ai/dsh-tool-ask-user',
                      config: { mode: 'timed', timeout: timedAskUser.timeout },
                    },
                  ],
                },
              ],
            },
          }),
    })
    return {
      ...host,
      async close() {
        try {
          await host.close()
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
export type AdapterWorld = Awaited<ReturnType<typeof launchAdapterWorld>>
