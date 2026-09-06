#!/usr/bin/env node
/**
 * Resolve the declared source development dependencies against the exact DSH tag.
 * The linked checkout owns its dependency tree; no older npm host is installed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_SOURCE_TAG, DSH_SOURCE_VERSION, DSH_SOURCE_LINK_PREFIX } from './dsh-target.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedTag = DSH_SOURCE_TAG
const expectedVersion = DSH_SOURCE_VERSION

function parseArgs(argv) {
  const result = { hostRoot: process.env.DSH_UPSTREAM_CHECKOUT || resolve(root, '..', 'reference', 'deepseek-harness'), check: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') result.check = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--host-root') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error('--host-root requires a path')
      result.hostRoot = resolve(value)
    } else throw new Error(`unknown option ${JSON.stringify(arg)}`)
  }
  return result
}

function usage() {
  return `Usage: node scripts/link-dsh-reference.mjs [options]

Options:
  --host-root <path>  built DSH source root (default: DSH_UPSTREAM_CHECKOUT or ../reference/deepseek-harness)
  --check             verify links without changing node_modules
  -h, --help          show this help`
}

function exactTag(hostRoot) {
  if (!existsSync(join(hostRoot, '.git'))) throw new Error(`DSH reference is not a git checkout: ${hostRoot}`)
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim()
  } catch { return '' }
}

function destination(name) {
  return join(root, 'node_modules', ...name.split('/'))
}

function isSameLink(path, source) {
  try { return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(source) } catch { return false }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(usage()); return }
  const tag = exactTag(args.hostRoot)
  if (tag !== expectedTag) throw new Error(`DSH reference must be checked out at ${expectedTag}; found ${tag || 'detached/unmatched HEAD'}`)
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entries = Object.entries(packageJson.devDependencies ?? {})
    .filter(([name, spec]) => name.startsWith('@deepseek-ai/') || spec.startsWith('link:'))
  for (const [name, spec] of entries) {
    if (!spec.startsWith(DSH_SOURCE_LINK_PREFIX)) {
      throw new Error(`${name} must declare its target DSH source with ${DSH_SOURCE_LINK_PREFIX}; found ${spec}`)
    }
    const source = resolve(args.hostRoot, spec.slice(DSH_SOURCE_LINK_PREFIX.length))
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error(`${spec} resolves to ${manifest.name}, expected ${name}`)
    const version = name.startsWith('@deepseek-ai/dsh-') ? expectedVersion : packageJson.peerDependencies?.[name]
    if (manifest.version !== version) {
      throw new Error(`${name} is ${manifest.version}, expected ${version}`)
    }
    const mainFile = typeof manifest.main === 'string' ? join(source, manifest.main) : undefined
    if (mainFile !== undefined && !existsSync(mainFile)) throw new Error(`${name} is not built: missing ${relative(source, mainFile)}; build the DSH reference first`)
    const target = destination(name)
    if (args.check) {
      if (!isSameLink(target, source)) throw new Error(`${name} is not linked to ${source}`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    if (!isSameLink(target, source)) {
      try { rmSync(target, { recursive: true, force: true }) } catch (error) { throw new Error(`cannot replace ${target}: ${error instanceof Error ? error.message : String(error)}`) }
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  console.log(`${args.check ? 'Verified' : 'Linked'} ${entries.length} host development packages from ${args.hostRoot} (${expectedTag})`)
}

main()
