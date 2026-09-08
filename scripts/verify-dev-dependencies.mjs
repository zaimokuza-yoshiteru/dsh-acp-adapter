#!/usr/bin/env node
/** Verify that builds consume the exact published packages declared in the manifest. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_SOURCE_VERSION } from './dsh-target.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const [name, version] of Object.entries(pkg.devDependencies)) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${name} must pin a published version: ${version}`)
  if ((name.startsWith('@deepseek-ai/dsh-') || name === '@deepseek-ai/dsh') && version !== DSH_SOURCE_VERSION) throw new Error(`${name} must be ${DSH_SOURCE_VERSION}`)
  const directory = realpathSync(join(root, 'node_modules', ...name.split('/')))
  if (!directory.startsWith(join(root, 'node_modules') + sep)) throw new Error(`${name} resolves outside installed dependencies: ${directory}`)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== name || manifest.version !== version) throw new Error(`${name} expected ${version}, installed ${manifest.version}`)
  if (manifest.main && !existsSync(join(directory, manifest.main))) throw new Error(`${name} is missing its published entry ${manifest.main}`)
}
console.log(`Verified ${Object.keys(pkg.devDependencies).length} exact published development packages (DSH ${DSH_SOURCE_VERSION})`)
