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
type ToolsMode = NativeScaffoldOptions['toolsMode']

/** Names from the pinned Host's optional bundle inventory, resolved from its npm installation. */
export type OptionalBundle =
  | 'agent-team-profile'
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
  teams = false,
  timedAskUser,
  teamMembers,
  terminalShell,
  renderProbe = false,
  toolsMode,
  replayFixture,
  replayProviders,
  replayProvidersOnly,
  optionalBundles = [],
  extraPatches = [],
}: {
  teams?: boolean
  timedAskUser?: { timeout: number }
  teamMembers?: number
  terminalShell?: { path: string; name: string; args: string[] }
  renderProbe?: boolean
  toolsMode?: ToolsMode
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
    const upstream = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
    if (renderProbe)
      execFileSync('pnpm', ['exec', 'tsdown', '--config', 'test/e2e/fixtures/render-probe/tsdown.config.ts'], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
    const packages = [
      { dir: root, enabled: true },
      ...(renderProbe ? [{ dir: join(root, 'test/e2e/fixtures/render-probe'), enabled: true }] : []),
      ...(teams && !optionalBundles.includes('agent-team-profile')
        ? [{ dir: join(upstream, 'packages/experimental/agent-team-profile'), enabled: true }]
        : []),
      ...[...new Set(optionalBundles)].map((bundle) => ({ dir: optionalBundleDirectory(bundle), enabled: true })),
    ]
    const patches: string[] = []
    if (teamMembers !== undefined) patches.push(`- id: agent-team\n  config:\n    maxMembers: ${teamMembers}\n`)
    if (terminalShell !== undefined)
      patches.push(`- id: terminal-controller\n  config:\n    shell: ${JSON.stringify(terminalShell)}\n`)
    patches.push(...extraPatches)
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
      ...(toolsMode === undefined ? {} : { toolsMode }),
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
