#!/usr/bin/env node
/**
 * Clean-install smoke gate for the DSH 0.1.2-alpha host.
 *
 * The gate deliberately uses a temporary DSH_HOME and a local package tarball.
 * It does not touch the user's profile, registry, or pnpm store.  The DSH
 * profile's normal module fallback resolves the host bundles from the checked
 * out Alpha source tree; plugin dependencies are installed with pnpm --offline
 * so a missing local cache is reported instead of silently downloading.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packageName = packageJson.name
const profileName = 'web'

export function parseArgs(argv) {
  const result = { hostRoot: resolve(root, '..', 'reference', 'deepseek-harness'), tgz: undefined, skipBoot: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--skip-boot') result.skipBoot = true
    else if (arg === '--host-root' || arg === '--tgz') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      if (arg === '--host-root') result.hostRoot = resolve(value)
      else result.tgz = resolve(value)
    } else {
      throw new Error(`unknown option ${JSON.stringify(arg)} (use --help)`)
    }
  }
  return result
}

export function usage() {
  return `Usage: node scripts/install-gate-alpha.mjs [options]

Options:
  --host-root <path>  DSH 0.1.2-alpha source root (default: ../reference/deepseek-harness)
  --tgz <path>        Reuse an existing plugin tarball instead of packing
  --skip-boot         Install and inspect composition, but do not bind HTTP
  -h, --help          Show this help

The install uses a temporary DSH_HOME and pnpm --offline.`
}

/**
 * Extract the authenticated loopback URL printed by `dsh web`.
 *
 * Keep this as a value-only helper: callers must never include the returned
 * URL in evidence or diagnostics because its query contains the bootstrap
 * credential.
 */
export function parseAuthenticatedStartupUrl(output) {
  const match = /\bdsh web:\s+(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\?[^\s)]+)/iu.exec(output)
  if (match === null) return undefined
  try {
    const url = new URL(match[1])
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined
    const token = url.searchParams.get('token')
    return token === null || token.length === 0 ? undefined : url.toString()
  } catch {
    return undefined
  }
}

/** Remove credentials from child output before it can reach evidence/errors. */
export function redactGateOutput(value) {
  return value
    .replace(/([?&]token=)[^&#\s)]+/giu, '$1<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+|\bbearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
    .replace(/(set-cookie\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
}

export async function authenticatedBootstrap(launchUrl, fetchImpl = fetch) {
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
}) {
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
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
  }
  throw new Error(`clean Alpha web boot did not become authenticated HTTP-ready${lastStatus === undefined ? '' : ` (last HTTP status ${String(lastStatus)})`}`)
}

function fail(message) {
  throw new Error(`[install-gate-alpha] ${message}`)
}

function run(command, args, options = {}) {
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

function packLocalTarball(tempRoot) {
  const before = new Set(readdirSync(tempRoot))
  run('pnpm', ['pack', '--pack-destination', tempRoot, '--silent'], { timeout: 120_000 })
  const candidates = readdirSync(tempRoot).filter(name => name.endsWith('.tgz') && !before.has(name))
  if (candidates.length !== 1) fail(`expected one packed tarball, found ${candidates.join(', ') || '(none)'}`)
  return join(tempRoot, candidates[0])
}

/**
 * Make the offline gate independent of a registry cache.  A published plugin
 * still declares normal npm dependencies; for this local gate we seed those
 * two runtime packages from this checkout and add pnpm overrides in the
 * temporary profile only.  DSH's own bundles continue to resolve through its
 * built-source module fallback.
 */
function seedLocalDependencies(hostRoot, dshHome, env) {
  const dependencies = Object.keys(packageJson.dependencies ?? {})
  if (dependencies.length === 0) return
  const localPaths = dependencies.map(name => {
    const candidate = join(root, 'node_modules', ...name.split('/'))
    if (!existsSync(join(candidate, 'package.json'))) fail(`local runtime dependency is unavailable: ${candidate}`)
    return candidate
  })
  const bin = join(hostRoot, 'apps', 'cli', 'lib', 'bin.js')
  run(process.execPath, [bin, 'plugin', '--profile', profileName, 'add', ...localPaths, '--save-exact', '--ignore-scripts', '--offline'], { env, timeout: 120_000 })
  const manifestPath = join(dshHome, 'profiles', profileName, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const overrides = Object.fromEntries(dependencies.map(name => [name, `file:${join(root, 'node_modules', ...name.split('/'))}`]))
  manifest.pnpm = { ...(manifest.pnpm ?? {}), overrides: { ...(manifest.pnpm?.overrides ?? {}), ...overrides } }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

function tarEntries(tgz) {
  const output = run('tar', ['-tzf', tgz], { timeout: 30_000 }).stdout
  return output.split(/\r?\n/).filter(Boolean).map(entry => entry.replace(/^package\//, '').replaceAll('\\', '/'))
}

export function assertTarballEntries(entries) {
  const forbidden = [/^(?:experiments|test|scripts)\//i, /(?:release-evidence|evidence)/i, /(?:host-compat|model-picker)/i]
  for (const entry of entries) {
    if (forbidden.some(pattern => pattern.test(entry))) fail(`tarball contains forbidden development/legacy path: ${entry}`)
  }
  for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'LICENSE']) {
    if (!entries.includes(required)) fail(`tarball is missing ${required}`)
  }
}

function rowBlocks(dump) {
  const lines = dump.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*- id: /.test(lines[index])) continue
    const block = [lines[index]]
    for (let next = index + 1; next < lines.length && !/^\s*- id: /.test(lines[next]); next += 1) block.push(lines[next])
    rows.push(block.join('\n'))
  }
  return rows
}

export function assertComposedDump(dump) {
  const rows = rowBlocks(dump)
  const row = id => rows.filter(block => new RegExp(`^\\s*- id: ${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(block))
  // `agent` is the model-facing service row; `agent-loop` is the stock
  // AgentLoop row.  Both exist in Alpha, and checking only `agent` would let
  // an accidental AgentLoop replacement pass this gate.
  for (const id of ['agent-loop', 'ui-model-selection']) {
    const matches = row(id)
    if (matches.length !== 1) fail(`composed dump must contain exactly one stock ${id} row; found ${matches.length}`)
    if (/^\s*disabled:\s*true\s*$/m.test(matches[0])) fail(`stock ${id} row is disabled`)
  }
  const pluginRows = row('dsh-acp-adapter')
  if (pluginRows.length !== 1) fail(`composed dump must contain exactly one additive dsh-acp-adapter row; found ${pluginRows.length}`)
  if (/^\s*disabled:\s*true\s*$/m.test(pluginRows[0])) fail('dsh-acp-adapter row is disabled')
  if (/^\s*- (?:disable|replace):/m.test(dump)) fail('plugin composition must not disable or replace stock rows')
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a loopback port')))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function bootAndCheck(hostRoot, dshHome) {
  const bin = join(hostRoot, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(bin)) fail(`Alpha CLI not found at ${bin}; build reference/deepseek-harness first`)
  const port = await getFreePort()
  const child = spawn(process.execPath, [bin, '--profile', profileName, '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  try {
    const result = await waitForAuthenticatedBootstrap({
      readOutput: () => output,
      isAlive: () => child.exitCode === null,
      timeoutMs: 30_000,
      intervalMs: 250,
    })
    if (!result.body.includes('__DSH_BOOT__') && !result.body.includes('__ModuleLoader__')) {
      fail('clean Alpha web boot returned 200 but no DSH client bootstrap marker')
    }
    return { status: result.status, output: redactGateOutput(output.slice(-4000)) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown boot error'
    fail(`${detail}\n${redactGateOutput(output.slice(-4000))}`)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else child.once('exit', resolveExit)
      setTimeout(resolveExit, 5_000)
    })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!existsSync(join(args.hostRoot, 'apps', 'cli', 'lib', 'bin.js'))) fail(`host root is not a built Alpha tree: ${args.hostRoot}`)
  const tempRoot = mkdtempSync(join(os.tmpdir(), 'dsh-acp-alpha-install-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const evidence = join(tempRoot, 'result.json')
  let keep = false
  try {
    const tgz = args.tgz ?? packLocalTarball(tempRoot)
    if (!existsSync(tgz)) fail(`tarball does not exist: ${tgz}`)
    const entries = tarEntries(tgz)
    assertTarballEntries(entries)
    const env = { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' }
    // Seed only the plugin's local runtime dependencies.  This keeps the
    // clean gate deterministic while leaving the host installation/fallback
    // path exactly as DSH defines it.
    seedLocalDependencies(args.hostRoot, dshHome, env)
    run(process.execPath, [join(args.hostRoot, 'apps', 'cli', 'lib', 'bin.js'), 'plugin', '--profile', profileName, 'add', tgz, '--save-exact', '--ignore-scripts', '--offline'], { env, timeout: 120_000 })
    const dump = run(process.execPath, [join(args.hostRoot, 'apps', 'cli', 'lib', 'bin.js'), '--profile', profileName, '--dump-config'], { env, timeout: 30_000 }).stdout
    assertComposedDump(dump)
    let boot = { skipped: true }
    if (!args.skipBoot) boot = await bootAndCheck(args.hostRoot, dshHome)
    run(process.execPath, [join(args.hostRoot, 'apps', 'cli', 'lib', 'bin.js'), 'plugin', '--profile', profileName, 'remove', packageName], { env, timeout: 120_000 })
    const afterRemove = run(process.execPath, [join(args.hostRoot, 'apps', 'cli', 'lib', 'bin.js'), '--profile', profileName, '--dump-config'], { env, timeout: 30_000 }).stdout
    if (rowBlocks(afterRemove).some(block => block.includes(`id: dsh-acp-adapter`))) fail('plugin row remains after removal')
    const profilePackage = JSON.parse(readFileSync(join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'))
    if (Object.hasOwn(profilePackage.dependencies ?? {}, packageName)) fail('profile manifest retains plugin dependency after removal')
    if (existsSync(join(dshHome, 'profiles', profileName, 'node_modules', ...packageName.split('/')))) fail('profile node_modules retains plugin after removal')
    writeFileSync(evidence, JSON.stringify({ packageName, tarball: basename(tgz), files: entries.length, boot }, null, 2) + '\n')
    console.log(`[install-gate-alpha] OK: ${entries.length} tarball files; additive composition; removal clean${args.skipBoot ? '; boot skipped' : '; HTTP 200/client bootstrap'}`)
    console.log(`[install-gate-alpha] evidence: ${evidence}`)
  } catch (error) {
    keep = true
    writeFileSync(evidence, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n')
    console.error(`[install-gate-alpha] evidence: ${evidence}`)
    throw error
  } finally {
    if (!keep && process.env.KEEP_INSTALL_GATE !== '1') rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
