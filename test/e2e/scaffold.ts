import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold } from '#host-scaffold'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
type NativeScaffoldOptions = NonNullable<Parameters<typeof launchWebScaffold>[0]>
type ToolExecutor = 'native' | 'ptc'

/** Names from the pinned Host's optional bundle inventory, resolved from its npm installation. */
export type OptionalBundle =
  | 'voice-input-bundle'
  | 'auto-review'
  | 'inspector-profile'
  | 'tool-worktree'
  | 'cot-translation-bundle'
  | 'terminal-bundle'
  | 'session-search'
  | 'session-titles-bundle'
  | 'badge-skill-bundle'
  | 'ralph-bundle'

function optionalBundleDirectory(bundle: OptionalBundle): string {
  const requireAdapter = createRequire(join(root, 'package.json'))
  const requireHost = createRequire(requireAdapter.resolve('@deepseek-ai/dsh/package.json'))
  const manifestPath = requireHost.resolve(`@deepseek-ai/dsh-experimental-${bundle}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string
    dsh?: { bundle?: { patch?: unknown } }
  }
  const adapter = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines: { dsh: string } }
  if (manifest.version !== adapter.engines.dsh || manifest.dsh?.bundle?.patch === undefined)
    throw new Error(`Optional bundle ${bundle} does not match the pinned published Host`)
  return dirname(manifestPath)
}

/** Install through real profile bundles so ConfigEditor owns writable configuration. */
export async function launchAdapterWorld({
  adapterDirectory = root,
  teams = false,
  timedAskUser,
  teamMembers,
  terminalShell,
  renderProbe = false,
  toolExecutor,
  replayFixture,
  replayProviders,
  replayProvidersOnly,
  optionalBundles = [],
  extraPatches = [],
}: {
  /** A frozen candidate package for before/after checks; does not replace shared lib/. */
  adapterDirectory?: string
  teams?: boolean
  timedAskUser?: { timeout: number }
  teamMembers?: number
  terminalShell?: { path: string; name: string; args: string[] }
  renderProbe?: boolean
  toolExecutor?: ToolExecutor
  /** Official catalog-only fixtures for zero-inference native UI checks. */
  replayFixture?: NativeScaffoldOptions['replayFixture']
  replayProviders?: NativeScaffoldOptions['replayProviders']
  replayProvidersOnly?: NativeScaffoldOptions['replayProvidersOnly']
  optionalBundles?: readonly OptionalBundle[]
  /** Fixture-owned Loader patches, appended after the real bundle layers. */
  extraPatches?: readonly string[]
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acp-e2e-install-'))
  try {
    if (renderProbe)
      execFileSync('pnpm', ['exec', 'tsdown', '--config', 'test/e2e/fixtures/render-probe/tsdown.config.ts'], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
    const packages = [
      { dir: adapterDirectory, enabled: true },
      ...(renderProbe ? [{ dir: join(root, 'test/e2e/fixtures/render-probe'), enabled: true }] : []),
      ...[...new Set(optionalBundles)].map((bundle) => ({ dir: optionalBundleDirectory(bundle), enabled: true })),
    ]
    const patches: string[] = []
    if (teams) patches.push('- id: agent-team\n  config:\n    defaultEnabled: true\n')
    if (teamMembers !== undefined)
      patches.push(`- id: subagent\n  config:\n    maxActiveSubagents: ${Math.max(1, teamMembers - 1)}\n`)
    if (terminalShell !== undefined)
      patches.push(`- id: terminal-controller\n  config:\n    shell: ${JSON.stringify(terminalShell)}\n`)
    patches.push(...extraPatches)
    const extraOverlayPath = join(directory, 'test.patch.yml')
    writeFileSync(extraOverlayPath, patches.length === 0 ? '[]\n' : patches.join('\n'))
    const host = await launchWebScaffold({
      profile: { packages },
      extraOverlayPath,
      ...(timedAskUser === undefined
        ? { agentPresets: { default: toolExecutor === 'ptc' ? 'ptc' : 'standard' } }
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
      ...(replayFixture === undefined ? {} : { replayFixture }),
      ...(replayProviders === undefined ? {} : { replayProviders }),
      ...(replayProvidersOnly === undefined ? {} : { replayProvidersOnly }),
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
