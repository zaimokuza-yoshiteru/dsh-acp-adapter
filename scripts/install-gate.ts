#!/usr/bin/env node
/**
 * Clean-install smoke gate for the exact published DSH host (or source reference).
 *
 * By default the gate packs locally and installs that tarball; --spec exercises
 * a DSH-supported package source, and --update-spec verifies an in-profile
 * registry update. It uses a temporary DSH_HOME and isolated npm/pnpm config,
 * without touching the user's profile. The DSH profile's normal module fallback
 * resolves host bundles from the supplied installation. Plugin dependencies use
 * their published manifest without local overrides, with a temporary pnpm store
 * so a warm checkout cannot mask omissions.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_SOURCE_TAG } from './dsh-target.ts'

export interface InstallGateArgs {
  hostRoot: string
  tgz: string | undefined
  spec: string | undefined
  updateSpec: string | undefined
  skipBoot: boolean
  help: boolean
}

export interface AuthenticatedBootstrapResult {
  status: number
  body: string
}

export interface WaitForAuthenticatedBootstrapOptions {
  readOutput: () => string
  fetchImpl?: typeof fetch
  isAlive?: () => boolean
  timeoutMs?: number
  intervalMs?: number
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packageName = packageJson.name
const profileName = 'web'

export function parseArgs(argv: readonly string[]) {
  const result: InstallGateArgs = {
    hostRoot: resolve(root, 'node_modules', '@deepseek-ai', 'dsh'),
    tgz: undefined,
    spec: undefined,
    updateSpec: undefined,
    skipBoot: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--skip-boot') result.skipBoot = true
    else if (arg === '--host-root' || arg === '--tgz' || arg === '--spec' || arg === '--update-spec') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--host-root') result.hostRoot = resolve(value)
      else if (arg === '--tgz') result.tgz = resolve(value)
      else if (arg === '--spec') result.spec = value
      else result.updateSpec = value
    } else {
      throw new Error(`unknown option ${JSON.stringify(arg)} (use --help)`)
    }
  }
  if (result.tgz !== undefined && result.spec !== undefined) throw new Error('--tgz and --spec are mutually exclusive')
  if (result.updateSpec !== undefined && result.spec === undefined)
    throw new Error('--update-spec requires --spec to install the initial version first')
  return result
}

export function usage() {
  return `Usage: node scripts/install-gate.ts [options]

Options:
  --host-root <path>  installed DSH package or source root (default: node_modules/@deepseek-ai/dsh)
  --tgz <path>        Reuse an existing plugin tarball instead of packing
  --spec <spec>       Install a DSH-supported registry, Git, path, or tarball spec instead of packing
  --update-spec <spec> Update the package installed by --spec; currently accepts this package's npm version/tag spec
  --skip-boot         Install and inspect composition, but do not bind HTTP
  -h, --help          Show this help

The install uses a temporary DSH_HOME and pnpm store; registry access is required.`
}

function installedPluginManifest(dshHome: string) {
  const path = join(dshHome, 'profiles', profileName, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) fail(`installed package manifest not found at ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
}

async function updateSpecVersion(spec: string) {
  // The update gate is for this package's exact version or registry tag such as
  // @next. Resolve it from the public npm registry without consulting npmrc or
  // inferring the target version from what pnpm happened to install.
  if (!spec.startsWith(`${packageName}@`))
    fail(`--update-spec must target ${packageName} with a registry version or tag`)
  const requested = spec.slice(packageName.length + 1)
  if (requested.length === 0 || requested.includes('/'))
    fail(`--update-spec must use an exact version or simple npm tag for ${packageName}`)
  const encodedName = encodeURIComponent(packageName).replace(/^%40/iu, '@')
  const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) fail(`npm registry metadata lookup failed with HTTP ${response.status}`)
  const metadata = (await response.json()) as {
    name?: unknown
    'dist-tags'?: Record<string, unknown>
    versions?: Record<string, unknown>
  }
  if (metadata.name !== packageName) fail('npm registry metadata returned a different package name')
  const taggedVersion = metadata['dist-tags']?.[requested]
  const version =
    typeof taggedVersion === 'string'
      ? taggedVersion
      : metadata.versions?.[requested] === undefined
        ? undefined
        : requested
  if (version === undefined) fail(`npm registry did not resolve --update-spec ${spec}`)
  return version
}

function isGitSpec(spec: string) {
  return (
    /^(?:git\+|github:|git:\/\/|ssh:\/\/|git@)/iu.test(spec) ||
    /^https?:\/\/github\.com\//iu.test(spec) ||
    /\.git(?:#.*)?$/iu.test(spec)
  )
}

export function assertAcpConfigSentinel(dump: string) {
  const adapterRows = rowBlocks(dump).filter((block) => /^\s*- id: dsh-acp-adapter(?:\s|$)/m.test(block))
  if (adapterRows.length !== 1) fail(`expected one dsh-acp-adapter config row, found ${adapterRows.length}`)
  if (!/^\s*toolApprovalDefault:\s*ask\s*$/m.test(adapterRows[0]!))
    fail('ACP toolApprovalDefault sentinel was not preserved')
}

/**
 * Extract the authenticated loopback URL printed by `dsh web`.
 *
 * Keep this as a value-only helper: callers must never include the returned
 * URL in evidence or diagnostics because its query contains the bootstrap
 * credential.
 */
export function parseAuthenticatedStartupUrl(output: string) {
  const match = /\bdsh web:\s+(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\?[^\s)]+)/iu.exec(output)
  if (match === null) return undefined
  try {
    const url = new URL(match[1]!)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    const token = url.searchParams.get('token')
    return token === null || token.length === 0 ? undefined : url.toString()
  } catch {
    return undefined
  }
}

/** Remove credentials from child output before it can reach evidence/errors. */
export function redactGateOutput(value: string) {
  return value
    .replace(/([?&]token=)[^&#\s)]+/giu, '$1<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+|\bbearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
    .replace(/(set-cookie\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
}

export async function authenticatedBootstrap(launchUrl: string, fetchImpl = fetch) {
  const launchResponse = await fetchImpl(launchUrl, { redirect: 'manual' })
  const cookie = launchResponse.headers.get('set-cookie')?.split(';', 1)[0]
  if (launchResponse.status !== 303 || cookie === undefined || cookie.length === 0) {
    return { status: launchResponse.status, body: '' }
  }
  const origin = new URL(launchUrl).origin
  const response = await fetchImpl(`${origin}/`, { headers: { cookie } })
  return { status: response.status, body: await response.text() }
}

/** Wait for DSH's authenticated URL, retrying transient 401/bootstrap races. */
export async function waitForAuthenticatedBootstrap({
  readOutput,
  fetchImpl = fetch,
  isAlive = () => true,
  timeoutMs = 30_000,
  intervalMs = 250,
}: WaitForAuthenticatedBootstrapOptions) {
  const deadline = Date.now() + timeoutMs
  let lastStatus
  while (Date.now() < deadline) {
    const launchUrl = parseAuthenticatedStartupUrl(readOutput())
    if (launchUrl !== undefined) {
      try {
        const result = await authenticatedBootstrap(launchUrl, fetchImpl)
        lastStatus = result.status
        if (result.status === 200) return result
      } catch {
        // The server can accept the printed URL before its auth middleware is
        // ready. Retry without exposing the credential-bearing URL.
      }
    }
    if (!isAlive()) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }
  throw new Error(
    `clean DSH web boot did not become authenticated HTTP-ready${lastStatus === undefined ? '' : ` (last HTTP status ${String(lastStatus)})`}`,
  )
}

function fail(message: string): never {
  throw new Error(`[install-gate] ${message}`)
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) fail(`${command} ${args.join(' ')}: ${result.error.message}`)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-4000)
    fail(`${command} ${args.join(' ')} exited ${String(result.status)}${output === '' ? '' : `\n${output}`}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function packLocalTarball(tempRoot: string) {
  const before = new Set(readdirSync(tempRoot))
  run('pnpm', ['pack', '--pack-destination', tempRoot, '--silent'], { timeout: 120_000 })
  const candidates = readdirSync(tempRoot).filter((name) => name.endsWith('.tgz') && !before.has(name))
  if (candidates.length !== 1) fail(`expected one packed tarball, found ${candidates.join(', ') || '(none)'}`)
  return join(tempRoot, candidates[0]!)
}

function tarEntries(tgz: string) {
  const output = run('tar', ['-tzf', tgz], { timeout: 30_000 }).stdout
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, '').replaceAll('\\', '/'))
}

export function assertTarballEntries(entries: readonly string[]) {
  // The searchable selector is an opt-in occupant of DSH's public model seat.
  // The existing host-compat path ban still rejects the retired picker implementation.
  const forbidden = [/^(?:experiments|test|scripts)\//i, /(?:release-evidence|evidence)/i, /host-compat/i]
  for (const entry of entries) {
    if (forbidden.some((pattern) => pattern.test(entry)))
      fail(`tarball contains forbidden development/legacy path: ${entry}`)
  }
  for (const required of [
    'package.json',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/client.js',
    'README.md',
    'LICENSE',
  ]) {
    if (!entries.includes(required)) fail(`tarball is missing ${required}`)
  }
}

function rowBlocks(dump: string) {
  const lines = dump.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*- id: /.test(lines[index]!)) continue
    const block = [lines[index]!]
    for (let next = index + 1; next < lines.length && !/^\s*- id: /.test(lines[next]!); next += 1)
      block.push(lines[next]!)
    rows.push(block.join('\n'))
  }
  return rows
}

export function assertComposedDump(dump: string) {
  const rows = rowBlocks(dump)
  const row = (id: string) =>
    rows.filter((block) =>
      new RegExp(`^\\s*- id: ${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(block),
    )
  // `agent` is the model-facing service row; `agent-loop` is the stock
  // AgentLoop row.  Both exist in Alpha, and checking only `agent` would let
  // an accidental AgentLoop replacement pass this gate.
  for (const id of ['agent-loop', 'ui-model-selection']) {
    const matches = row(id)
    if (matches.length !== 1) fail(`composed dump must contain exactly one stock ${id} row; found ${matches.length}`)
    if (/^\s*disabled:\s*true\s*$/m.test(matches[0]!)) fail(`stock ${id} row is disabled`)
  }
  const pluginRows = row('dsh-acp-adapter')
  if (pluginRows.length !== 1)
    fail(`composed dump must contain exactly one additive dsh-acp-adapter row; found ${pluginRows.length}`)
  if (/^\s*disabled:\s*true\s*$/m.test(pluginRows[0]!)) fail('dsh-acp-adapter row is disabled')
  if (/^\s*- (?:disable|replace):/m.test(dump)) fail('plugin composition must not disable or replace stock rows')
}

function getFreePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a loopback port')))
        return
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)))
    })
  })
}

async function bootAndCheck(hostRoot: string, dshHome: string) {
  const bin = hostCli(hostRoot)
  if (!existsSync(bin)) fail(`DSH CLI not found at ${bin}; build the source reference first`)
  const port = await getFreePort()
  const child = spawn(process.execPath, [bin, '--profile', profileName, '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  try {
    const result = await waitForAuthenticatedBootstrap({
      readOutput: () => output,
      isAlive: () => child.exitCode === null,
      timeoutMs: 30_000,
      intervalMs: 250,
    })
    if (!result.body.includes('__DSH_BOOT__') && !result.body.includes('__ModuleLoader__')) {
      fail('clean DSH web boot returned 200 but no DSH client bootstrap marker')
    }
    return { status: result.status, output: redactGateOutput(output.slice(-4000)) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown boot error'
    fail(`${detail}\n${redactGateOutput(output.slice(-4000))}`)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit()
      else child.once('exit', resolveExit)
      setTimeout(resolveExit, 5_000)
    })
  }
}

function hostCli(hostRoot: string) {
  const manifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8'))
  if (manifest.version !== DSH_SOURCE_TAG.slice(5)) fail('host version does not match the accepted DSH tag')
  return manifest.name === '@deepseek-ai/dsh'
    ? join(hostRoot, 'lib', 'bin.js')
    : join(hostRoot, 'apps', 'cli', 'lib', 'bin.js')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!existsSync(hostCli(args.hostRoot))) fail(`host root is not a built DSH tree: ${args.hostRoot}`)
  const tempRoot = mkdtempSync(join(os.tmpdir(), 'dsh-acp-install-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const evidence = join(tempRoot, 'result.json')
  let keep = false
  try {
    const tgz = args.spec === undefined ? (args.tgz ?? packLocalTarball(tempRoot)) : undefined
    if (tgz !== undefined && !existsSync(tgz)) fail(`tarball does not exist: ${tgz}`)
    const entries = tgz === undefined ? undefined : tarEntries(tgz)
    if (entries !== undefined) assertTarballEntries(entries)
    const env = {
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      npm_config_store_dir: join(tempRoot, 'pnpm-store'),
      npm_config_userconfig: join(tempRoot, 'npm-user-empty.rc'),
      npm_config_globalconfig: join(tempRoot, 'npm-global-empty.rc'),
    }
    writeFileSync(env.npm_config_userconfig, '')
    writeFileSync(env.npm_config_globalconfig, '')
    const installSpec = args.spec ?? tgz!
    run(
      process.execPath,
      [
        hostCli(args.hostRoot),
        'plugin',
        '--profile',
        profileName,
        'add',
        installSpec,
        '--save-exact',
        ...(args.spec === undefined ? ['--ignore-scripts'] : []),
      ],
      { env, timeout: args.spec !== undefined && isGitSpec(args.spec) ? 10 * 60_000 : 120_000 },
    )
    const initialManifest = args.spec === undefined ? undefined : installedPluginManifest(dshHome)
    if (
      initialManifest !== undefined &&
      (initialManifest.name !== packageName || typeof initialManifest.version !== 'string')
    )
      fail('initial spec did not install the expected package manifest')
    if (args.updateSpec !== undefined) {
      writeFileSync(
        join(dshHome, 'profiles', profileName, 'cordis.patch.yml'),
        '- id: dsh-acp-adapter\n  config:\n    toolApprovalDefault: ask\n',
      )
    }
    const initialDump = run(process.execPath, [hostCli(args.hostRoot), '--profile', profileName, '--dump-config'], {
      env,
      timeout: 30_000,
    }).stdout
    assertComposedDump(initialDump)
    if (args.updateSpec !== undefined) assertAcpConfigSentinel(initialDump)

    let update: { expectedVersion: string; installedVersion: string } | undefined
    if (args.updateSpec !== undefined) {
      const expectedVersion = await updateSpecVersion(args.updateSpec)
      run(
        process.execPath,
        [hostCli(args.hostRoot), 'plugin', '--profile', profileName, 'add', args.updateSpec, '--save-exact'],
        { env, timeout: 120_000 },
      )
      const updatedManifest = installedPluginManifest(dshHome)
      if (updatedManifest.name !== packageName || updatedManifest.version !== expectedVersion)
        fail(`update resolved ${String(updatedManifest.version)}; expected ${expectedVersion}`)
      const profileManifest = JSON.parse(
        readFileSync(join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, unknown> }
      if (profileManifest.dependencies?.[packageName] !== expectedVersion)
        fail('updated profile dependency is not pinned to the resolved version')
      update = { expectedVersion, installedVersion: String(updatedManifest.version) }
      const updatedDump = run(process.execPath, [hostCli(args.hostRoot), '--profile', profileName, '--dump-config'], {
        env,
        timeout: 30_000,
      }).stdout
      assertComposedDump(updatedDump)
      assertAcpConfigSentinel(updatedDump)
      const withoutAdapter = (dump: string) =>
        rowBlocks(dump)
          .filter((block) => !/^\s*- id: dsh-acp-adapter(?:\s|$)/m.test(block))
          .sort()
      if (JSON.stringify(withoutAdapter(initialDump)) !== JSON.stringify(withoutAdapter(updatedDump)))
        fail('profile composition changed while updating the plugin')
    }
    let boot: { skipped: true } | { status: number; output: string } = { skipped: true }
    if (!args.skipBoot) boot = await bootAndCheck(args.hostRoot, dshHome)
    if (args.updateSpec !== undefined) writeFileSync(join(dshHome, 'profiles', profileName, 'cordis.patch.yml'), '[]\n')
    run(process.execPath, [hostCli(args.hostRoot), 'plugin', '--profile', profileName, 'remove', packageName], {
      env,
      timeout: 120_000,
    })
    const afterRemove = run(process.execPath, [hostCli(args.hostRoot), '--profile', profileName, '--dump-config'], {
      env,
      timeout: 30_000,
    }).stdout
    if (rowBlocks(afterRemove).some((block) => block.includes(`id: dsh-acp-adapter`)))
      fail('plugin row remains after removal')
    const profilePackage = JSON.parse(readFileSync(join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'))
    if (Object.hasOwn(profilePackage.dependencies ?? {}, packageName))
      fail('profile manifest retains plugin dependency after removal')
    if (existsSync(join(dshHome, 'profiles', profileName, 'node_modules', ...packageName.split('/'))))
      fail('profile node_modules retains plugin after removal')
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          packageName,
          sourceKind: args.spec === undefined ? 'tgz' : 'spec',
          ...(tgz === undefined ? {} : { tarball: basename(tgz) }),
          ...(entries === undefined ? {} : { files: entries.length }),
          ...(update === undefined ? {} : { update }),
          boot,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(
      `[install-gate] OK: ${entries?.length ?? 'source'} package; additive composition; removal clean${args.skipBoot ? '; boot skipped' : '; HTTP 200/client bootstrap'}`,
    )
    console.log(`[install-gate] evidence: ${evidence}`)
  } catch (error) {
    keep = true
    writeFileSync(
      evidence,
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n',
    )
    console.error(`[install-gate] evidence: ${evidence}`)
    throw error
  } finally {
    if (!keep && process.env.KEEP_INSTALL_GATE !== '1') rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
