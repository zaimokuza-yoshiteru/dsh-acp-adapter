#!/usr/bin/env node
/** Verify the installed development packages and the DSH peers their consumers actually load. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_SOURCE_VERSION } from './dsh-target.ts'

interface InstalledPackage {
  name: string
  version: string
  main?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const isDsh = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const readPackage = (directory: string): InstalledPackage =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

/** Check reachable instances from each consumer's real location, including its private peer resolution. */
export function verifyDevelopmentInstall(root: string, target: string): number {
  const installedRoot = realpathSync(join(root, 'node_modules'))
  const dev: Record<string, string> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies
  const visited = new Set<string>()
  function check(directory: string, name: string, version: string, consumer: string): void {
    const location = realpathSync(directory)
    if (!location.startsWith(installedRoot + sep))
      throw new Error(`${name} resolves outside installed dependencies: ${location}`)
    if (isDsh(name) && version !== target)
      throw new Error(`${consumer} declares ${name}@${version}, expected ${target}`)
    const manifest = readPackage(location)
    if (manifest.name !== name || manifest.version !== version)
      throw new Error(`${consumer} requires ${name}@${version}, resolved ${manifest.name}@${manifest.version}`)
    if (visited.has(location)) return
    visited.add(location)
    if (manifest.main && !existsSync(join(location, manifest.main)))
      throw new Error(`${name} is missing its published entry ${manifest.main}`)
    if (!isDsh(name)) return
    const require = createRequire(join(location, 'package.json'))
    const visit = (dependency: string, expected: string, optional: boolean) => {
      if (!isDsh(dependency)) return
      // Some packages don't export package.json. Use the consumer's Node search paths
      // to inspect the selected package itself without executing its entry point.
      for (const base of require.resolve.paths(dependency) ?? []) {
        const path = join(base, dependency)
        if (existsSync(join(path, 'package.json'))) return check(path, dependency, expected, name)
      }
      if (!optional) throw new Error(`${name} requires missing ${dependency}@${expected}`)
    }
    for (const [dependency, expected] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }))
      visit(dependency, expected, Object.hasOwn(manifest.optionalDependencies ?? {}, dependency))
    for (const [peer, expected] of Object.entries(manifest.peerDependencies ?? {}))
      visit(peer, expected, manifest.peerDependenciesMeta?.[peer]?.optional === true)
  }
  for (const [name, version] of Object.entries(dev)) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      throw new Error(`${name} must pin a published version: ${version}`)
    check(join(installedRoot, name), name, version, 'devDependencies')
  }
  return Object.keys(dev).length
}

if (import.meta.main) {
  const count = verifyDevelopmentInstall(dirname(dirname(fileURLToPath(import.meta.url))), DSH_SOURCE_VERSION)
  console.log(
    `Verified ${count} exact published development packages and their DSH dependency graph (DSH ${DSH_SOURCE_VERSION})`,
  )
}
