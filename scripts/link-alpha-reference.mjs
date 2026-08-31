#!/usr/bin/env node
/**
 * Link the locally built DSH Alpha packages into this plugin's development
 * node_modules. Alpha packages are not published to npm yet, so they must not
 * appear as file: dependencies in package.json or pnpm-lock.yaml.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedTag = 'dsh-v0.1.2-alpha.1'
const expectedVersion = '0.1.2-alpha.1'

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
  return `Usage: node scripts/link-alpha-reference.mjs [options]

Options:
  --host-root <path>  built DSH Alpha source root (default: DSH_UPSTREAM_CHECKOUT or ../reference/deepseek-harness)
  --check             verify links without changing node_modules
  -h, --help          show this help`
}

function packageNames() {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // Peer metadata describes the host boundary; these additional packages are
  // source/test-only imports used by gen:typert and the Alpha integration
  // fixtures. They are deliberately kept here rather than as unpublished
  // package.json devDependencies.
  const sourceOnly = [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-api-settings-controller',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-model-selection',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-typert-generator',
  ]
  return [...new Set([
    ...Object.keys(packageJson.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')),
    ...sourceOnly,
  ])].sort()
}

function findPackages(hostRoot) {
  const found = new Map()
  const visited = new Set()
  const visit = directory => {
    let real
    try { real = resolve(directory) } catch { return }
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.pnpm') continue
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        const packageFile = join(child, 'package.json')
        if (existsSync(packageFile)) {
          let manifest
          try { manifest = JSON.parse(readFileSync(packageFile, 'utf8')) } catch { manifest = undefined }
          if (typeof manifest?.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
            if (found.has(manifest.name)) throw new Error(`duplicate DSH package ${manifest.name}: ${found.get(manifest.name)} and ${child}`)
            found.set(manifest.name, child)
          }
        }
        visit(child)
      }
    }
  }
  visit(hostRoot)
  return found
}

function exactTag(hostRoot) {
  if (!existsSync(join(hostRoot, '.git'))) throw new Error(`Alpha reference is not a git checkout: ${hostRoot}`)
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
  if (tag !== expectedTag) throw new Error(`Alpha reference must be checked out at ${expectedTag}; found ${tag || 'detached/unmatched HEAD'}`)
  const packages = findPackages(args.hostRoot)
  const names = packageNames()
  const missing = names.filter(name => !packages.has(name))
  if (missing.length > 0) throw new Error(`Alpha reference is missing packages: ${missing.join(', ')}`)
  for (const name of names) {
    const source = packages.get(name)
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (manifest.version !== expectedVersion && name !== '@deepseek-ai/cordis') {
      throw new Error(`${name} is ${manifest.version}, expected ${expectedVersion}`)
    }
    const mainFile = typeof manifest.main === 'string' ? join(source, manifest.main) : undefined
    if (mainFile !== undefined && !existsSync(mainFile)) throw new Error(`${name} is not built: missing ${relative(source, mainFile)}; build the Alpha reference first`)
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
  console.log(`${args.check ? 'Verified' : 'Linked'} ${names.length} DSH Alpha packages from ${args.hostRoot} (${expectedTag})`)
}

main()
